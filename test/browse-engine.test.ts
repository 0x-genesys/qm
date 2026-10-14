import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { loadInjectedSource } = await import(
  new URL("../skills-seed/browse/scripts/injected-engine.mjs", import.meta.url).href
);

test("injected engine rejects corrupt cache and unverified upstream bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browse-engine-test-"));
  const previousCache = process.env.QM_BROWSE_CACHE;
  const previousFetch = globalThis.fetch;
  process.env.QM_BROWSE_CACHE = dir;
  const cache = join(dir, "playwright-injected-1.64.0");
  await mkdir(cache);
  await writeFile(join(cache, "injected-source.js"), "untrusted-cache");
  let downloads = 0;
  globalThis.fetch = async () => {
    downloads++;
    return new Response("untrusted-upstream", { status: 200 });
  };
  try {
    await assert.rejects(loadInjectedSource(), /archive integrity mismatch/);
    assert.equal(downloads, 1);
    assert.equal(await readFile(join(cache, "injected-source.js"), "utf8"), "untrusted-cache");
    globalThis.fetch = async () => new Response("temporarily unavailable", { status: 503 });
    await assert.rejects(loadInjectedSource(), /HTTP 503/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousCache === undefined) delete process.env.QM_BROWSE_CACHE;
    else process.env.QM_BROWSE_CACHE = previousCache;
    await rm(dir, { recursive: true, force: true });
  }
});
