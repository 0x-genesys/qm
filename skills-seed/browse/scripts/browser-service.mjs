import { pathToFileURL } from "node:url";
import { ensurePlaywright } from "./playwright-runtime.mjs";
export async function startBrowserService(cdpUrl, options = {}) {
  const modulePath = await ensurePlaywright();
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const browser = await chromium.connectOverCDP(cdpUrl, {
    timeout: 30000,
    noDefaults: options.provider === true,
  });
  let stopping;
  const close = () =>
    (stopping ??= (async () => {
      try {
        await browser.unbind();
      } finally {
        await browser.close();
      }
    })());
  try {
    const { endpoint } = await browser.bind(options.title || "qm-browse", { host: "127.0.0.1", port: 0 });
    return { endpoint, browser, modulePath, close, on: browser.on.bind(browser) };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
