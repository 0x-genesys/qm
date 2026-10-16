import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../runtime.js", import.meta.url), "utf8");

function runtime() {
  const window = {
    deskHost: {
      async request({ app }) {
        return {
          type: "observation",
          app,
          bundle_id: app,
          window: "Test window",
          frame: { w: 100, h: 100 },
          elements: 1,
          tree: "[1] TextField",
          diffed: false,
          removed: [],
        };
      },
    },
  };
  vm.runInNewContext(source, { window, console: {} });
  return window;
}

test("app notes emit once per bundle across App objects and output drains", async () => {
  const window = runtime();
  await window.computer.getApp("com.google.Chrome");
  assert.match(window.__drain().text, /App usage notes \(com\.google\.Chrome\)/);
  await window.computer.getApp("com.google.Chrome");
  assert.doesNotMatch(window.__drain().text, /App usage notes/);
  await window.computer.getApp("notion.id");
  assert.match(window.__drain().text, /App usage notes \(notion\.id\)/);
});

test("silent observations do not consume an app's one-time notes", async () => {
  const window = runtime();
  const app = await window.computer.getApp("com.tinyspeck.slackmacgap", { emit: false });
  assert.equal(window.__drain().text, "");
  await app.getAXState();
  assert.match(window.__drain().text, /App usage notes/);
  await app.getAXState();
  assert.doesNotMatch(window.__drain().text, /App usage notes/);
});

test("unknown apps have no invented notes, and a new runtime emits notes again", async () => {
  const window = runtime();
  await window.computer.getApp("test.unknown");
  assert.doesNotMatch(window.__drain().text, /App usage notes/);
  await window.computer.getApp("com.apple.finder");
  assert.match(window.__drain().text, /App usage notes/);
  const next = runtime();
  await next.computer.getApp("com.apple.finder");
  assert.match(next.__drain().text, /App usage notes/);
});
