import { test } from "node:test";
import assert from "node:assert/strict";
import { isContinuable, slackThreadUrl } from "../src/core-bridge.ts";

test("own web sessions are continuable in any scope", () => {
  assert.equal(isContinuable({ threadRef: "web:alice:t1", scopeId: "personal:alice" }, { user: "alice" }), true);
  assert.equal(isContinuable({ threadRef: "web:alice:t1", scopeId: "channel:C1" }, { user: "alice" }), true);
});

test("a teammate's web session is continuable only when it lives in a shared scope", () => {
  assert.equal(isContinuable({ threadRef: "web:alice:t1", scopeId: "channel:C1" }, { user: "bob" }), true);
  assert.equal(isContinuable({ threadRef: "web:alice:t1", scopeId: "group:G1" }, { user: "bob" }), true);
  assert.equal(isContinuable({ threadRef: "web:alice:t1", scopeId: "personal:alice" }, { user: "bob" }), false);
});

test("Slack-anchored sessions are never continuable here", () => {
  assert.equal(isContinuable({ threadRef: "dm:D1", scopeId: "personal:alice" }, { user: "alice" }), false);
  assert.equal(
    isContinuable({ threadRef: "ch:C1:1699999999.000100", scopeId: "channel:C1" }, { user: "alice" }),
    false,
  );
});

test("slackThreadUrl builds archive permalinks from threadRefs", () => {
  const base = "https://acme.slack.com";
  assert.equal(slackThreadUrl(base, "ch:C0AB12CD3:1699999999.000100"), `${base}/archives/C0AB12CD3/p1699999999000100`);
  assert.equal(slackThreadUrl(base, "dm:D0AB12CD3"), `${base}/archives/D0AB12CD3`);
  assert.equal(slackThreadUrl(null, "dm:D0AB12CD3"), null, "no workspace URL → no link");
  assert.equal(slackThreadUrl(base, "web:alice:t1"), null, "web threadRefs are not Slack-linkable");
});

test("linked logins of one person can continue their own personal chats", () => {
  const me = { user: "oidc:bookface:42", person: "alice@example.com" };
  assert.equal(
    isContinuable({ threadRef: "web:alice@example.com:t1", scopeId: "personal:alice@example.com" }, me),
    true,
  );
  assert.equal(
    isContinuable({ threadRef: "web:oidc:bookface:42:t1", scopeId: "personal:alice@example.com" }, me),
    true,
  );
  assert.equal(isContinuable({ threadRef: "web:bob@example.com:t1", scopeId: "personal:bob@example.com" }, me), false);
  assert.equal(isContinuable({ threadRef: "dm:D1", scopeId: "personal:alice@example.com" }, me), false);
});
