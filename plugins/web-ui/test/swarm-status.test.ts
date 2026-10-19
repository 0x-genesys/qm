import assert from "node:assert/strict";
import { test } from "node:test";

import { needsRefresh, statuses, summary, type SwarmPeer, type SwarmView } from "../src/swarm-status.ts";

const NOW = Date.parse("2026-10-18T12:00:00Z");

function swarm(workers: Array<Partial<SwarmPeer>>, expiresAt?: number): SwarmView {
  const root: SwarmPeer = { id: "root", state: "ready", depth: 0 };
  const peers = [
    root,
    ...workers.map((worker, index) => ({
      id: `w${index}`,
      parentId: "root",
      state: "ready" as const,
      depth: 1,
      ...worker,
    })),
  ];
  return { id: "root", self: root, peers, ...(expiresAt === undefined ? {} : { expiresAt }) };
}

const label = (view: SwarmView) => summary(view, statuses(view, NOW));

test("idle workers are not reported as active", () => {
  assert.equal(label(swarm(Array.from({ length: 8 }, () => ({})))), "8 idle");
});

test("running workers are counted separately from idle ones", () => {
  const view = swarm([{ running: true }, { running: true }, {}, {}, {}, {}, {}, {}]);
  assert.equal(label(view), "2 running · 6 idle");
  const status = statuses(view, NOW);
  assert.equal(status.get("w0"), "running");
  assert.equal(status.get("w2"), "idle");
});

test("an expired swarm shows its workers as expired, not active", () => {
  const view = swarm([{ running: true }, {}, { control: "paused" }, { control: "stopped" }], NOW - 1);
  assert.equal(label(view), "1 stopped · 3 expired");
  assert.equal(needsRefresh(view, statuses(view, NOW)), false);
});

test("a swarm whose window has not passed is not expired", () => {
  assert.equal(label(swarm([{ running: true }, {}], NOW + 60_000)), "1 running · 1 idle");
});

test("starting, paused, stopped and failed keep their own counts and ancestors' controls apply", () => {
  const view = swarm([{ state: "reserved" }, { control: "paused" }, { control: "stopped" }, { state: "failed" }, {}]);
  view.peers.push({ id: "child", parentId: "w1", state: "ready", depth: 2, running: true });
  assert.equal(label(view), "1 idle · 1 starting · 2 paused · 1 stopped · 1 failed");
});

test("polling continues while workers can work and stops once none can", () => {
  const live = swarm([{}]);
  assert.equal(needsRefresh(live, statuses(live, NOW)), true);
  const stopped = swarm([{ control: "stopped" }, { state: "failed" }]);
  assert.equal(needsRefresh(stopped, statuses(stopped, NOW)), false);
});
