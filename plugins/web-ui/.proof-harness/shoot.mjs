import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const DIR = new URL(".", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer(async (req, res) => {
  const name = req.url === "/" || req.url.startsWith("/?") ? "index.html" : req.url.split("?")[0].replace(/^\//, "");
  try {
    const body = await readFile(join(DIR, name));
    res.writeHead(200, { "content-type": TYPES[extname(name)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("no");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 980, height: 1200 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

const shoot = async (hash, file, label) => {
  await page.goto(base + hash, { waitUntil: "load" });
  await page.waitForSelector(".swarm-activity", { timeout: 15000 });
  await page.waitForTimeout(2500);
  const panel = page.locator(".swarm-activity");
  await panel.screenshot({ path: `/workspace/factory/proof/${file}` });
  const text = (await panel.innerText()).replace(/\n+/g, " | ");
  console.log(`--- ${label} (${file}) ---`);
  console.log(text.slice(0, 900));
};

await shoot("", "ac1-ac2-live-tree-and-board.png", "live swarm: tree + board");
await shoot("#expired", "ac3-ac4-expired-transcript.png", "expired swarm: window note + frozen board");

await browser.close();
server.close();
