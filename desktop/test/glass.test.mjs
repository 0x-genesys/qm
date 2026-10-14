import assert from "node:assert/strict";
import { test } from "node:test";
import { applyWindowGlass } from "../glass.mjs";

function page(extra = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => false,
    setVibrancy: (value) => calls.push(["vibrancy", value]),
    setBackgroundColor: (value) => calls.push(["background", value]),
    ...extra,
  };
}

test("liquid glass is a no-op off macOS", () => {
  const win = page();
  applyWindowGlass(win, "light", "win32");
  assert.deepEqual(win.calls, []);
});

test("Electron without liquid glass uses vibrancy, split by appearance", () => {
  const light = page();
  applyWindowGlass(light, "light", "darwin");
  assert.deepEqual(light.calls, [
    ["vibrancy", "under-window"],
    ["background", "#00000000"],
  ]);
  const dark = page();
  applyWindowGlass(dark, "dark", "darwin");
  assert.deepEqual(dark.calls, [
    ["vibrancy", "hud"],
    ["background", "#00000000"],
  ]);
  const off = page();
  applyWindowGlass(off, "off", "darwin");
  assert.deepEqual(off.calls, [
    ["vibrancy", null],
    ["background", "#f5f4f0"],
  ]);
});

test("macOS 26 liquid glass is used only when Electron reports it, and vibrancy is cleared first", () => {
  const calls = [];
  const win = page({
    isGlassEffectSupported: () => true,
    setGlassEffect: (value) => calls.push(["glass", value]),
    setVibrancy: (value) => calls.push(["vibrancy", value]),
    setBackgroundColor: (value) => calls.push(["background", value]),
  });
  applyWindowGlass(win, "light", "darwin");
  assert.deepEqual(calls, [
    ["vibrancy", null],
    ["glass", { style: "clear" }],
    ["background", "#00000000"],
  ]);
  calls.length = 0;
  applyWindowGlass(win, "dark", "darwin");
  assert.deepEqual(calls[1], ["glass", { style: "regular" }]);
  calls.length = 0;
  applyWindowGlass(win, "off", "darwin");
  assert.deepEqual(calls, [
    ["glass", null],
    ["vibrancy", null],
    ["background", "#f5f4f0"],
  ]);
});

test("an unsupported or failing liquid glass call falls back to vibrancy", () => {
  const unsupported = page({
    isGlassEffectSupported: () => false,
    setGlassEffect: () => {
      throw new Error("absent");
    },
  });
  applyWindowGlass(unsupported, "light", "darwin");
  assert.deepEqual(unsupported.calls, [
    ["vibrancy", "under-window"],
    ["background", "#00000000"],
  ]);
  const failing = page({
    isGlassEffectSupported: () => true,
    setGlassEffect: () => {
      throw new Error("nope");
    },
  });
  applyWindowGlass(failing, "dark", "darwin");
  assert.deepEqual(failing.calls, [
    ["vibrancy", null],
    ["vibrancy", "hud"],
    ["background", "#00000000"],
  ]);
});
