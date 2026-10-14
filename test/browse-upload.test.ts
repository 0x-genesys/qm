import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, utimes, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const scripts = new URL("../skills-seed/browse/scripts/", import.meta.url);
const { installBrowserUploads } = await import(new URL("browser-upload.mjs", scripts).href);
const endpoint = process.env.BROWSE_TEST_CDP;

function fixtureBrowser() {
  const listeners = new Set<any>();
  const server = { _crPages: new Map(), instrumentation: { addListener: (listener: any) => listeners.add(listener), removeListener: (listener: any) => listeners.delete(listener) } };
  const events = new Map();
  return { server, listeners, browser: { _connection: { toImpl: () => server }, once: (event: any, listener: any) => events.set(event, listener), off: (event: any) => events.delete(event) } };
}

test("upload adapter rejects unpinned runtimes before touching browser internals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "upload-version-"));
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: "1.63.0" }));
    await assert.rejects(installBrowserUploads({}, join(dir, "index.mjs")), /Playwright 1.64.0/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("upload adapter restores instance methods and leaves other browsers alone", async () => {
  const { ensurePlaywright } = await import(new URL("playwright-runtime.mjs", scripts).href);
  const modulePath = await ensurePlaywright();
  const fixture = fixtureBrowser();
  const original = async () => "native";
  const owned = { attribution: { browser: fixture.server }, setInputFiles: original };
  const unrelated = { attribution: { browser: {} }, setInputFiles: original };
  const dispose = await installBrowserUploads(fixture.browser, modulePath);
  const progress = { metadata: { method: "setInputFiles" }, race: (promise: any) => promise };
  for (const listener of fixture.listeners) {
    listener.onBeforeCall(progress, owned);
    listener.onBeforeCall(progress, unrelated);
  }
  assert.notEqual(owned.setInputFiles, original);
  assert.equal(unrelated.setInputFiles, original);
  assert.equal(await (owned.setInputFiles as any)(progress, { payloads: [] }), "native");
  dispose();
  assert.equal(owned.setInputFiles, original);
  assert.equal(fixture.listeners.size, 0);
});

test("hosted native upload paths preserve bytes, metadata, events and multipart submission", { skip: !endpoint, timeout: 300000 }, async (t) => {
  const { ensurePlaywright } = await import(new URL("playwright-runtime.mjs", scripts).href);
  const modulePath = await ensurePlaywright();
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const daemon = await chromium.connectOverCDP(endpoint, { noDefaults: true });
  const dispose = await installBrowserUploads(daemon, modulePath);
  let worker;
  const dir = await mkdtemp(join(tmpdir(), "native-upload-"));
  try {
    const { endpoint: socket } = await daemon.bind("upload-test", { host: "127.0.0.1", port: 0 });
    worker = await chromium.connect(socket);
    const context = await worker.newContext();
    const page = await context.newPage();
    await page.route("https://upload.test/**", (route: any) => route.fulfill({ contentType: "text/html", body: '<form method="post" enctype="multipart/form-data" action="/submit"><label for="f">Files</label><input id="f" name="files" type="file" multiple><input id="single" type="file"><input id="wrong"><script>window.events=[];for(const type of ["input","change"])document.querySelector("#f").addEventListener(type,e=>events.push({type:e.type,bubbles:e.bubbles,composed:e.composed}));</script></form>' }));
    await page.goto("https://upload.test/", { waitUntil: "domcontentloaded" });
    const big = join(dir, "large.bin");
    const little = join(dir, "hello.txt");
    const bytes = Buffer.alloc(51 * 1024 * 1024);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    await writeFile(big, bytes);
    await writeFile(little, "small file\n");
    await utimes(big, 1700000000, 1700000000);
    const expectedHash = createHash("sha256").update(bytes).digest("hex");
    const expectedTime = Math.floor((await stat(big)).mtimeMs);
    const inspect = () => page.locator("#f").evaluate(async (input: HTMLInputElement) => Promise.all([...input.files!].map(async (file) => ({
      name: file.name, size: file.size, type: file.type, lastModified: file.lastModified,
      hash: [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))].map((v) => v.toString(16).padStart(2, "0")).join(""),
      cloned: { name: structuredClone(file).name, size: structuredClone(file).size, lastModified: structuredClone(file).lastModified },
    }))));
    await t.test("Locator and Frame stream more than the native 50 MiB limit", async () => {
      await page.getByLabel("Files").setInputFiles([big, little], { timeout: 120000 });
      const files = await inspect();
      assert.deepEqual(files[0], { name: "large.bin", size: bytes.length, type: "application/octet-stream", lastModified: expectedTime, hash: expectedHash, cloned: { name: "large.bin", size: bytes.length, lastModified: expectedTime } });
      assert.equal(files[1].name, "hello.txt");
      assert.deepEqual(await page.evaluate("events"), [{ type: "input", bubbles: true, composed: true }, { type: "change", bubbles: true, composed: false }]);
      await page.mainFrame().setInputFiles("#f", [], { timeout: 10000 });
      assert.equal((await inspect()).length, 0);
    });
    await t.test("FileChooser and ElementHandle share the streamed path", async () => {
      const choosing = page.waitForEvent("filechooser");
      await page.locator("#f").click();
      const chooser = await choosing;
      await chooser.setFiles(big, { timeout: 120000 });
      assert.equal((await inspect())[0].hash, expectedHash);
      const element = await page.locator("#f").elementHandle();
      await element.setInputFiles([big, little], { timeout: 120000 });
      assert.equal((await inspect()).length, 2);
      await element.dispose();
    });
    await t.test("native multipart request contains full real file bytes", async () => {
      let posted;
      await page.route("https://upload.test/submit", async (route: any) => {
        const request = route.request();
        const body = request.postDataBuffer();
        const form = await new Response(body, { headers: { "content-type": request.headers()["content-type"] } }).formData();
        posted = await Promise.all(form.getAll("files").map(async (file: any) => ({ name: file.name, size: file.size, hash: createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex") })));
        await route.fulfill({ contentType: "text/plain", body: "ok" });
      });
      await page.evaluate("fetch('/submit', {method:'POST',body:new FormData(document.querySelector('form'))}).then(r=>r.text())");
      assert.deepEqual(posted, [{ name: "large.bin", size: bytes.length, hash: expectedHash }, { name: "hello.txt", size: 11, hash: createHash("sha256").update("small file\n").digest("hex") }]);
    });
    await t.test("small buffers and clear retain native behavior", async () => {
      await page.locator("#f").setInputFiles({ name: "payload.txt", mimeType: "text/plain", buffer: Buffer.from("payload") });
      assert.equal((await inspect())[0].name, "payload.txt");
      await page.locator("#f").setInputFiles([]);
      assert.deepEqual(await inspect(), []);
    });
    await t.test("invalid target and cardinality fail without assigning", async () => {
      await assert.rejects(page.locator("#single").setInputFiles([big, little]), /Non-multiple/);
      await assert.rejects(page.locator("#wrong").setInputFiles(big), /input\[type=file\]/);
    });
  } finally {
    if (worker) await worker.close();
    await daemon.unbind();
    dispose();
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  }
});
