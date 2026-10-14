import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

const SCRIPT = fileURLToPath(new URL("../skills-seed/browse/scripts/browser.mjs", import.meta.url));

type Call = { method: string; url: string; key: string | undefined; body: unknown };

async function fakeApi(billing: { status: number; body?: unknown }) {
  const calls: Call[] = [];
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
        res.end(
          JSON.stringify({ id: "b1", cdpUrl: "ws://fake-cdp/devtools/browser/x", liveUrl: "https://live.test/b1" }),
        );
      } else if (call.method === "PATCH" && call.url === "/api/v4/browsers/b1") {
        res.end(JSON.stringify({ id: "b1", status: "stopped" }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { calls, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

// A stand-in playwright-core so the daemon can run without a real browser.
function fakePlaywright(dir: string) {
  const mod = join(dir, "node_modules", "playwright-core");
  mkdirSync(mod, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(
    join(mod, "index.js"),
    `const fs = require("node:fs");
let current = "about:blank";
const page = {
  url: () => current,
  goto: async (u) => { current = u; },
  title: async () => "Fake " + current,
  screenshot: async ({ path }) => fs.writeFileSync(path, "png"),
};
const context = { pages: () => [page], newPage: async () => page };
exports.chromium = {
  connectOverCDP: async (url) => {
    if (url !== "ws://fake-cdp/devtools/browser/x") throw new Error("unexpected cdp url " + url);
    return { contexts: () => [context], on() {}, newContext: async () => context };
  },
};
`,
  );
}

function run(args: string[], env: Record<string, string | undefined>, input?: string) {
  return new Promise<{ code: number | null; out: Record<string, unknown> }>((resolve) => {
    const clean = { ...process.env };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "BROWSER_USE_API_KEY"]) delete clean[k];
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...clean, ...env } });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stdin.end(input ?? "");
    child.on("close", (code) => {
      const last = stdout.trim().split("\n").at(-1) ?? "{}";
      resolve({ code, out: JSON.parse(last) });
    });
  });
}

function sandbox(api: { base: string }, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "browse-skill-"));
  fakePlaywright(join(dir, "cache"));
  const env = {
    BROWSER_USE_API_BASE: api.base,
    BROWSER_USE_API_KEY: "bu_test",
    QM_BROWSE_DIR: join(dir, "run"),
    QM_BROWSE_CACHE: join(dir, "cache"),
    ...extra,
  };
  return { dir, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("preflight explains a missing, rejected, or empty Browser Use key", async () => {
  const cases: Array<[{ status: number; body?: unknown }, string | null, boolean]> = [
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

test("open keeps one page alive across eval calls and stop stops the cloud browser", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    const opened = await run(["open", "--country", "none", "--profile", "p-1"], box.env);
    assert.equal(opened.out.ok, true, JSON.stringify(opened.out));
    assert.equal(opened.out.liveUrl, "https://live.test/b1");
    const create = api.calls.find((c) => c.method === "POST");
    assert.deepEqual(create?.body, { proxyCountryCode: null, profileId: "p-1" });

    const nav = await run(["eval", "await page.goto('https://example.com'); return await page.title()"], box.env);
    assert.equal(nav.out.result, "Fake https://example.com");
    await run(["eval", "-"], box.env, "state.n = 41");
    const kept = await run(["eval", "state.n + 1"], box.env);
    assert.equal(kept.out.result, "42");
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
    await run(["stop"], box.env);
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
