#!/usr/bin/env node
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync } from "node:fs";
import { request, createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { once } from "node:events";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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
const CACHE = process.env.QM_BROWSE_CACHE ?? join(homedir(), ".cache", "qm-browse");
const PLAYWRIGHT = "playwright-core@1.64.0";
const IDLE_MS = Number(process.env.QM_BROWSE_IDLE_MS ?? 15 * 60_000);
const MAX_OUTPUT = 50_000;

const print = (obj) => console.log(JSON.stringify(obj));
function fail(obj, code = 1) {
  print({ ok: false, ...obj });
  process.exit(code);
}
const paths = (session) => ({
  sock: join(DIR, `${session}.sock`),
  state: join(DIR, `${session}.json`),
  log: join(DIR, `${session}.log`),
});

async function api(method, path, body) {
  const init = { method, headers: { "X-Browser-Use-API-Key": KEY ?? "" } };
  if (body) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, init);
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
  if (r.status === 401 || r.status === 403) return { ok: false, reason: "key_rejected", status: r.status };
  if (r.status === 402) return { ok: false, reason: "no_credits", status: r.status };
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

function proxyFor(host) {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!raw) return null;
  const skip = (process.env.NO_PROXY || process.env.no_proxy || "").split(/[,\s]+/).filter(Boolean);
  const bypass = skip.some(
    (n) => n === "*" || host === n.replace(/^\./, "") || host.endsWith(`.${n.replace(/^\./, "")}`),
  );
  return bypass ? null : new URL(raw);
}

async function tunnel(proxy, host, port) {
  const secure = proxy.protocol === "https:";
  const sock = secure
    ? tlsConnect({ host: proxy.hostname, port: Number(proxy.port || 443), servername: proxy.hostname })
    : netConnect({ host: proxy.hostname, port: Number(proxy.port || 80) });
  await once(sock, secure ? "secureConnect" : "connect");
  const user = decodeURIComponent(proxy.username);
  const auth = user
    ? `Proxy-Authorization: Basic ${Buffer.from(`${user}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
    : "";
  sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
  const head = await new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("latin1");
      if (!buf.includes("\r\n\r\n")) return;
      sock.off("data", onData);
      sock.pause();
      resolve(buf);
    };
    sock.on("data", onData);
    sock.once("error", reject);
  });
  if (!/^HTTP\/1\.[01] 200/.test(head)) throw new Error(`proxy CONNECT failed: ${head.split("\r\n")[0]}`);
  const upstream = tlsConnect({ socket: sock, servername: host });
  await once(upstream, "secureConnect");
  return upstream;
}

async function cdpEndpoint(cdpUrl) {
  let ws = cdpUrl;
  if (/^https?:/.test(cdpUrl)) {
    const res = await fetch(new URL("/json/version", cdpUrl));
    ws = (await res.json()).webSocketDebuggerUrl;
  }
  const target = new URL(ws);
  const proxy = proxyFor(target.hostname);
  if (!proxy) return ws;
  const relay = createServer((_req, res) => res.writeHead(404).end());
  relay.on("upgrade", async (req, client, head) => {
    try {
      const upstream = await tunnel(proxy, target.hostname, Number(target.port || 443));
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        lines.push(`${name}: ${name.toLowerCase() === "host" ? target.host : req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(client).on("error", () => upstream.destroy());
      client.pipe(upstream).on("error", () => client.destroy());
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    } catch (err) {
      console.error(`relay failed: ${err.message}`);
      client.destroy();
    }
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  relay.unref();
  return `ws://127.0.0.1:${relay.address().port}${target.pathname}${target.search}`;
}

async function stopBrowser(id) {
  try {
    const r = await api("PATCH", `/api/v4/browsers/${encodeURIComponent(id)}`, { action: "stop" });
    return { stopped: (r.status >= 200 && r.status < 300) || r.status === 404, status: r.status, detail: r.json };
  } catch (err) {
    return { stopped: false, error: String(err?.cause?.message ?? err?.message ?? err) };
  }
}

function loadPlaywright() {
  const req = createRequire(join(CACHE, "package.json"));
  try {
    return req("playwright-core");
  } catch {
    mkdirSync(CACHE, { recursive: true });
    if (!existsSync(join(CACHE, "package.json"))) writeFileSync(join(CACHE, "package.json"), "{}\n");
    execFileSync("npm", ["install", "--prefix", CACHE, "--no-audit", "--no-fund", "--silent", PLAYWRIGHT], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    return req("playwright-core");
  }
}

function call(sock, path, body, timeoutMs = 120_000) {
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
  const p = paths(session);
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (existsSync(p.sock)) {
    const live = await call(p.sock, "/health", {}, 5_000).catch(() => null);
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
  loadPlaywright();

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
  child.unref();
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    if (existsSync(p.sock)) {
      const h = await call(p.sock, "/health", {}, 5_000).catch(() => null);
      if (h?.ok) {
        print({ ok: true, session, browserId: id, liveUrl, url: h.url });
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
  const p = paths(session);
  const { id, cdpUrl, liveUrl } = JSON.parse(readFileSync(p.state, "utf8"));
  let stopping = null;
  const shutdown = (why) =>
    (stopping ??= (async () => {
      console.error(`stopping browser ${id}: ${why}`);
      const s = await stopBrowser(id);
      if (!s.stopped) console.error(`stop failed: ${JSON.stringify(s)}`);
      rmSync(p.sock, { force: true });
      if (s.stopped) rmSync(p.state, { force: true });
      return s;
    })());

  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => shutdown(sig).then(() => process.exit(0)));
  let browser;
  try {
    const { chromium } = loadPlaywright();
    browser = await chromium.connectOverCDP(await cdpEndpoint(cdpUrl));
  } catch (err) {
    console.error(`connect failed: ${err.message}`);
    await shutdown("connect failed");
    process.exit(1);
  }
  browser.on("disconnected", () => shutdown("disconnected").then(() => process.exit(0)));
  const context = browser.contexts()[0] ?? (await browser.newContext());
  if (context.pages().length === 0) await context.newPage();
  const page = () => context.pages().at(-1);
  const state = {};
  const AsyncFunction = (async () => {}).constructor;

  let idle;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => shutdown("idle").then(() => process.exit(0)), IDLE_MS);
  };
  touch();

  const handlers = {
    "/health": async () => ({ ok: true, browserId: id, liveUrl, url: page()?.url() }),
    "/eval": async ({ code }) => {
      let fn;
      try {
        fn = new AsyncFunction("page", "context", "browser", "state", `return (${code}\n);`);
      } catch {
        fn = new AsyncFunction("page", "context", "browser", "state", code);
      }
      const value = await fn(page(), context, browser, state);
      let text = typeof value === "string" ? value : JSON.stringify(value ?? null);
      if (text === undefined) text = String(value);
      const truncated = text.length > MAX_OUTPUT;
      return { ok: true, result: truncated ? text.slice(0, MAX_OUTPUT) : text, truncated, url: page()?.url() };
    },
    "/screenshot": async ({ path }) => {
      const out = path || join(DIR, `${session}-${Date.now()}.png`);
      await page().screenshot({ path: out });
      return { ok: true, path: out, url: page()?.url() };
    },
    "/stop": async () => {
      const s = await shutdown("stop requested");
      setImmediate(() => process.exit(0));
      return { ok: s.stopped, browserId: id, ...s };
    },
  };

  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", async () => {
      touch();
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
    });
  });
  rmSync(p.sock, { force: true });
  server.listen(p.sock);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      session: { type: "string", default: "default" },
      profile: { type: "string" },
      country: { type: "string" },
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
    case "eval": {
      const code = arg === undefined || arg === "-" ? await readStdin() : arg;
      const r = await call(p.sock, "/eval", { code }).catch((err) =>
        fail({ error: `no open browser: ${err.message}` }),
      );
      print(r);
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case "screenshot": {
      const r = await call(p.sock, "/screenshot", { path: arg }).catch((err) =>
        fail({ error: `no open browser: ${err.message}` }),
      );
      print(r);
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case "stop": {
      const r = await call(p.sock, "/stop", {}, 30_000).catch(() => null);
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
          "usage: browser.mjs preflight | open [--profile ID] [--country us|none] | eval CODE|- | screenshot [PATH] | stop  (all accept --session NAME)",
      });
  }
}

await main();
