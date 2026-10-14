import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuotedReply } from "../src/quoted-reply.ts";

test("splits a quote-then-answer reply into its opening and quoted points", () => {
  const reply = parseQuotedReply(
    "Opening line.\n\n> first point\n> continues\n\nAnswer one.\n\n**Fix:** a\n\n> second point\n\nAnswer two.",
  );
  assert.deepEqual(reply, {
    intro: "Opening line.",
    points: [
      { quote: "first point\ncontinues", answer: "Answer one.\n\n**Fix:** a" },
      { quote: "second point", answer: "Answer two." },
    ],
  });
});

test("needs at least two answered quotes, and ignores quotes inside code fences", () => {
  assert.equal(parseQuotedReply("> only one\n\nanswer"), null);
  assert.equal(parseQuotedReply("> a\n> b\n\nanswer"), null);
  assert.equal(parseQuotedReply("```\n> a\nx\n> b\ny\n```"), null);
  assert.equal(parseQuotedReply("> a\n\n> b\n\nanswer"), null);
});
