import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const settings = readFileSync(new URL("../src/settings.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const glassCss = css.slice(css.indexOf("html.glass {"));

test("liquid glass is a theme that follows the system appearance", () => {
  assert.match(settings, /value: "glass", label: "Liquid glass"/);
  assert.match(settings, /stored === "light" \|\| stored === "dark" \|\| stored === "glass"/);
  assert.match(settings, /classList\.toggle\("glass", choice === "glass"\)/);
  assert.match(settings, /storedTheme\(\) === "system" \|\| storedTheme\(\) === "glass"/);
  assert.ok(glassCss.startsWith("html.glass {"));
  assert.equal(glassCss.includes("backdrop-filter"), false);
  assert.match(glassCss, /html\.glass\[data-qm-desktop="darwin"\]/);
  assert.match(glassCss, /prefers-reduced-transparency: reduce/);
});
