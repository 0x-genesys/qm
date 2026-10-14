import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { ensurePlaywright } = await import(
  new URL("../skills-seed/browse/scripts/playwright-runtime.mjs", import.meta.url).href
);

test("runtime refuses a corrupted cache before downloading or executing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browse-engine-test-"));
  const previousCache = process.env.QM_BROWSE_CACHE;
  const previousFetch = globalThis.fetch;
  process.env.QM_BROWSE_CACHE = dir;
  const cache = join(dir, "playwright-core-1.64.0");
  await mkdir(cache);
  await writeFile(join(cache, "index.mjs"), "throw new Error('must not execute');");
  let downloads = 0;
  globalThis.fetch = async () => {
    downloads++;
    throw new Error("must not download over corrupted cache");
  };
  try {
    await assert.rejects(ensurePlaywright(), /cache integrity mismatch; remove/);
    assert.equal(downloads, 0);
    assert.equal(await readFile(join(cache, "index.mjs"), "utf8"), "throw new Error('must not execute');");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousCache === undefined) delete process.env.QM_BROWSE_CACHE;
    else process.env.QM_BROWSE_CACHE = previousCache;
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime rejects unverified upstream bytes and preserves download errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browse-engine-test-"));
  const previousCache = process.env.QM_BROWSE_CACHE;
  const previousFetch = globalThis.fetch;
  process.env.QM_BROWSE_CACHE = dir;
  try {
    globalThis.fetch = async () => new Response("untrusted-upstream", { status: 200 });
    await assert.rejects(ensurePlaywright(), /archive integrity mismatch/);
    globalThis.fetch = async () => new Response("temporarily unavailable", { status: 503 });
    await assert.rejects(ensurePlaywright(), /HTTP 503/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousCache === undefined) delete process.env.QM_BROWSE_CACHE;
    else process.env.QM_BROWSE_CACHE = previousCache;
    await rm(dir, { recursive: true, force: true });
  }
});
