import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresRateLimiter } from "../src/ratelimit/postgres-rate-limiter.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("rate limits are principal-scoped and reset after the window", async () => {
  let now = 1_000;
  const limiter = createPostgresRateLimiter(testDatabaseUrl(), { maxPerWindow: 2, windowMs: 60_000, now: () => now });
  assert.equal((await limiter.check("alice")).allowed, true);
  assert.equal((await limiter.check("alice")).allowed, true);
  assert.equal((await limiter.check("alice")).allowed, false);
  assert.equal((await limiter.check("bob")).allowed, true);
  now += 60_000;
  assert.equal((await limiter.check("alice")).allowed, true);
});
