import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

export async function startBrowserProxy(cdpUrl, modulePath) {
  const { ws, wsServer, HttpsProxyAgent, getProxyForUrl } = createRequire(modulePath)("./lib/utilsBundle.js");
  const lookup = new URL(cdpUrl);
  if (lookup.protocol === "wss:") lookup.protocol = "https:";
  else if (lookup.protocol === "ws:") lookup.protocol = "http:";
  if (!getProxyForUrl(lookup.href)) return { endpoint: cdpUrl, async close() {} };
  let target = cdpUrl;
  if (lookup.protocol === new URL(cdpUrl).protocol) {
    lookup.pathname = lookup.pathname.replace(/\/$/, "") + "/json/version";
    const response = await fetch(lookup, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Browser WebSocket discovery failed: HTTP ${response.status}`);
    target = (await response.json()).webSocketDebuggerUrl;
  }
  const destination = new URL(target);
  if (!["ws:", "wss:"].includes(destination.protocol))
    throw new Error("Browser discovery did not return a WebSocket URL");
  destination.protocol = destination.protocol === "wss:" ? "https:" : "http:";
  const proxy = getProxyForUrl(destination.href);
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
  const path = `/${randomUUID()}`;
  const server = new wsServer({ host: "127.0.0.1", port: 0, path, maxPayload: 256 * 1024 * 1024 });
  const connections = new Set();
  server.on("connection", (client) => {
    const upstream = new ws(target, { agent, handshakeTimeout: 30000, maxPayload: 256 * 1024 * 1024 });
    connections.add(client);
    connections.add(upstream);
    for (const socket of [client, upstream]) socket.once("close", () => connections.delete(socket));
    const terminate = () => {
      client.terminate();
      upstream.terminate();
    };
    for (const [source, destination] of [
      [client, upstream],
      [upstream, client],
    ]) {
      source.once("error", terminate);
      source.once("close", terminate);
      source.on("message", (data, binary) => {
        source.pause();
        const send = () => destination.send(data, { binary }, (error) => (error ? terminate() : source.resume()));
        if (destination.readyState === ws.CONNECTING) destination.once("open", send);
        else send();
      });
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch (error) {
    server.close();
    agent?.destroy();
    throw error;
  }
  let closing;
  return {
    endpoint: `ws://127.0.0.1:${server.address().port}${path}`,
    close() {
      return (closing ??= new Promise((resolve, reject) => {
        for (const socket of connections) socket.terminate();
        server.close((error) => {
          agent?.destroy();
          if (error) reject(error);
          else resolve();
        });
      }));
    },
  };
}
