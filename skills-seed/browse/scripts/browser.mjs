#!/usr/bin/env node
import { spawn, spawnSync, fork } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync, chmodSync } from "node:fs";
import { request, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBrowserService } from "./browser-service.mjs";
import { ensurePlaywright } from "./playwright-runtime.mjs";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
  });
  process.exit(r.status ?? 1);
}
const API = (process.env.BROWSER_USE_API_BASE ?? "https://api.browser-use.com").replace(/\/+$/, "");
const KEY = process.env.BROWSER_USE_API_KEY;
const DIR = process.env.QM_BROWSE_DIR ?? join(tmpdir(), "qm-browse");
const IDLE_MS = Number(process.env.QM_BROWSE_IDLE_MS ?? 15 * 60000);
const MAX_OUTPUT = 10_000;
const print = (obj) => console.log(JSON.stringify(obj));
function fail(obj, code = 1) {
  print({ ok: false, ...obj });
  process.exit(code);
}
const paths = (session) => ({
  sock: join(DIR, `${session}.sock`),
  state: join(DIR, `${session}.json`),
  log: join(DIR, `${session}.log`),
  lock: join(DIR, `${session}.lock`),
});
async function api(method, path, body) {
  const init = { method, headers: { "X-Browser-Use-API-Key": KEY ?? "" } };
  if (body) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, { ...init, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
async function preflight() {
  if (!KEY) return { ok: false, reason: "missing_key" };
  let r;
  try {
    r = await api("GET", "/api/v2/billing/account");
  } catch (err) {
    return { ok: false, reason: "unreachable", error: String(err?.cause?.message ?? err?.message ?? err) };
  }
  if (r.status === 401 || r.status === 403)
    return { ok: false, reason: "key_rejected", status: r.status, detail: r.json };
  if (r.status === 402) return { ok: false, reason: "no_credits", status: r.status, detail: r.json };
  if (r.status !== 200) return { ok: false, reason: "api_error", status: r.status, detail: r.json };
  const balanceUsd = r.json?.totalCreditsBalanceUsd;
  if (typeof balanceUsd === "number" && balanceUsd <= 0) return { ok: false, reason: "no_credits", balanceUsd };
  return {
    ok: true,
    balanceUsd,
    activeSessions: r.json?.activeSessionCount,
    sessionLimit: r.json?.concurrentSessionLimit,
  };
}
async function cdpEndpoint(cdpUrl) {
  if (!new URL(cdpUrl).protocol.startsWith("http")) return cdpUrl;
  const res = await fetch(new URL("/json/version", cdpUrl), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`CDP discovery failed: HTTP ${res.status}`);
  return (await res.json()).webSocketDebuggerUrl;
}

async function stopBrowser(id) {
  try {
    const r = await api("PATCH", `/api/v4/browsers/${encodeURIComponent(id)}`, { action: "stop" });
    return { stopped: (r.status >= 200 && r.status < 300) || r.status === 404, status: r.status, detail: r.json };
  } catch (err) {
    return { stopped: false, error: String(err?.cause?.message ?? err?.message ?? err) };
  }
}
function call(sock, path, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body ?? {});
    const req = request(
      { socketPath: sock, path, method: "POST", headers: { "content-type": "application/json" }, timeout: timeoutMs },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve({ ok: false, error: text });
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`daemon did not answer within ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(data);
  });
}
function readStdin() {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (text += c));
    process.stdin.on("end", () => resolve(text));
  });
}
async function open(session, values) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const lock = paths(session).lock;
  try {
    const fd = openSync(lock, "wx", 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const pid = Number(readFileSync(lock, "utf8"));
    try {
      process.kill(pid, 0);
    } catch (alive) {
      if (alive.code === "ESRCH") {
        rmSync(lock);
        return open(session, values);
      }
    }
    fail({ error: `session "${session}" is opening; wait for that command to finish` });
  }
  const release = () => rmSync(lock, { force: true });
  process.once("exit", release);
  try {
    return await openLocked(session, values);
  } finally {
    process.off("exit", release);
    release();
  }
}
async function openLocked(session, values) {
  const p = paths(session);
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (existsSync(p.sock)) {
    const live = await call(p.sock, "/health", {}, 5000).catch(() => null);
    if (live?.ok) fail({ error: `session "${session}" is already open; stop it first`, liveUrl: live.liveUrl });
  }
  const pre = await preflight();
  if (!pre.ok) fail(pre, 2);
  if (existsSync(p.state)) {
    const stale = JSON.parse(readFileSync(p.state, "utf8"));
    const s = await stopBrowser(stale.id);
    if (!s.stopped) fail({ reason: "stale_browser_not_stopped", browserId: stale.id, ...s });
    rmSync(p.state, { force: true });
  }
  await ensurePlaywright();
  const country = values.country ?? "us";
  const body = { proxyCountryCode: country === "none" ? null : country };
  if (values.profile) body.profileId = values.profile;
  const created = await api("POST", "/api/v4/browsers", body);
  if (created.status !== 200 && created.status !== 201) {
    fail({ reason: "create_failed", status: created.status, detail: created.json }, created.status === 402 ? 2 : 1);
  }
  const { id, cdpUrl, liveUrl } = created.json;
  writeFileSync(p.state, JSON.stringify({ id, cdpUrl, liveUrl }), { mode: 0o600 });
  rmSync(p.sock, { force: true });
  const log = openSync(p.log, "w");
  const child = spawn(process.execPath, [process.argv[1], "__daemon", "--session", session], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  closeSync(log);
  child.unref();
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    if (existsSync(p.sock)) {
      const h = await call(p.sock, "/health", {}, 5000).catch(() => null);
      if (h?.ok) {
        print({ ok: true, session, browserId: id, liveUrl, tabs: h.tabs });
        return;
      }
    }
    if (child.exitCode !== null) break;
  }
  if (child.exitCode === null) process.kill(child.pid, "SIGTERM");
  const s = await stopBrowser(id);
  if (s.stopped) rmSync(p.state, { force: true });
  const tail = existsSync(p.log) ? readFileSync(p.log, "utf8").slice(-2000) : "";
  fail({ reason: "connect_failed", browserId: id, stop: s, log: tail });
}
async function daemon(session) {
  process.umask(0o077);
  const p = paths(session);
  const { id, cdpUrl, liveUrl } = JSON.parse(readFileSync(p.state, "utf8"));
  let stopping = null;
  let worker;
  let browser;
  const shutdown = (why) =>
    (stopping ??= Promise.resolve().then(async () => {
      worker?.kill("SIGKILL");
      try {
        await browser?.close();
      } catch (error) {
        console.error(`browser disconnect failed: ${error.message}`);
      }
      console.error(`stopping browser ${id}: ${why}`);
      const s = await stopBrowser(id);
      if (!s.stopped) console.error(`stop failed: ${JSON.stringify(s)}`);
      rmSync(p.sock, { force: true });
      if (s.stopped) rmSync(p.state, { force: true });
      return s;
    }));
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => shutdown(sig).then(() => process.exit(0)));
  try {
    browser = await startBrowserService(await cdpEndpoint(cdpUrl), { provider: true, browserId: id, api });
  } catch (err) {
    console.error(`connect failed: ${err.message}`);
    await shutdown("connect failed");
    process.exit(1);
  }
  browser.on("disconnected", () => {
    if (!stopping) shutdown("disconnected").then(() => process.exit(0));
  });
  const listTabs = async () =>
    Promise.all(
      browser.browser
        .contexts()
        .flatMap((context) => context.pages())
        .map(async (page) => ({
          id: page._guid,
          url: page.url(),
          title: await page.title().catch(() => ""),
        })),
    );
  if (!(await listTabs()).length) {
    const context = browser.browser.contexts()[0] ?? (await browser.browser.newContext());
    await context.newPage();
  }
  const modulePath = await ensurePlaywright();
  worker = fork(fileURLToPath(new URL("./js-runtime.mjs", import.meta.url)), [browser.endpoint, modulePath], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  let pendingJs;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const readyTimer = setTimeout(
    () => readyReject(new Error("JavaScript browser client initialization timed out")),
    30_000,
  );
  worker.on("message", (message) => {
    if (message.type === "ready") {
      clearTimeout(readyTimer);
      readyResolve();
    } else if (message.type === "result" && pendingJs?.id === message.id) {
      clearTimeout(pendingJs.timer);
      const { resolve } = pendingJs;
      pendingJs = null;
      resolve(message);
    }
  });
  worker.on("exit", () => {
    clearTimeout(readyTimer);
    readyReject(new Error("JavaScript browser client exited during initialization"));
    if (stopping) return;
    if (pendingJs) {
      clearTimeout(pendingJs.timer);
      pendingJs.resolve({ error: "JavaScript process exited; browser stopped" });
      pendingJs = null;
    }
    shutdown("JavaScript process exited").then(() => process.exit(1));
  });
  try {
    await ready;
  } catch (error) {
    console.error(error.message);
    await shutdown("JavaScript browser client initialization failed");
    process.exit(1);
  }
  let sequence = 0;
  const runJs = (code, timeoutMs = 90_000) =>
    new Promise((resolve) => {
      const id = ++sequence;
      const timer =
        timeoutMs === 0
          ? null
          : setTimeout(() => {
              pendingJs = null;
              resolve({
                error: `JavaScript exceeded ${timeoutMs / 1000} seconds; browser stopped. Inspect before retrying any action.`,
              });
              worker.kill("SIGKILL");
            }, timeoutMs);
      pendingJs = { id, resolve, timer };
      worker.send({ type: "js", id, code });
    });
  let idle;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => shutdown("idle").then(() => process.exit(0)), IDLE_MS);
  };
  touch();
  const handlers = {
    "/health": async () => ({ ok: true, browserId: id, liveUrl, tabs: await listTabs() }),
    "/js": async ({ code, timeoutMs = 90_000 }) => {
      if (typeof code !== "string" || code.length > 50_000)
        throw new Error("code must be a string under 50,000 characters");
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error("timeoutMs must be a nonnegative integer");
      const { result, output, error } = await runJs(code, timeoutMs);
      const failed = error !== undefined;
      const text = String(error ?? result ?? "undefined");
      const resultText = text.slice(0, MAX_OUTPUT);
      const consoleText = (output ?? "").slice(0, MAX_OUTPUT - resultText.length);
      return {
        ok: !failed,
        ...(failed ? { error: resultText } : { result: resultText }),
        output: consoleText,
        truncated: text.length + (output?.length ?? 0) > MAX_OUTPUT,
      };
    },
    "/screenshot": async ({ path }) => {
      const out = path || join(DIR, `${session}-${Date.now()}.png`);
      const { result, error } = await runJs(`await tab.screenshot(${JSON.stringify(out)})`);
      if (error !== undefined) throw new Error(error);
      return { ok: true, path: result };
    },
    "/stop": async () => {
      const s = await shutdown("stop requested");
      setImmediate(() => process.exit(0));
      return { ok: s.stopped, browserId: id, ...s };
    },
  };
  let queue = Promise.resolve();
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => {
      text += c;
      if (text.length > 100000) req.destroy();
    });
    req.on("end", () => {
      const handle = async () => {
        if (res.destroyed || stopping) return res.destroy();
        clearTimeout(idle);
        let body;
        try {
          const handler = handlers[req.url];
          if (!handler) throw new Error(`unknown command ${req.url}`);
          body = await handler(JSON.parse(text || "{}"));
        } catch (err) {
          body = { ok: false, error: String(err?.stack ?? err) };
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
        touch();
      };
      if (req.url === "/stop") void handle();
      else
        queue = queue.then(handle).catch((err) => {
          console.error(err.message);
          res.destroy();
          touch();
        });
    });
  });
  rmSync(p.sock, { force: true });
  server.listen(p.sock, () => chmodSync(p.sock, 0o600));
}
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      session: { type: "string", default: "default" },
      profile: { type: "string" },
      country: { type: "string" },
      "timeout-ms": { type: "string" },
    },
  });
  const [cmd, arg] = positionals;
  const session = values.session;
  if (!/^[\w-]{1,64}$/.test(session)) fail({ error: "session must be letters, digits, - or _" });
  const p = paths(session);
  switch (cmd) {
    case "preflight": {
      const r = await preflight();
      print(r);
      process.exit(r.ok ? 0 : 2);
      break;
    }
    case "open":
      return open(session, values);
    case "__daemon":
      return daemon(session);
    case "js": {
      const code = arg === undefined || arg === "-" ? await readStdin() : arg;
      const timeoutMs = Number(values["timeout-ms"] ?? 90_000);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
        fail({ error: "timeout-ms must be a nonnegative integer" });
      const r = await call(p.sock, "/js", { code, timeoutMs }, timeoutMs === 0 ? 0 : timeoutMs + 30_000).catch((err) =>
        fail({ error: existsSync(p.sock) ? `daemon call failed: ${err.message}` : `no open browser: ${err.message}` }),
      );
      print(r);
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case "screenshot": {
      const r = await call(p.sock, "/screenshot", { path: arg }).catch((err) =>
        fail({ error: existsSync(p.sock) ? `daemon call failed: ${err.message}` : `no open browser: ${err.message}` }),
      );
      print(r);
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case "stop": {
      const r = await call(p.sock, "/stop", {}, 30000).catch((err) => {
        if (existsSync(p.sock)) console.error(`daemon unreachable, stopping directly: ${err.message}`);
        return null;
      });
      if (r?.ok) return print(r);
      if (r) console.error(`daemon stop failed: ${JSON.stringify(r)}`);
      if (!existsSync(p.state)) return print({ ok: true, stopped: false, note: "no open browser" });
      const { id } = JSON.parse(readFileSync(p.state, "utf8"));
      const s = await stopBrowser(id);
      rmSync(p.sock, { force: true });
      if (s.stopped) rmSync(p.state, { force: true });
      print({ ok: s.stopped, browserId: id, ...s });
      process.exit(s.stopped ? 0 : 1);
      break;
    }
    default:
      fail({
        error:
          "usage: browser.mjs preflight | open [--profile ID] [--country us|none] | js CODE|- | screenshot [PATH] | stop  (all accept --session NAME)",
      });
  }
}
await main();
