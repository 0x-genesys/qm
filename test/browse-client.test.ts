import assert from "node:assert/strict";
import { test } from "node:test";
const { createBrowserClient } = await import(
  new URL("../skills-seed/browse/scripts/browser-client.mjs", import.meta.url).href
);
test("browser client sends typed commands, never browser handles or functions", async () => {
  const commands: unknown[] = [];
  const browser = createBrowserClient(async (command: unknown) => {
    commands.push(command);
    return { id: "new-tab" };
  });
  const tab = browser.tabs.get("t1");
  await tab.playwright.getByRole("button", { name: 'Save "draft"', exact: true }).click();
  await tab.playwright.getByText("Hello").first().textContent();
  await tab.playwright.locator("input").fill("test");
  await tab.playwright.domSnapshot();
  await tab.evaluate("document.title");
  assert.deepEqual(commands, [
    { method: "locator.click", tabId: "t1", params: { selector: 'internal:role=button[name="Save \\"draft\\""s]' } },
    { method: "locator.textContent", tabId: "t1", params: { selector: 'internal:text="Hello"i >> nth=0' } },
    { method: "locator.fill", tabId: "t1", params: { selector: "input", value: "test" } },
    { method: "tab.snapshot", tabId: "t1", params: {} },
    { method: "tab.evaluate", tabId: "t1", params: { expression: "document.title" } },
  ]);
  assert.throws(() => browser.tabs.get(""), /tab id/);
  assert.throws(() => tab.evaluate(() => 1), /expression string/);
  assert.throws(() => tab.playwright.getByRole("button[name=oops]"), /ARIA role/);
  assert.equal((await browser.tabs.new("https://example.com")).id, "new-tab");
  assert.equal(tab.context, undefined);
  assert.equal(browser.close, undefined);
});
