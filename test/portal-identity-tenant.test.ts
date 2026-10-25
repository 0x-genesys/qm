import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

process.env.CORE_ORG_ID = "tenant-alpha";
const { mintPortalIdentity, verifyPortalIdentity } = await import("../plugins/chassis/src/portal-identity.ts");

const secret = "portal-identity-tenant-secret";
const now = 1_000_000;

test("the portal stamps its configured tenant on every identity it mints", () => {
  const token = mintPortalIdentity({ p: "alice@example.com", exp: now + 60_000 }, secret);
  assert.deepEqual(verifyPortalIdentity(token, secret, now), {
    p: "alice@example.com",
    t: "tenant-alpha",
    exp: now + 60_000,
  });
});

test("a plugin refuses an identity minted for a different tenant", () => {
  const payload = Buffer.from(JSON.stringify({ p: "alice@example.com", t: "tenant-beta", exp: now + 60_000 })).toString(
    "base64url",
  );
  const forged = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  assert.equal(verifyPortalIdentity(forged, secret, now), null);
});
