import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonbSafeStringify } from "../src/util/text.ts";

test("NUL characters are dropped for jsonb", () => {
  const out = jsonbSafeStringify({ name: "a\u0000b" });
  assert.equal(out, '{"name":"ab"}');
});

test("a lone high surrogate (emoji cut in half by slice) becomes U+FFFD", () => {
  const cut = "prefix 😀".slice(0, 8); // strands the high surrogate
  const out = JSON.parse(jsonbSafeStringify({ title: cut })) as { title: string };
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out.title), "no stranded surrogate survives");
  assert.ok(out.title.includes("\uFFFD"));
});

test("well-formed strings, keys, arrays, and nesting pass through untouched", () => {
  const value = {
    a: "hello 😀",
    list: ["x", { deep: "ok", ["__proto__"]: { retained: true } }],
    n: 3,
    b: true,
    z: null,
  };
  assert.equal(jsonbSafeStringify(value), JSON.stringify(value));
});

test("keys are sanitized too", () => {
  const out = jsonbSafeStringify({ ["k\u0000ey"]: 1 });
  assert.equal(out, '{"key":1}');
});

test("values with a JSON form keep it while their strings are still cleaned", () => {
  const at = new Date(Date.UTC(2026, 9, 20));
  assert.equal(
    jsonbSafeStringify({ at, tags: new Set(["x"]), note: { toJSON: () => "a\u0000b" } }),
    '{"at":"2026-10-20T00:00:00.000Z","tags":{},"note":"ab"}',
  );
});
