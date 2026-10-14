import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import { collectSessionReadTiming, timeSessionRead } from "../src/sessions/read-timing.ts";

function stages(header: string | null): Map<string, number> {
  assert.ok(header);
  return new Map(
    header.split(", ").map((metric) => {
      const [name, duration] = metric.split(";dur=");
      const ms = Number(duration);
      assert.ok(name?.startsWith("qm_session_"));
      assert.ok(Number.isFinite(ms) && ms >= 0);
      return [name!.slice("qm_session_".length), ms];
    }),
  );
}

test("session HTTP reads expose executed stages without changing payloads or authorization", async (t) => {
  const built = buildApp(testConfig());
  const scope = scopeId("personal", "viewer");
  const session = await built.sessions.getOrCreateByThread("web:viewer:timing", "dm", scope, undefined, "web");
  await built.sessions.addParticipant(session.id, "viewer");
  const { lease } = await built.sessions.acquireLease(session.id);
  assert.ok(lease);
  await built.sessions.append(lease, { type: "user", payload: { text: "hello" }, scopeLabel: scope });
  await built.sessions.releaseLease(lease);
  await built.sessions.addPin(session.id, { entrySeq: 0, addedBy: "viewer" });
  const server = createInsecureTestServer(built.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const expected = await built.app.getSessionForViewer(session.id, "viewer", { tailTurns: 1 });
  const response = await fetch(`${base}/v1/sessions/${session.id}?viewer=viewer&tailTurns=1`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  const measured = stages(response.headers.get("server-timing"));
  for (const name of [
    "total",
    "acl",
    "continue",
    "transcript",
    "participant_windows",
    "latest_seq",
    "entries",
    "pins",
    "pin_previews",
  ])
    assert.ok(measured.has(name), name);
  assert.equal(measured.has("fallback"), false);
  assert.equal(measured.has("tape"), false);
  assert.ok(measured.get("total")! >= measured.get("transcript")!);

  t.mock.method(built.sessions, "getTranscriptEntries", async () => []);
  t.mock.method(built.sessions, "getTape", async () => []);
  const fallback = await fetch(`${base}/v1/sessions/${session.id}?viewer=viewer`);
  assert.equal(fallback.status, 200);
  assert.deepEqual(((await fallback.json()) as { entries: unknown }).entries, expected!.entries);
  const fallbackStages = stages(fallback.headers.get("server-timing"));
  for (const name of ["tape", "projection", "fallback"]) assert.ok(fallbackStages.has(name), name);

  const denied = await fetch(`${base}/v1/sessions/${session.id}?viewer=stranger`);
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), { error: "not_found" });
  assert.deepEqual([...stages(denied.headers.get("server-timing")).keys()].sort(), ["acl", "total"]);
});

test("session timings aggregate repeats and isolate overlapping request contexts", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = collectSessionReadTiming(async () => {
    await timeSessionRead("entries", async () => {
      now += 2;
      await waiting;
    });
    await timeSessionRead("entries", () => {
      now += 3;
    });
    return "first";
  });
  const second = await collectSessionReadTiming(() =>
    timeSessionRead("fallback", () => {
      now += 5;
      return "second";
    }),
  );
  release();
  const completed = await first;
  assert.equal(completed.value, "first");
  assert.equal(second.value, "second");
  assert.equal(stages(completed.header).get("entries"), 10);
  assert.equal(stages(completed.header).has("fallback"), false);
  assert.equal(stages(second.header).get("fallback"), 5);
  assert.equal(stages(second.header).has("entries"), false);
});
