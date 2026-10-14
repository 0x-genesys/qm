import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { createBrowserClient } = await import(
  new URL("../skills-seed/browse/scripts/browser-client.mjs", import.meta.url).href
);

function mockBrowser() {
  const calls: unknown[][] = [];
  const pages: any[] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const context = {
    pages: () => pages,
    newCDPSession: async () => ({ send: record("cdp"), detach: record("detach") }),
    newPage: async () => {
      const page = Object.assign(new EventEmitter(), {
        _guid: `page-${pages.length}`,
        context: () => context,
        url: () => "https://example.test",
        title: async () => "Example",
        goto: record("goto"),
        goBack: record("back"),
        goForward: record("forward"),
        reload: record("reload"),
        close: async () => {
          pages.splice(pages.indexOf(page), 1);
        },
        keyboard: { down: record("down"), up: record("up"), insertText: record("text") },
        mouse: {
          click: record("click"),
          dblclick: record("double"),
          move: record("move"),
          down: record("mouseDown"),
          up: record("mouseUp"),
          wheel: record("wheel"),
        },
        getByRef: (id: string) => ({
          click: record(id),
          dblclick: record(`${id}:double`),
          hover: record(`${id}:hover`),
        }),
        consoleMessages: async () =>
          ["warning", "error", "log"].map((type) => ({
            type: () => type,
            text: () => `${type} message`,
            location: () => ({ url: "https://example.test" }),
          })),
        evaluate: async (fn: (...args: any[]) => unknown, arg: unknown) => fn(arg),
        waitForNavigation: async (...args: unknown[]) => {
          calls.push(["navigation", ...args]);
          return "response";
        },
      });
      pages.push(page);
      return page;
    },
  };
  const native = { contexts: () => [context], newContext: async () => context };
  return { native, context, calls };
}

test("client retains native Browser and Page identity, events, functions and stable IDs", async () => {
  const { native, context, calls } = mockBrowser();
  const page = await context.newPage();
  const extensions: unknown[] = [];
  const browser = createBrowserClient(native, {
    extendTab: (tab: unknown, value: unknown) => extensions.push([tab, value]),
  });
  const tab = browser.tabs.get(page._guid);
  assert.equal(browser.playwright, native);
  assert.equal(tab.playwright, page);
  assert.equal(browser.tabs.get(page._guid), tab);
  assert.equal(extensions.length, 1);
  assert.deepEqual(await browser.tabs.list(), [{ id: page._guid, title: "Example", url: "https://example.test" }]);
  assert.equal(await tab.evaluate((value: { a: number }) => value.a + 1, { a: 2 }), 3);
  let observed;
  tab.playwright.on("request", (request: unknown) => {
    observed = request;
  });
  page.emit("request", "native-request");
  assert.equal(observed, "native-request");
  await tab.goto("https://next.test", { waitUntil: "commit", timeout: 700 });
  await tab.back({ timeout: 50 });
  await tab.forward();
  await tab.reload();
  assert.deepEqual(calls, [
    ["goto", "https://next.test", { waitUntil: "commit", timeout: 700 }],
    ["back", { timeout: 50 }],
    ["forward"],
    ["reload"],
  ]);
  assert.equal(await tab.playwright.expectNavigation(() => calls.push(["action"]), { timeoutMs: 250 }), "response");
  assert.deepEqual(calls.slice(-2), [["navigation", { timeout: 250 }], ["action"]]);
  const added = await browser.tabs.new("https://new.test");
  added.playwright.evaluate = async () => true;
  assert.equal(await browser.tabs.selected(), added);
  added.playwright.evaluate = async () => false;
  page.evaluate = async () => true;
  assert.equal(await browser.tabs.selected(), tab);
  await added.close();
  assert.throws(() => browser.tabs.get(added.id), /No open tab/);
});

test("CUA maps native coordinates, chords, text, wheel and back/forward buttons", async () => {
  const { native, context, calls } = mockBrowser();
  const page = await context.newPage();
  const { cua, dom_cua } = createBrowserClient(native).tabs.get(page._guid);
  await cua.click({ x: 4, y: 5, button: 3, keypress: ["SHIFT"] });
  await cua.double_click({ x: 8, y: 9 });
  await cua.keypress({ keys: ["CTRL", "a"] });
  await cua.type({ text: "日本語" });
  await cua.scroll({ x: 4, y: 5, scrollX: 6, scrollY: 7 });
  await cua.drag({
    path: [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ],
  });
  assert.deepEqual(calls, [
    ["down", "Shift"],
    ["click", 4, 5, { button: "right" }],
    ["up", "Shift"],
    ["double", 8, 9],
    ["down", "Control"],
    ["down", "a"],
    ["up", "a"],
    ["up", "Control"],
    ["text", "日本語"],
    ["move", 4, 5],
    ["wheel", 6, 7],
    ["move", 1, 2],
    ["mouseDown"],
    ["move", 3, 4],
    ["mouseUp"],
  ]);
  await dom_cua.click({ node_id: "f1e2", button: "middle", modifiers: ["Alt"] });
  assert.deepEqual(calls.at(-1), ["f1e2", { button: "middle", modifiers: ["Alt"] }]);
  for (const button of [4, 5]) {
    await cua.click({ x: 1, y: 2, button, keypress: ["CTRL"] });
    assert.deepEqual(
      calls.slice(-5).map((call) => call[0]),
      ["down", "cdp", "cdp", "detach", "up"],
    );
    assert.equal((calls.at(-4)?.[2] as any).button, button === 4 ? "back" : "forward");
    assert.equal((calls.at(-4)?.[2] as any).modifiers, 2);
  }
});

test("CUA releases held keys and mouse after failures, preserving cleanup failures", async () => {
  const { native, context, calls } = mockBrowser();
  const page = await context.newPage();
  const { cua } = createBrowserClient(native).tabs.get(page._guid);
  page.mouse.click = async () => {
    throw new Error("target closed");
  };
  await assert.rejects(cua.click({ x: 1, y: 2, keypress: ["SHIFT", "ALT"] }), /target closed/);
  assert.deepEqual(calls, [
    ["down", "Shift"],
    ["down", "Alt"],
    ["up", "Alt"],
    ["up", "Shift"],
  ]);
  page.keyboard.up = async () => {
    throw new Error("cleanup failed");
  };
  await assert.rejects(
    cua.click({ x: 1, y: 2, keypress: ["SHIFT"] }),
    (error: any) =>
      error instanceof AggregateError &&
      error.errors.map((entry) => entry.message).join(",") === "target closed,cleanup failed",
  );
  let moves = 0;
  page.mouse.move = async () => {
    if (++moves === 2) throw new Error("drag interrupted");
  };
  await assert.rejects(
    cua.drag({
      path: [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
    }),
    /drag interrupted/,
  );
  assert.deepEqual(calls.at(-1), ["mouseUp"]);
});

test("snapshots mask editable values structurally without changing labels, references or native data", async () => {
  const { native, context } = mockBrowser();
  const page = await context.newPage();
  const original = [
    { role: "textbox", name: "A label", ref: "e1", text: "a" },
    { role: "spinbutton", ref: "e2", children: ["123", { role: "text", text: "456" }] },
    { role: "combobox", ref: "e3", children: [{ role: "option", name: "Option a", selected: true }] },
    { role: "paragraph", text: "Normal a label" },
    { role: "iframe", children: [{ role: "textbox", ref: "f1e1", text: "frame value" }] },
  ];
  Object.assign(page, {
    ariaSnapshotJSON: async () => original,
    evaluate: async () => {
      throw new Error("must not modify page");
    },
  });
  const tab = createBrowserClient(native).tabs.get(page._guid);
  const snapshot = JSON.parse(await tab.dom_cua.get_visible_dom());
  assert.equal(snapshot[0].name, "A label");
  assert.equal(snapshot[0].text, "<redacted>");
  assert.deepEqual(snapshot[1].children, ["<redacted>", { role: "text", text: "<redacted>" }]);
  assert.equal(snapshot[2].children[0].name, "Option a");
  assert.equal(snapshot[3].text, "Normal a label");
  assert.equal(snapshot[4].children[0].ref, "f1e1");
  assert.equal(snapshot[4].children[0].text, "<redacted>");
  assert.equal(original[0]?.text, "a");
});

test("dev logs use native stored messages and filter mapped warning levels", async () => {
  const { native, context } = mockBrowser();
  const page = await context.newPage();
  const tab = createBrowserClient(native).tabs.get(page._guid);
  assert.deepEqual(
    (await tab.dev.logs({ levels: ["warn"] })).map((entry: any) => entry.message),
    ["warning message"],
  );
  assert.equal((await tab.dev.logs({ filter: "error", limit: 1 })).length, 1);
  assert.equal((await tab.dev.logs({ limit: 0 })).length, 0);
});

test(
  "native Chromium convenience layer keeps frames, handles, dialogs, snapshots and clipboard",
  { skip: !process.env.BROWSE_TEST_CHROMIUM },
  async () => {
    const { ensurePlaywright } = await import(
      new URL("../skills-seed/browse/scripts/playwright-runtime.mjs", import.meta.url).href
    );
    const { chromium } = await import(pathToFileURL(await ensurePlaywright()).href);
    const launched = await chromium.launch({ headless: !process.env.DISPLAY });
    const directory = await mkdtemp(join(tmpdir(), "browse-client-"));
    let connected;
    try {
      const context = await launched.newContext();
      const original = await context.newPage();
      const { endpoint } = await launched.bind("client-test", { host: "127.0.0.1", port: 0 });
      connected = await chromium.connect(endpoint);
      const browser = createBrowserClient(connected, { outputDir: directory });
      const tab = browser.tabs.get(original._guid);
      const page = tab.playwright;
      const newer = await browser.tabs.new();
      if (process.env.DISPLAY) {
        for (const candidate of [page, newer.playwright]) {
          const session = await candidate.context().newCDPSession(candidate);
          await session.send("Emulation.setFocusEmulationEnabled", { enabled: false });
          await session.detach();
        }
      }
      await page.bringToFront();
      assert.equal((await browser.tabs.selected()).id, process.env.DISPLAY ? tab.id : newer.id);
      await newer.close();
      page.setDefaultTimeout(2000);
      assert.equal(page._guid, original._guid);
      await page.route("https://example.test/**", (route: any) =>
        route.fulfill({
          contentType: "text/html",
          body: '<title>Native</title><input value="sensitive-input"><textarea>sensitive-area</textarea><input type="password" value="sensitive-password"><p>Normal a label</p><input value="a"><input type="radio" value="a"><input type="checkbox"><select><option>Keep options</option></select><button onclick="this.textContent=\'clicked\'">Outer</button><iframe srcdoc="<button>Inner</button><textarea>sensitive-frame</textarea>"></iframe>',
        }),
      );
      await tab.goto("https://example.test/");
      await page
        .frameLocator("iframe")
        .getByRole("button", { name: "Inner" })
        .dblclick({ modifiers: ["Shift"] });
      const handle = await page.evaluateHandle(() => ({ number: 7 }));
      assert.equal(await page.evaluate((value: any) => value.number, handle), 7);
      await handle.dispose();
      const before = await page
        .locator("input,textarea")
        .evaluateAll((elements: any[]) => elements.map((element) => element.value));
      const snapshot = await page.domSnapshot();
      assert.equal(snapshot.includes("sensitive-"), false);
      assert.equal(snapshot.includes("Inner"), true);
      assert.equal(snapshot.includes("Keep options"), true);
      assert.equal(snapshot.includes("Normal a label"), true);
      assert.deepEqual(
        await page.locator("input,textarea").evaluateAll((elements: any[]) => elements.map((element) => element.value)),
        before,
      );
      const flatten = (nodes: any[]): any[] => nodes.flatMap((node) => [node, ...flatten(node.children || [])]);
      const button = flatten(JSON.parse(snapshot)).find((node) => node.name === "Inner");
      assert.match(button.ref, /^f\d+e\d+$/);
      await tab.dom_cua.click({ node_id: button.ref });
      const second = flatten(JSON.parse(await tab.dom_cua.get_visible_dom())).find((node) => node.name === "Inner");
      assert.equal(second.ref, button.ref);
      await page.evaluate(() => {
        const button = (globalThis as any).document.querySelector("button");
        button.onclick = () => (globalThis as any).alert("automatic");
      });
      await page.getByRole("button", { name: "Outer" }).click();
      const dialogPromise = tab.getJsDialog({ timeoutMs: 2000 });
      const clickPromise = page.getByRole("button", { name: "Outer" }).click();
      const dialog = await dialogPromise;
      assert.equal(dialog.type(), "alert");
      assert.equal(dialog.message(), "automatic");
      await dialog.accept();
      await clickPromise;
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await tab.clipboard.writeText("text clipboard");
      assert.equal(await tab.clipboard.readText(), "text clipboard");
      await tab.clipboard.write([
        {
          entries: [
            { mimeType: "text/plain", text: "rich clipboard" },
            { mimeType: "text/html", text: "<b>rich clipboard</b>" },
          ],
        },
      ]);
      const clipboard = await tab.clipboard.read();
      assert.equal(clipboard[0].entries.find((entry: any) => entry.mimeType === "text/plain").text, "rich clipboard");
      const png = await page.screenshot();
      await tab.clipboard.write([{ entries: [{ mimeType: "image/png", base64: png.toString("base64") }] }]);
      const image = (await tab.clipboard.read())[0].entries.find((entry: any) => entry.mimeType === "image/png");
      assert.equal(Buffer.from(image.base64, "base64").subarray(1, 4).toString(), "PNG");
      const path = await tab.screenshot({ fullPage: true });
      assert.equal((await readFile(path)).subarray(1, 4).toString(), "PNG");
      assert.equal(Buffer.isBuffer(await page.screenshot()), true);
    } finally {
      await connected?.close();
      await launched.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
