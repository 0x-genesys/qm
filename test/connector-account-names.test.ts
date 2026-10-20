import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeychain, type KeychainCredential } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { isAccountType, orderAccountNames, parseAccountName } from "../src/connectors/oauth.ts";
import { connectorAccountNames } from "../src/credentials/connector-accounts.ts";
import { tokenFor } from "../src/loops/sources/adapter.ts";

const keychain = () =>
  createKeychain({
    creds: createMemoryMap<KeychainCredential>(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("test-connector-key-aaaaaaaaaaaaaaaa"),
  });

test("account names: built-in slots, workspace and email names pass; unsafe or oversized names fail", () => {
  for (const name of ["default", "personal", "company", "ycf2026", "acme-eng", "ops@example.com", "a", "x".repeat(64)])
    assert.equal(isAccountType(name), true, name);
  for (const name of ["", "x".repeat(65), "Ops", "-a", "a-", "a b", "a:b", "a/b", "../x", "a\u0000", "é", 1, null])
    assert.equal(isAccountType(name), false, String(name));
  assert.equal(parseAccountName("  Ops@Example.COM "), "ops@example.com");
  assert.equal(parseAccountName("bad slot"), null);
  assert.equal(parseAccountName(undefined), null);
});

test("orderAccountNames puts preferred slots first, then other valid names alphabetically, once each", () => {
  assert.deepEqual(orderAccountNames(["zeta", "company", "alpha", "zeta", "Bad Name"]), [
    "default",
    "personal",
    "company",
    "alpha",
    "zeta",
  ]);
  assert.deepEqual(orderAccountNames(["b@x.io"], ["personal", "default"]), ["personal", "default", "b@x.io"]);
});

test("connectorAccountNames lists a principal's named accounts per host from the keychain inventory", async () => {
  const kc = keychain();
  await kc.setConnectorToken("slack.com", "U1", { accessToken: "a", accountType: "ycf2026" }, "ycf2026");
  await kc.setConnectorToken("slack.com", "U1", { accessToken: "b", accountType: "acme-eng" }, "acme-eng");
  await kc.setConnectorToken("slack.com", "U1", { accessToken: "c" }, "personal");
  await kc.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "d", accountType: "a@b.io" }, "a@b.io");
  await kc.setConnectorToken("slack.com", "U2", { accessToken: "e", accountType: "other" }, "other");

  assert.deepEqual(await connectorAccountNames(kc, "slack.com", "U1"), [
    "default",
    "personal",
    "company",
    "acme-eng",
    "ycf2026",
  ]);
  assert.deepEqual(await connectorAccountNames(kc, "gmail.googleapis.com", "U1"), [
    "default",
    "personal",
    "company",
    "a@b.io",
  ]);
  assert.deepEqual(await connectorAccountNames({}, "slack.com", "U1"), ["default", "personal", "company"]);
  assert.equal(await kc.connectorAccessToken("slack.com", "U1", "ycf2026"), "a");
  assert.equal(await kc.connectorAccessToken("slack.com", "U1", "acme-eng"), "b");
});

test("loop token selection keeps the built-in order and falls back to a named account", async () => {
  const kc = keychain();
  assert.equal(await tokenFor(kc, "slack.com", "U1"), null);
  await kc.setConnectorToken("slack.com", "U1", { accessToken: "named", accountType: "ycf2026" }, "ycf2026");
  assert.equal(await tokenFor(kc, "slack.com", "U1"), "named");
  await kc.setConnectorToken("slack.com", "U1", { accessToken: "company" }, "company");
  assert.equal(await tokenFor(kc, "slack.com", "U1"), "company");
  await kc.setConnectorToken("slack.com", "U1", { accessToken: "default" });
  assert.equal(await tokenFor(kc, "slack.com", "U1"), "default");
  await kc.setConnectorToken("slack.com", "U1", { accessToken: "personal" }, "personal");
  assert.equal(await tokenFor(kc, "slack.com", "U1"), "personal");
});
