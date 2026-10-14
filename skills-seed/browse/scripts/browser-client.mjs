import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
export function createBrowserClient(send) {
  const command = (method, tabId, params = {}) => send({ method, tabId, params });
  const textSelector = (text, exact = false) => `${JSON.stringify(String(text))}${exact ? "s" : "i"}`;
  function actionOptions(options) {
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== "timeoutMs")
    )
      throw new Error("Locator options support only timeoutMs");
    return options;
  }
  function locator(tabId, selector) {
    const action = (name, params = {}) => command(`locator.${name}`, tabId, { ...params, selector });
    return Object.freeze({
      click: (options = {}) => action("click", actionOptions(options)),
      fill: (value, options = {}) => action("fill", { ...actionOptions(options), value }),
      count: () => action("count"),
      textContent: () => action("textContent"),
      locator: (next) => locator(tabId, `${selector} >> ${next}`),
      getByRole: (role, options = {}) => locator(tabId, `${selector} >> ${roleSelector(role, options)}`),
      getByText: (text, options = {}) =>
        locator(tabId, `${selector} >> internal:text=${textSelector(text, options.exact)}`),
      nth: (index) => locator(tabId, `${selector} >> nth=${index}`),
      first: () => locator(tabId, `${selector} >> nth=0`),
    });
  }
  function roleSelector(role, { name, exact = false } = {}) {
    if (!/^[a-z]+$/.test(role)) throw new Error("role must be an ARIA role name");
    return `internal:role=${role}${name === undefined ? "" : `[name=${textSelector(name, exact)}]`}`;
  }
  function tab(id) {
    if (typeof id !== "string" || !id) throw new Error("tab id must be a nonempty string");
    return Object.freeze({
      id,
      goto: (url) => command("tab.goto", id, { url }),
      url: () => command("tab.url", id),
      title: () => command("tab.title", id),
      close: () => command("tabs.close", id),
      screenshot: async (path = join(tmpdir(), `browser-${randomUUID()}.png`)) => {
        if (typeof path !== "string") throw new Error("screenshot path must be a string");
        const data = await command("tab.screenshot", id);
        await writeFile(path, Buffer.from(data, "base64"));
        return path;
      },
      evaluate: (expression) => {
        if (typeof expression !== "string") throw new Error("evaluate expects a JavaScript expression string");
        return command("tab.evaluate", id, { expression });
      },
      playwright: Object.freeze({
        locator: (selector) => locator(id, selector),
        getByRole: (role, options) => locator(id, roleSelector(role, options)),
        getByText: (text, options = {}) => locator(id, `internal:text=${textSelector(text, options.exact)}`),
        domSnapshot: () => command("tab.snapshot", id),
        frameLocator: (selector) => locator(id, `${selector} >> internal:control=enter-frame`),
      }),
    });
  }
  return Object.freeze({
    tabs: Object.freeze({
      list: () => command("tabs.list"),
      get: tab,
      new: async (url) => tab((await command("tabs.new", undefined, { url })).id),
    }),
  });
}
