import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
const endpoint = process.env.BROWSE_TEST_CDP;
const engineUrl = new URL("../skills-seed/browse/scripts/injected-engine.mjs", import.meta.url).href;
const hook = !endpoint
  ? registerHooks({
      load(url, context, nextLoad) {
        if (url === engineUrl)
          return {
            format: "module",
            source: "export async function loadInjectedSource() { return ''; }",
            shortCircuit: true,
          };
        return nextLoad(url, context);
      },
    })
  : undefined;
const { connectBrowser } = await import(new URL("../skills-seed/browse/scripts/cdp.mjs", import.meta.url).href);
hook?.deregister();
type Message = {
  id: number;
  method: string;
  params: Record<string, any>;
  sessionId?: string;
};
async function mockCDP(override?: (message: Message) => any) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const calls: Message[] = [];
  server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as Message;
      calls.push(message);
      let result = override?.(message);
      if (result === false) return;
      if (result === undefined) {
        switch (message.method) {
          case "Target.getTargets":
            result = {
              targetInfos: [
                { type: "page", targetId: "tab", url: "https://example.test", title: "Example" },
                { type: "service_worker", targetId: "worker" },
              ],
            };
            break;
          case "Target.attachToTarget":
            result = { sessionId: "session" };
            break;
          case "Page.getFrameTree":
            result = { frameTree: { frame: { id: "frame" } } };
            break;
          case "Page.createIsolatedWorld":
            result = { executionContextId: 42 };
            break;
          case "Runtime.evaluate": {
            const expression = message.params.expression as string;
            let value: unknown = "Example";
            if (expression.startsWith('"qm:locator.prepareClick')) value = { x: 25, y: 40 };
            else if (
              expression.startsWith('"qm:locator.finishClick') ||
              expression.startsWith('"qm:locator.finishFill')
            )
              value = "done";
            else if (expression.startsWith('"qm:locator.count')) value = 1;
            else if (expression.startsWith('"qm:locator.textContent')) value = { value: "Example" };
            else if (expression.startsWith('"qm:locator.prepareFill')) value = { ready: true };
            else if (expression.startsWith('"qm:locator.fill')) value = "done";
            else if (expression.startsWith('"qm:snapshot')) value = '- button "Example"';
            result = { result: { value } };
            break;
          }
          default:
            result = {};
        }
      }
      socket.send(JSON.stringify({ id: message.id, result, sessionId: message.sessionId }));
    }),
  );
  return {
    calls,
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
test("raw CDP keeps only page targets, validates commands, and initializes an isolated engine once", async () => {
  const mock = await mockCDP();
  const browser = await connectBrowser(mock.url);
  try {
    assert.deepEqual(await browser.execute({ method: "tabs.list" }), [
      { id: "tab", url: "https://example.test", title: "Example" },
    ]);
    await assert.rejects(browser.execute({ method: "tab.title", tabId: "worker" }), /Unknown tab ID/);
    await assert.rejects(browser.execute({ method: "Browser.close" }), /Unknown browser command/);
    await assert.rejects(browser.execute({ method: "tab.title", tabId: "tab", params: { timeoutMs: 0 } }), /timeoutMs/);
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,no", "chrome://settings"]) {
      await assert.rejects(browser.execute({ method: "tabs.new", params: { url } }), /Page URL/);
      await assert.rejects(browser.execute({ method: "tab.goto", tabId: "tab", params: { url } }), /Page URL/);
    }
    assert.equal(mock.calls.filter((call) => ["Page.navigate", "Target.createTarget"].includes(call.method)).length, 0);
    for (const options of [{ button: "right" }, { force: true }, { clickCount: 2 }, { arbitrary: 1 }])
      await assert.rejects(
        browser.execute({ method: "locator.click", tabId: "tab", params: { selector: "button", ...options } }),
        /Unsupported locator.click parameter/,
      );
    for (let i = 0; i < 2; i++)
      assert.equal(await browser.execute({ method: "locator.count", tabId: "tab", params: { selector: "button" } }), 1);
    assert.equal(
      mock.calls.filter((call) => call.method === "Runtime.evaluate" && call.params.expression.startsWith('"qm:init'))
        .length,
      1,
    );
    const world = mock.calls.find((call) => call.method === "Page.createIsolatedWorld")!;
    assert.equal(world.params.grantUniveralAccess, false);
    assert.equal(world.params.frameId, "frame");
    assert.equal(await browser.execute({ method: "tab.snapshot", tabId: "tab" }), '- button "Example"');
  } finally {
    browser.close();
    await mock.close();
  }
});
test("click uses raw mouse input once and fill performs one target-bound edit", async () => {
  const mock = await mockCDP();
  const browser = await connectBrowser(mock.url);
  try {
    await browser.execute({ method: "locator.click", tabId: "tab", params: { selector: "button" } });
    assert.deepEqual(
      mock.calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.params.type),
      ["mouseMoved", "mousePressed", "mouseReleased"],
    );
    await browser.execute({ method: "locator.fill", tabId: "tab", params: { selector: "input", value: "hello" } });
    assert.equal(mock.calls.filter((call) => call.method === "Input.insertText").length, 0);
    assert.equal(
      mock.calls.filter(
        (call) =>
          call.method === "Runtime.evaluate" &&
          call.params.expression.startsWith('"qm:locator.fill') &&
          call.params.expression.includes('"hello"'),
      ).length,
      1,
    );
  } finally {
    browser.close();
    await mock.close();
  }
});
test("uncertain mouse press is never replayed", async () => {
  const mock = await mockCDP((message) =>
    message.method === "Input.dispatchMouseEvent" && message.params.type === "mousePressed" ? false : undefined,
  );
  const browser = await connectBrowser(mock.url);
  try {
    await assert.rejects(
      browser.execute({ method: "locator.click", tabId: "tab", params: { selector: "button", timeoutMs: 250 } }),
      /timed out.*unknown/,
    );
    assert.equal(
      mock.calls.filter((call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mousePressed")
        .length,
      1,
    );
    assert.equal(
      mock.calls.filter((call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mouseReleased")
        .length,
      1,
    );
  } finally {
    browser.close();
    await mock.close();
  }
});
test("close rejects pending and queued commands and emits disconnected once", async () => {
  let pending!: () => void;
  const started = new Promise<void>((resolve) => {
    pending = resolve;
  });
  const mock = await mockCDP((message) => {
    if (message.method === "Runtime.evaluate") {
      pending();
      return false;
    }
  });
  const browser = await connectBrowser(mock.url);
  let disconnected = 0;
  browser.on("disconnected", () => disconnected++);
  try {
    const active = assert.rejects(browser.execute({ method: "tab.title", tabId: "tab" }), /disconnected/);
    const queued = assert.rejects(browser.execute({ method: "tab.url", tabId: "tab" }), /disconnected/);
    await started;
    browser.close();
    browser.close();
    await Promise.all([active, queued]);
    assert.equal(disconnected, 1);
  } finally {
    browser.close();
    await mock.close();
  }
});
test(
  "real Chromium: semantic selectors, safe actions, snapshots, navigation, and frame rejection",
  { skip: !endpoint },
  async () => {
    const browser = await connectBrowser(endpoint);
    const tab = await browser.execute({ method: "tabs.new" });
    const call = (method: string, params: Record<string, any> = {}) =>
      browser.execute({ method, tabId: tab.id, params });
    let html = "";
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(req.url === "/after" ? "<title>After navigation</title><button>New</button>" : html);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      html = `<title>CDP integration</title><script>window.clicks=0;window.inputs=0</script>
      <label>Name<input aria-label="Name" oninput="inputs++"></label><input type="date" aria-label="Date">
      <div contenteditable="true" role="textbox" aria-label="Editor">old</div>
      <button onclick="clicks++">Save</button><button disabled>Disabled</button>
      <button style="display:none">Hidden</button>
      <div style="position:relative;width:100px;height:30px"><button id="covered" onclick="clicks++">Covered</button><div id="overlay" style="position:absolute;inset:0;background:black"></div></div>
      <iframe srcdoc="<button>Frame button</button>"></iframe><div style="height:2000px"></div><button onclick="clicks++">Bottom</button>`;
      await call("tab.goto", { url });
      assert.equal(await call("tab.title"), "CDP integration");
      assert.equal(await call("tab.url"), `${url}/`);
      assert.equal(await call("locator.count", { selector: 'internal:role=button[name="Save"s]' }), 1);
      await call("locator.fill", { selector: 'internal:role=textbox[name="Name"s]', value: "hello" });
      assert.equal(await call("tab.evaluate", { expression: 'document.querySelector("input").value' }), "hello");
      await call("locator.fill", { selector: 'internal:role=textbox[name="Name"s]', value: "" });
      assert.equal(await call("tab.evaluate", { expression: 'document.querySelector("input").value' }), "");
      await call("locator.fill", { selector: 'internal:role=textbox[name="Editor"s]', value: "new text" });
      assert.equal(await call("locator.textContent", { selector: "[contenteditable]" }), "new text");
      await call("locator.fill", { selector: '[type="date"]', value: "2026-10-14" });
      assert.equal(
        await call("tab.evaluate", { expression: 'document.querySelector("[type=date]").value' }),
        "2026-10-14",
      );
      await call("locator.click", { selector: 'internal:role=button[name="Save"s]' });
      await call("locator.click", { selector: 'internal:text="Bottom"s' });
      assert.equal(await call("tab.evaluate", { expression: "clicks" }), 2);
      for (const selector of ['internal:role=button[name="Disabled"s]', "#covered", 'button:has-text("Hidden")'])
        await assert.rejects(call("locator.click", { selector, timeoutMs: 450 }), /timed out/);
      assert.equal(await call("tab.evaluate", { expression: "clicks" }), 2);
      await assert.rejects(call("locator.click", { selector: "button" }), /strict mode violation/);
      await assert.rejects(
        call("locator.count", { selector: "iframe >> internal:control=enter-frame >> button" }),
        /Frame traversal is not supported/,
      );
      assert.match(await call("tab.snapshot"), /button "Save"/);
      const png = Buffer.from(await call("tab.screenshot"), "base64");
      assert.equal(png.subarray(1, 4).toString(), "PNG");
      await call("tab.evaluate", {
        expression: `(() => {
      document.body.innerHTML = '<style>@keyframes move { from {transform:translateX(0)} to {transform:translateX(150px)} }</style><button id="moving" style="animation:move .5s linear infinite alternate" onclick="clicks++">Moving</button><button id="late" disabled onclick="clicks++">Late</button><button id="hover" onclick="clicks++">Hover</button><div id="cover" style="display:none;position:fixed;inset:0;background:transparent"></div>';
      document.querySelector('#hover').onmouseover = () => document.querySelector('#cover').style.display = 'block';
      setTimeout(() => document.querySelector('#late').disabled = false, 250);
    })()`,
      });
      await call("locator.click", { selector: "#late", timeoutMs: 2000 });
      await assert.rejects(call("locator.click", { selector: "#moving", timeoutMs: 450 }), /timed out/);
      const beforeHover = await call("tab.evaluate", { expression: "clicks" });
      await assert.rejects(call("locator.click", { selector: "#hover", timeoutMs: 2000 }), /intercepted/);
      assert.equal(await call("tab.evaluate", { expression: "clicks" }), beforeHover);
      for (const kind of ["input", "textarea", "contenteditable", "shadow"]) {
        await call("tab.evaluate", {
          expression: `(() => {
          document.body.innerHTML = '<input id="other">';
          let wanted;
          if (${JSON.stringify(kind)} === 'shadow') {
            const host = document.createElement('div'); document.body.append(host);
            const root = host.attachShadow({mode:'open'}); root.innerHTML = '<input id="wanted">'; wanted = root.querySelector('input');
          } else {
            wanted = document.createElement(${JSON.stringify(kind === "contenteditable" ? "div" : kind)});
            wanted.id = 'wanted';
            if (${JSON.stringify(kind)} === 'contenteditable') wanted.contentEditable = 'true';
            document.body.append(wanted);
          }
          wanted.onfocus = () => queueMicrotask(() => document.querySelector('#other').focus());
        })()`,
        });
        await call("locator.fill", { selector: "#wanted", value: "secret" });
        assert.equal(await call("tab.evaluate", { expression: "document.querySelector('#other').value" }), "");
        await call("locator.fill", { selector: "#other", value: "safe" });
        assert.equal(await call("tab.evaluate", { expression: "document.querySelector('#other').value" }), "safe");
      }
      await call("tab.evaluate", {
        expression: `(() => {
        document.body.innerHTML = '<input id="wanted"><iframe></iframe>';
        const frame = document.querySelector('iframe'); frame.contentDocument.body.innerHTML = '<input id="other">';
        document.querySelector('#wanted').onfocus = () => queueMicrotask(() => frame.contentDocument.querySelector('#other').focus());
      })()`,
      });
      await call("locator.fill", { selector: "#wanted", value: "frame-safe" });
      assert.equal(await call("tab.evaluate", { expression: "document.querySelector('#wanted').value" }), "frame-safe");
      assert.equal(
        await call("tab.evaluate", {
          expression: "document.querySelector('iframe').contentDocument.querySelector('#other').value",
        }),
        "",
      );
      await call("tab.evaluate", {
        expression: `(() => {
        document.body.innerHTML = '<input id="wanted"><input id="other">';
        document.querySelector('#wanted').onfocus = () => document.querySelector('#other').focus();
      })()`,
      });
      await assert.rejects(call("locator.fill", { selector: "#wanted", value: "secret" }), /lost focus/);
      assert.equal(await call("tab.evaluate", { expression: "document.querySelector('#other').value" }), "");
      await call("tab.evaluate", {
        expression: `(() => {
        document.body.innerHTML = '<input id="controlled"><input type="password" value="FAKE_SECRET"><input type="email" value="private@example.test"><input autocomplete="one-time-code" value="123456"><textarea name="username">hidden-user</textarea><input type="tel" value="5551112222">';
        window.edits = [];
        document.querySelector('#controlled').oninput = event => { edits.push(event.isTrusted); event.target.value = event.target.value; };
      })()`,
      });
      await call("locator.fill", { selector: "#controlled", value: "controlled-value" });
      assert.deepEqual(await call("tab.evaluate", { expression: "edits" }), [true]);
      const snapshot = await call("tab.snapshot");
      assert.match(snapshot, /redacted/);
      for (const secret of ["FAKE_SECRET", "private@example.test", "123456", "hidden-user", "5551112222"])
        assert.ok(!snapshot.includes(secret));
      assert.equal(
        await call("tab.evaluate", { expression: "document.querySelector('[type=password]').value" }),
        "FAKE_SECRET",
      );
      await call("tab.goto", { url: `${url}/after` });
      assert.equal(await call("locator.textContent", { selector: "button" }), "New");
      assert.equal(await call("tab.evaluate", { expression: "typeof globalThis.__qmInjected" }), "undefined");
    } finally {
      await call("tabs.close").catch(() => {});
      browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
