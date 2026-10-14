import { pathToFileURL } from "node:url";
import { ensurePlaywright } from "./playwright-runtime.mjs";
import { installBrowserHistory } from "./browser-history.mjs";
import { startBrowserProxy } from "./browser-proxy.mjs";
import { installBrowserCompatibility } from "./browser-compat.mjs";
import { installBrowserFiles } from "./browser-files.mjs";
import { installBrowserUploads } from "./browser-upload.mjs";

export async function startBrowserService(cdpUrl, options = {}) {
  const modulePath = await ensurePlaywright();
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const proxy = await startBrowserProxy(cdpUrl, modulePath);
  const disposers = [];
  let browser;
  let stopping;
  const close = () =>
    (stopping ??= (async () => {
      const errors = [];
      const steps = [() => browser?.unbind(), () => browser?.close(), ...disposers.toReversed(), () => proxy.close()];
      for (const step of steps) {
        try {
          await step();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "Browser service cleanup failed");
    })());
  try {
    browser = await chromium.connectOverCDP(proxy.endpoint, {
      timeout: 30000,
      noDefaults: options.provider === true,
    });
    disposers.push(await installBrowserHistory(browser, modulePath));
    let capabilities = {};
    if (options.provider) {
      const { dispose, ...details } = await installBrowserCompatibility(browser, modulePath);
      disposers.push(dispose);
      capabilities = details;
      disposers.push(await installBrowserFiles(browser, { browserId: options.browserId, api: options.api }));
      disposers.push(await installBrowserUploads(browser, modulePath));
    }
    const { endpoint } = await browser.bind(options.title || "qm-browse", { host: "127.0.0.1", port: 0 });
    return { endpoint, browser, modulePath, capabilities, close, on: browser.on.bind(browser) };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Browser service startup and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
