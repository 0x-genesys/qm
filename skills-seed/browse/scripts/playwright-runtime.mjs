import { createHash } from "node:crypto";
import { readdir, mkdtemp, readFile, mkdir, rename, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const VERSION = "1.64.0";
const ARCHIVE_HASH = "T9r+MZkTECl2+oUcZ26YgZzTrYidTsIhYYkJix+6iDOymOb1FB2RLLSOxRGnZGv5DStt+aduIVbt+E8WygXYpg==";
const RUNTIME_HASH = "7b3786180275320960b5a8bae7ea3bf1298a4d454e6c6a179e0a91d66da60527";
let pending;
export function ensurePlaywright() {
  if (!pending)
    pending = load().catch((error) => {
      pending = undefined;
      throw error;
    });
  return pending;
}
async function runtimeFiles(root, relative = "") {
  const paths = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...(await runtimeFiles(root, path)));
    else if (entry.isFile()) paths.push(path);
    else throw new Error("Playwright runtime contains an unexpected file type");
  }
  return paths;
}
async function validCache(cache) {
  try {
    const digest = createHash("sha256");
    for (const path of (await runtimeFiles(cache)).sort()) {
      digest.update(path + "\0");
      digest.update(await readFile(join(cache, path)));
      digest.update("\0");
    }
    if (digest.digest("hex") !== RUNTIME_HASH)
      throw new Error(`Playwright runtime cache integrity mismatch; remove ${cache} and retry`);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
}
async function load() {
  const root = process.env.QM_BROWSE_CACHE || join(homedir(), ".cache", "qm-browse");
  const cache = join(root, `playwright-core-${VERSION}`);
  if (await validCache(cache)) return join(cache, "index.mjs");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, ".playwright-download-"));
  try {
    const response = await fetch(`https://registry.npmjs.org/playwright-core/-/playwright-core-${VERSION}.tgz`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Playwright runtime download failed: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (createHash("sha512").update(archive).digest("base64") !== ARCHIVE_HASH)
      throw new Error("Playwright runtime archive integrity mismatch");
    const archivePath = join(dir, "package.tgz");
    await writeFile(archivePath, archive);
    await promisify(execFile)("tar", ["-xzf", archivePath, "-C", dir], { timeout: 30000 });
    const unpacked = join(dir, "package");
    if (!(await validCache(unpacked))) throw new Error("Playwright runtime extraction failed");
    try {
      await rename(unpacked, cache);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code) || !(await validCache(cache))) throw error;
    }
    return join(cache, "index.mjs");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
