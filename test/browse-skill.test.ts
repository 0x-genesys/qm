import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { WebSocketServer } from "ws";
const SCRIPT = fileURLToPath(new URL("../skills-seed/browse/scripts/browser.mjs", import.meta.url));
const INJECTED_LOADER = new URL("../skills-seed/browse/scripts/injected-engine.mjs", import.meta.url).href;
const offlineLoader = `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  if (url === ${JSON.stringify(INJECTED_LOADER)}) return {
    format: 'module', shortCircuit: true,
    source: 'export async function loadInjectedSource() { return ""; }',
  };
  return nextLoad(url, context);
} });`;
registerHooks({
  load(url, context, nextLoad) {
    if (url === INJECTED_LOADER)
      return {
        format: "module",
        shortCircuit: true,
        source: 'export async function loadInjectedSource() { return ""; }',
      };
    return nextLoad(url, context);
  },
});
type Call = {
  method: string;
  url: string;
  key: string | undefined;
  body: unknown;
};
async function fakeApi(
  billing: {
    status: number;
    body?: unknown;
  },
  patchStatus = 200,
) {
  const cdp = await fakeCdp();
  const calls: Call[] = [];
  const state = { patchStatus };
  const server: Server = createServer((req: IncomingMessage, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      const call = {
        method: req.method ?? "",
        url: req.url ?? "",
        key: req.headers["x-browser-use-api-key"] as string | undefined,
        body: text ? JSON.parse(text) : undefined,
      };
      calls.push(call);
      res.setHeader("content-type", "application/json");
      if (call.url === "/api/v2/billing/account") {
        res.statusCode = billing.status;
        res.end(JSON.stringify(billing.body ?? { detail: "nope" }));
      } else if (call.method === "POST" && call.url === "/api/v4/browsers") {
        res.statusCode = 201;
        res.end(JSON.stringify({ id: "b1", cdpUrl: cdp.url, liveUrl: "https://live.test/b1" }));
      } else if (call.method === "PATCH" && call.url.startsWith("/api/v4/browsers/")) {
        res.statusCode = state.patchStatus;
        res.end(JSON.stringify({ id: "b1", status: "stopped" }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return {
    calls,
    cdp,
    state,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => {
      server.close();
      cdp.close();
    },
  };
}
async function fakeCdp() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const calls: Array<{
    method: string;
    params: Record<string, any>;
    sessionId?: string;
  }> = [];
  const pages = new Map<
    string,
    {
      url: string;
      context: ReturnType<typeof createContext>;
    }
  >();
  const sessions = new Map<string, string>();
  function addPage(url: string) {
    const id = `tab-${pages.size + 1}`;
    const page = { url, context: createContext({}) };
    const document = {
      get title() {
        return "Fake " + page.url;
      },
      querySelectorAll: () => [],
    };
    page.context = createContext({
      document,
      location: {
        get href() {
          return page.url;
        },
      },
    });
    pages.set(id, page);
    return id;
  }
  addPage("about:blank");
  const info = (id: string) => ({
    targetId: id,
    type: "page",
    url: pages.get(id)!.url,
    title: "Fake " + pages.get(id)!.url,
    attached: false,
    browserContextId: "context-1",
  });
  server.on("connection", (socket) => {
    socket.on("message", async (raw) => {
      const request = JSON.parse(raw.toString());
      const { id, method, params = {}, sessionId } = request;
      calls.push({ method, params, sessionId });
      const reply = (result: unknown) => socket.send(JSON.stringify({ id, sessionId, result }));
      const event = (method: string, params: unknown) => socket.send(JSON.stringify({ method, params, sessionId }));
      try {
        const page = pages.get(sessions.get(sessionId)!);
        switch (method) {
          case "Target.getTargets":
            reply({ targetInfos: [...pages.keys()].map(info) });
            break;
          case "Target.getTargetInfo":
            reply({ targetInfo: info(params.targetId) });
            break;
          case "Target.createTarget": {
            const targetId = addPage(params.url || "about:blank");
            reply({ targetId });
            event("Target.targetCreated", { targetInfo: info(targetId) });
            break;
          }
          case "Target.attachToTarget": {
            if (!pages.has(params.targetId)) throw new Error("No target with given id found");
            const childSession = `session-${params.targetId}`;
            sessions.set(childSession, params.targetId);
            reply({ sessionId: childSession });
            break;
          }
          case "Target.closeTarget":
            pages.delete(params.targetId);
            reply({ success: true });
            event("Target.targetDestroyed", { targetId: params.targetId });
            break;
          case "Page.navigate": {
            assert.ok(page, "navigation needs an attached target");
            page.url = params.url;
            reply({ frameId: "frame-1", loaderId: "loader-1" });
            event("Page.frameNavigated", { frame: { id: "frame-1", url: page.url } });
            event("Page.loadEventFired", { timestamp: 1 });
            event("Page.lifecycleEvent", { name: "DOMContentLoaded", loaderId: "loader-1", frameId: "frame-1" });
            break;
          }
          case "Runtime.evaluate": {
            assert.ok(page, "evaluation needs an attached target");
            try {
              const operation = /^"qm:([^"]+)"/.exec(params.expression)?.[1];
              const replies: Record<string, unknown> = {
                init: undefined,
                "locator.count": 1,
                "locator.textContent": { value: "Continue" },
                "locator.prepareClick": { x: 30, y: 20 },
                "locator.finishClick": "done",
                "locator.prepareFill": { ready: true },
                "locator.fill": "done",
                snapshot: "- button Continue",
              };
              const value = operation ? replies[operation] : await runInContext(params.expression, page.context);
              reply({ result: { type: typeof value, value } });
            } catch (error) {
              reply({
                result: { type: "object", subtype: "error" },
                exceptionDetails: { text: "Uncaught", exception: { description: String(error) } },
              });
            }
            break;
          }
          case "Page.getFrameTree":
            reply({ frameTree: { frame: { id: "frame-1" } } });
            break;
          case "Page.createIsolatedWorld":
            reply({ executionContextId: 7 });
            break;
          case "Input.dispatchMouseEvent":
          case "Input.dispatchKeyEvent":
          case "Input.insertText":
            reply({});
            break;
          case "Page.captureScreenshot":
            reply({ data: Buffer.from("png").toString("base64") });
            break;
          case "Page.setLifecycleEventsEnabled":
          case "Runtime.enable":
          case "Page.enable":
          case "Target.setDiscoverTargets":
          case "Target.setAutoAttach":
          case "Target.detachFromTarget":
            reply({});
            break;
          default:
            throw new Error(`Unexpected CDP command: ${method}`);
        }
      } catch (error) {
        socket.send(JSON.stringify({ id, sessionId, error: { code: -32000, message: String(error) } }));
      }
    });
  });
  return {
    calls,
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/devtools/browser/test`,
    disconnect: () => {
      for (const client of server.clients) client.terminate();
    },
    close: () => {
      for (const client of server.clients) client.terminate();
      server.close();
    },
  };
}
function run(args: string[], env: Record<string, string | undefined>, input?: string, timeoutMs = 20000) {
  return new Promise<{
    code: number | null;
    out: Record<string, unknown>;
  }>((resolve, reject) => {
    const clean = { ...process.env };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "BROWSER_USE_API_KEY"]) delete clean[k];
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...clean, ...env } });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`browser command timed out: ${args[0]}`));
    }, timeoutMs);
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stdin.end(input ?? "");
    child.on("close", (code) => {
      clearTimeout(timeout);
      const last = stdout.trim().split("\n").at(-1) ?? "{}";
      try {
        resolve({ code, out: JSON.parse(last) });
      } catch {
        reject(new Error(`invalid browser output (${args[0]}, exit ${code}): ${stdout}\n${stderr}`));
      }
    });
  });
}
function sandbox(
  api: {
    base: string;
  },
  extra: Record<string, string> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "browse-skill-"));
  const loader = join(dir, "offline-loader.mjs");
  writeFileSync(loader, offlineLoader);
  const env = {
    NODE_OPTIONS: `--import=${loader}`,
    BROWSER_USE_API_BASE: api.base,
    BROWSER_USE_API_KEY: "bu_test",
    QM_BROWSE_DIR: join(dir, "run"),
    QM_BROWSE_CACHE: join(dir, "cache"),
    ...extra,
  };
  return { dir, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
test("preflight explains a missing, rejected, or empty Browser Use key", async () => {
  const cases: Array<
    [
      {
        status: number;
        body?: unknown;
      },
      string | null,
      boolean,
    ]
  > = [
    [{ status: 200, body: { totalCreditsBalanceUsd: 3 } }, null, true],
    [{ status: 401 }, "key_rejected", false],
    [{ status: 403 }, "key_rejected", false],
    [{ status: 402 }, "no_credits", false],
    [{ status: 200, body: { totalCreditsBalanceUsd: 0 } }, "no_credits", false],
  ];
  for (const [billing, reason, ok] of cases) {
    const api = await fakeApi(billing);
    const box = sandbox(api);
    try {
      const { code, out } = await run(["preflight"], box.env);
      assert.equal(out.ok, ok, JSON.stringify(out));
      if (reason) assert.equal(out.reason, reason);
      assert.equal(code, ok ? 0 : 2);
      assert.equal(api.calls[0]?.key, "bu_test");
    } finally {
      api.close();
      box.cleanup();
    }
  }
  const api = await fakeApi({ status: 200 });
  const box = sandbox(api, { BROWSER_USE_API_KEY: "" });
  try {
    const { code, out } = await run(["preflight"], box.env);
    assert.deepEqual([code, out.reason], [2, "missing_key"]);
    assert.equal(api.calls.length, 0);
  } finally {
    api.close();
    box.cleanup();
  }
});
test("open does not create a browser when the account has no credits", async () => {
  const api = await fakeApi({ status: 402 });
  const box = sandbox(api);
  try {
    const { code, out } = await run(["open"], box.env);
    assert.deepEqual([code, out.reason], [2, "no_credits"]);
    assert.ok(!api.calls.some((c) => c.method === "POST"));
  } finally {
    api.close();
    box.cleanup();
  }
});
test("open keeps one page alive across persistent JavaScript calls and stop stops the cloud browser", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    const opened = await run(["open", "--country", "none", "--profile", "p-1"], box.env);
    assert.equal(opened.out.ok, true, JSON.stringify(opened.out));
    assert.equal(opened.out.liveUrl, "https://live.test/b1");
    const create = api.calls.find((c) => c.method === "POST");
    assert.deepEqual(create?.body, { proxyCountryCode: null, profileId: "p-1" });
    const nav = await run(["js", "await tab.goto('https://example.com'); await tab.title()"], box.env);
    assert.equal(nav.out.result, "Fake https://example.com");
    await run(["js", "-"], box.env, "var n = 41; var keptTab = tab");
    const kept = await run(["js", "n + 1"], box.env);
    assert.equal(kept.out.result, "42");
    const keptTab = await run(["js", "await keptTab.url()"], box.env);
    assert.equal(keptTab.out.result, "https://example.com");
    const evaluated = await run(["js", "await tab.evaluate('document.title')"], box.env);
    assert.equal(evaluated.out.result, "Fake https://example.com");
    assert.ok(api.cdp.calls.some((c) => c.method === "Page.navigate"));
    assert.ok(api.cdp.calls.some((c) => c.method === "Runtime.evaluate"));
    const shot = await run(["screenshot", join(box.dir, "s.png")], box.env);
    assert.equal(shot.out.ok, true);
    assert.equal(readFileSync(join(box.dir, "s.png"), "utf8"), "png");
    const stopped = await run(["stop"], box.env);
    assert.equal(stopped.out.stopped, true);
    const patch = api.calls.find((c) => c.method === "PATCH");
    assert.deepEqual(patch?.body, { action: "stop" });
    assert.ok(!existsSync(join(box.env.QM_BROWSE_DIR, "default.sock")));
    assert.ok(!existsSync(join(box.env.QM_BROWSE_DIR, "default.json")));
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});
test("an idle browser is stopped by the daemon", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api, { QM_BROWSE_IDLE_MS: "1500" });
  try {
    const opened = await run(["open"], box.env);
    assert.equal(opened.out.ok, true, JSON.stringify(opened.out));
    for (let i = 0; i < 80 && !api.calls.some((c) => c.method === "PATCH"); i++) await sleep(100);
    assert.ok(api.calls.some((c) => c.method === "PATCH" && c.url === "/api/v4/browsers/b1"));
  } finally {
    api.close();
    box.cleanup();
  }
});
test("a failed stop keeps the browser id so a later stop can retry", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } }, 500);
  const box = sandbox(api);
  try {
    assert.equal((await run(["open"], box.env)).out.ok, true);
    const first = await run(["stop"], box.env);
    assert.equal(first.code, 1);
    assert.deepEqual([first.out.stopped, first.out.status], [false, 500]);
    assert.ok(existsSync(join(box.env.QM_BROWSE_DIR, "default.json")));
    api.state.patchStatus = 200;
    const retry = await run(["stop"], box.env);
    assert.deepEqual([retry.code, retry.out.stopped], [0, true]);
    assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.json")), false);
  } finally {
    api.close();
    box.cleanup();
  }
});
test("open stops a browser left behind by a dead daemon before creating another", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    mkdirSync(box.env.QM_BROWSE_DIR, { recursive: true });
    writeFileSync(join(box.env.QM_BROWSE_DIR, "default.json"), JSON.stringify({ id: "old" }));
    assert.equal((await run(["open"], box.env)).out.ok, true);
    const order = api.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`);
    assert.deepEqual(order.slice(0, 2), ["PATCH /api/v4/browsers/old", "POST /api/v4/browsers"]);
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});
test("structured tabs API persists references and rejects missing tabs without losing the session", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    assert.equal((await run(["open"], box.env)).out.ok, true);
    const created = await run(
      ["js", "var second = await browser.tabs.new(); await second.goto('https://second.test'); second.id"],
      box.env,
    );
    assert.equal(created.out.result, "tab-2", JSON.stringify(created.out));
    const retained = await run(["js", "var restored = browser.tabs.get(second.id); await restored.title()"], box.env);
    assert.equal(retained.out.result, "Fake https://second.test");
    assert.equal((await run(["js", "(await browser.tabs.list()).length"], box.env)).out.result, "2");
    assert.equal((await run(["js", "await tab.url()"], box.env)).out.result, "about:blank");
    const missing = await run(["js", "await browser.tabs.get('missing-tab').title()"], box.env);
    assert.equal(missing.code, 1);
    assert.equal(missing.out.ok, false);
    assert.match(String(missing.out.error), /tab|target/i);
    const rejected = await run(["js", "await Promise.reject(new Error('async failure'))"], box.env);
    assert.equal(rejected.out.ok, false);
    assert.match(String(rejected.out.error), /async failure/);
    const thrown = await run(["js", "throw new Error('sync failure')"], box.env);
    assert.equal(thrown.out.ok, false);
    assert.match(String(thrown.out.error), /sync failure/);
    const unknown = await run(["js", "await restored.notAnOperation()"], box.env);
    assert.equal(unknown.code, 1);
    assert.equal(unknown.out.ok, false);
    assert.equal((await run(["js", "await restored.url()"], box.env)).out.result, "https://second.test");
    const legacy = await run(["eval", "1+1"], box.env);
    assert.equal(legacy.code, 1, "the removed eval command must not remain an alternate code path");
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});
test("concurrent js calls run sequentially in the persistent runtime", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    assert.equal((await run(["open"], box.env)).out.ok, true);
    assert.equal((await run(["js", "var serial = 0"], box.env)).out.ok, true);
    const first = run(
      [
        "js",
        "await tab.goto('https://serial.test'); await new Promise(resolve => setTimeout(resolve, 400)); serial += 1",
      ],
      box.env,
    );
    for (let i = 0; i < 100 && !api.cdp.calls.some((c) => c.method === "Page.navigate"); i++) await sleep(20);
    assert.ok(
      api.cdp.calls.some((c) => c.method === "Page.navigate"),
      "first call reached the browser",
    );
    const second = run(["js", "serial += 1"], box.env);
    const results = await Promise.all([first, second]);
    assert.deepEqual(
      results.map((r) => [r.code, r.out.result]),
      [
        [0, "1"],
        [0, "2"],
      ],
    );
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});
test("a CDP disconnect stops the cloud browser and removes the dead session", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    assert.equal((await run(["open"], box.env)).out.ok, true);
    api.cdp.disconnect();
    for (let i = 0; i < 100 && existsSync(join(box.env.QM_BROWSE_DIR, "default.json")); i++) await sleep(30);
    assert.ok(api.calls.some((c) => c.method === "PATCH" && c.url === "/api/v4/browsers/b1"));
    assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.sock")), false);
    assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.json")), false);
    const dead = await run(["js", "await tab.title()"], box.env);
    assert.equal(dead.code, 1);
    assert.equal(dead.out.ok, false);
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});
test("concurrent opens create only one cloud browser for a session", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    const opened = await Promise.all([run(["open"], box.env), run(["open"], box.env)]);
    assert.equal(opened.filter((result) => result.out.ok === true).length, 1, JSON.stringify(opened));
    assert.equal(api.calls.filter((call) => call.method === "POST" && call.url === "/api/v4/browsers").length, 1);
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});
test("structured locators use the isolated page world and native input commands", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    assert.equal((await run(["open"], box.env)).out.ok, true);
    const count = await run(
      ["js", "await tab.playwright.getByRole('button', { name: 'Continue', exact: true }).count()"],
      box.env,
    );
    assert.equal(count.out.result, "1", JSON.stringify(count.out));
    const text = await run(["js", "await tab.playwright.locator('button').textContent()"], box.env);
    assert.equal(text.out.result, "Continue");
    assert.equal(
      (await run(["js", "await tab.playwright.getByRole('button', { name: 'Continue' }).click()"], box.env)).out.ok,
      true,
    );
    assert.equal((await run(["js", "await tab.playwright.locator('input').fill('Ada')"], box.env)).out.ok, true);
    const calls = api.cdp.calls;
    assert.ok(
      calls.some((call) => call.method === "Page.createIsolatedWorld" && call.params.worldName === "qm-browse"),
    );
    const evaluations = calls.filter(
      (call) => call.method === "Runtime.evaluate" && call.params.expression.startsWith('"qm:'),
    );
    assert.ok(evaluations.length > 0);
    assert.ok(evaluations.every((call) => call.params.contextId === 7));
    assert.equal(evaluations.filter((call) => call.params.expression.startsWith('"qm:init')).length, 1);
    assert.ok(evaluations.some((call) => call.params.expression.includes("internal:role=button[name=")));
    assert.deepEqual(
      calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.params.type),
      ["mouseMoved", "mousePressed", "mouseReleased"],
    );
    assert.ok(
      evaluations.some(
        (call) => call.params.expression.startsWith('"qm:locator.fill"') && call.params.expression.includes('"Ada"'),
      ),
    );
    assert.equal(
      calls.some((call) => call.method === "Input.insertText"),
      false,
    );
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});
test("browser service rejects unknown commands and invalid tabs before sending CDP", async () => {
  const cdp = await fakeCdp();
  const { connectBrowser } = await import(new URL("../skills-seed/browse/scripts/cdp.mjs", import.meta.url).href);
  const service = await connectBrowser(cdp.url);
  try {
    const before = cdp.calls.length;
    await assert.rejects(service.execute({ method: "Browser.close" }), /Unknown browser command/);
    await assert.rejects(service.execute({ method: "tab.title", tabId: "missing" }), /Unknown tab ID/);
    assert.equal(cdp.calls.length, before, "invalid requests must not become protocol commands");
    assert.equal((await service.execute({ method: "tabs.list" })).length, 1, "rejections do not poison the queue");
  } finally {
    service.close();
    cdp.close();
  }
});
test("a disconnected queued caller cannot execute later browser actions", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    assert.equal((await run(["open"], box.env)).out.ok, true);
    const active = run(
      [
        "js",
        "var cancelledActionRan = false; await tab.goto('https://active.test'); await new Promise(resolve => setTimeout(resolve, 600))",
      ],
      box.env,
    );
    for (let i = 0; i < 100 && !api.cdp.calls.some((c) => c.method === "Page.navigate"); i++) await sleep(10);
    assert.ok(
      api.cdp.calls.some((c) => c.method === "Page.navigate"),
      "first script has started",
    );
    const queued = request({
      socketPath: join(box.env.QM_BROWSE_DIR, "default.sock"),
      path: "/js",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    queued.on("error", () => {});
    await new Promise<void>((resolve) => {
      queued.once("finish", resolve);
      queued.end(JSON.stringify({ code: "cancelledActionRan = true; await tab.goto('https://must-not-run.test')" }));
    });
    await sleep(50);
    queued.destroy();
    assert.equal((await active).out.ok, true);
    assert.equal((await run(["js", "cancelledActionRan"], box.env)).out.result, "false");
    assert.ok(!api.cdp.calls.some((c) => c.method === "Page.navigate" && c.params.url === "https://must-not-run.test"));
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});
test("stop cancels a never-resolving script without waiting for the JavaScript timeout", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    assert.equal((await run(["open"], box.env)).out.ok, true);
    const active = run(["js", "await tab.goto('https://blocked.test'); await new Promise(() => {})"], box.env);
    for (let i = 0; i < 100 && !api.cdp.calls.some((c) => c.method === "Page.navigate"); i++) await sleep(10);
    assert.ok(
      api.cdp.calls.some((c) => c.method === "Page.navigate"),
      "blocked script has started",
    );
    const stopped = await run(["stop"], box.env, undefined, 3000);
    assert.equal(stopped.out.stopped, true, JSON.stringify(stopped.out));
    assert.equal((await active).code, 1, "stopping ends the pending script rather than claiming success");
    assert.ok(api.calls.some((c) => c.method === "PATCH" && c.url === "/api/v4/browsers/b1"));
    assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.sock")), false);
    assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.json")), false);
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});
test("screenshot follows the current REPL tab even after the original tab closes", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    assert.equal((await run(["open"], box.env)).out.ok, true);
    assert.equal(
      (await run(["js", "var original = tab; tab = await browser.tabs.new('https://current.test'); tab.id"], box.env))
        .out.result,
      "tab-2",
    );
    const path = join(box.dir, "current.png");
    assert.equal((await run(["screenshot", path], box.env)).out.ok, true);
    assert.equal((await run(["js", "await original.close()"], box.env)).out.ok, true);
    assert.equal((await run(["screenshot", path], box.env)).out.ok, true);
    assert.equal(readFileSync(path, "utf8"), "png");
    assert.deepEqual(
      api.cdp.calls.filter((c) => c.method === "Page.captureScreenshot").map((c) => c.sessionId),
      ["session-tab-2", "session-tab-2"],
    );
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});
