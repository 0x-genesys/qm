import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, mkdir, rename, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
const VERSION = "1.64.0";
const ARCHIVE_HASH = "T9r+MZkTECl2+oUcZ26YgZzTrYidTsIhYYkJix+6iDOymOb1FB2RLLSOxRGnZGv5DStt+aduIVbt+E8WygXYpg==";
const SOURCE_HASH = "852e40f938e72e6129b6c9a8bde3f4cc6cfe5cecb5ac734b6b06c8ad1fde42bf";
const NOTICES = ["LICENSE", "NOTICE", "ThirdPartyNotices.txt"];
const hash = (source) => createHash("sha256").update(source).digest("hex");
let pending;
export function loadInjectedSource() {
  if (!pending)
    pending = load().catch((error) => {
      pending = undefined;
      throw error;
    });
  return pending;
}
async function load() {
  const root = process.env.QM_BROWSE_CACHE || join(homedir(), ".cache", "qm-browse");
  const cache = join(root, `playwright-injected-${VERSION}`);
  const sourcePath = join(cache, "injected-source.js");
  try {
    const source = await readFile(sourcePath, "utf8");
    if (hash(source) === SOURCE_HASH) {
      await Promise.all(NOTICES.map((name) => access(join(cache, name))));
      return source;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, ".injected-download-"));
  try {
    const response = await fetch(`https://registry.npmjs.org/playwright-core/-/playwright-core-${VERSION}.tgz`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Injected engine download failed: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (createHash("sha512").update(archive).digest("base64") !== ARCHIVE_HASH)
      throw new Error("Injected engine archive integrity mismatch");
    await writeFile(join(dir, "package.tgz"), archive);
    await promisify(execFile)(
      "tar",
      [
        "-xzf",
        join(dir, "package.tgz"),
        "-C",
        dir,
        "package/lib/coreBundle.js",
        ...NOTICES.map((name) => `package/${name}`),
      ],
      { timeout: 30000 },
    );
    const bundle = await readFile(join(dir, "package/lib/coreBundle.js"), "utf8");
    const section = bundle.split("// packages/playwright-core/src/generated/injectedScriptSource.ts\n")[1]?.split("\n");
    const literal = section
      ?.find((line) => /^\s*source\d* = '/.test(line))
      ?.trim()
      .replace(/^source\d* = /, "")
      .replace(/;$/, "");
    if (!literal) throw new Error("Upstream injected source layout changed");
    const source = runInNewContext(literal, Object.create(null), { timeout: 1000 });
    if (typeof source !== "string" || hash(source) !== SOURCE_HASH)
      throw new Error("Injected engine source integrity mismatch");
    for (const name of NOTICES) await rename(join(dir, "package", name), join(cache, name));
    await writeFile(join(dir, "injected-source.js"), source);
    await rename(join(dir, "injected-source.js"), sourcePath);
    return source;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
