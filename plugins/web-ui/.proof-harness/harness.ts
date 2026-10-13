import { render } from "lit";
import { createSwarmStrip } from "../src/swarm-strip.ts";

const ROOT = "11111111-aaaa-4aaa-8aaa-111111111111";
const AUDITOR = "22222222-bbbb-4bbb-8bbb-222222222222";
const PROBER = "33333333-cccc-4ccc-8ccc-333333333333";
const MIN = 60_000;
const expired = location.hash.includes("expired");

const view = {
  id: ROOT,
  self: {
    id: ROOT,
    threadRef: "web:pcapriolo:root",
    depth: 0,
    context: {},
    state: "ready",
    attempts: 0,
    sessionId: "root-session",
  },
  peers: [
    {
      id: ROOT,
      threadRef: "web:pcapriolo:root",
      depth: 0,
      context: {},
      state: "ready",
      attempts: 0,
      sessionId: "root-session",
    },
    {
      id: AUDITOR,
      parentId: ROOT,
      threadRef: `swarm:${ROOT}:${AUDITOR}`,
      depth: 1,
      sessionId: "a7f1c204-9e55-4f0b-9a3d-auditor",
      sandboxId: "c31d90ab-5e77-4a21-9f02-auditorbox",
      context: { slice: "auth/session/sso", commit: "fd5b3a3", phase: "verify" },
      state: "ready",
      attempts: 0,
    },
    {
      id: PROBER,
      parentId: ROOT,
      threadRef: `swarm:${ROOT}:${PROBER}`,
      depth: 1,
      sessionId: "b2c9e731-0d44-4a18-8b77-prober",
      sandboxId: "e8a40f12-6b33-4c55-8d19-proberbox",
      context: { slice: "webhooks/signatures", commit: "fd5b3a3", phase: "breadth" },
      state: "ready",
      attempts: 0,
      control: "paused",
    },
  ],
  board: { sandboxId: "4d6f8a11-7c2e-4f90-9b3a-boardbox" },
  backend: "modal",
  model: "claude-opus-5",
  settings: {},
  expiresAt: expired ? Date.now() - 37 * MIN : Date.now() + 42 * MIN,
};

const board = [
  {
    id: "m-1",
    seq: 1,
    senderId: ROOT,
    senderSessionId: "root-session",
    author: "human",
    actorId: "pcapriolo@ycombinator.com",
    text: "Take one slice each and post anything that crosses a trust boundary.",
    audience: [ROOT, AUDITOR, PROBER],
    createdAt: Date.now() - 31 * MIN,
    notifications: {},
  },
  {
    id: "m-2",
    seq: 2,
    senderId: AUDITOR,
    senderSessionId: "a7f1c204-9e55-4f0b-9a3d-auditor",
    author: "agent",
    actorId: "pcapriolo@ycombinator.com",
    text: "set_auth has no browser-bound nonce; the IP/UA binding is logged but never enforced.",
    audience: [ROOT, AUDITOR, PROBER],
    createdAt: Date.now() - 24 * MIN,
    notifications: {},
  },
  {
    id: "m-3",
    seq: 3,
    senderId: PROBER,
    senderSessionId: "b2c9e731-0d44-4a18-8b77-prober",
    author: "agent",
    actorId: "pcapriolo@ycombinator.com",
    text: "That chains with mine: the relay forwards the raw body under a fixed header, so a reader of your cookie reaches the same write path.",
    audience: [AUDITOR],
    replyTo: "m-2",
    createdAt: Date.now() - 19 * MIN,
    notifications: {},
  },
  {
    id: "m-4",
    seq: 4,
    senderId: AUDITOR,
    senderSessionId: "a7f1c204-9e55-4f0b-9a3d-auditor",
    author: "agent",
    actorId: "pcapriolo@ycombinator.com",
    text: "Agreed — filing the two as one chain rather than separate findings.",
    audience: [ROOT, AUDITOR, PROBER],
    replyTo: "m-3",
    createdAt: Date.now() - 11 * MIN,
    notifications: {},
  },
];

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input), location.origin);
  const after = Number(url.searchParams.get("after") ?? 0);
  const body = url.searchParams.get("read") === "1" ? { messages: board.filter((m) => m.seq > after) } : view;
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const host = document.querySelector("#app")!;
const holder = { draw: (): void => {} };
const panel = createSwarmStrip(() => holder.draw());
holder.draw = (): void => void render(panel.strip("root-session") as never, host);
holder.draw();
setTimeout(() => {
  (host.querySelector(".bg-activity-strip") as HTMLButtonElement | null)?.click();
}, 300);
