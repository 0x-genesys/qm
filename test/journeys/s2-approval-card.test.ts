import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fakeSprites } from "../support/auto-fake-sprites.ts";
import type { ModelRequest } from "./support/fake-gateway.ts";
import { journeyTestOptions, waitFor } from "./support/journey-app.ts";
import type { SlackPost } from "./support/fake-slack.ts";
import { BOT_USER, startSlackJourney, type SlackJourney } from "./support/slack-journey.ts";

const ASKER = "U1ASKER";
const CHANNEL = "C1TEAM";
const DM = "D1ASKER";

let tsSeq = 0;
const nextTs = () => `${Math.floor(Date.now() / 1000)}.${String(++tsSeq * 100).padStart(6, "0")}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Workspace {
  guest: string;
  host(): string;
}

function workspace(): Workspace {
  const guest = `/home/sprite/s2-${Math.random().toString(36).slice(2, 8)}`;
  return { guest, host: () => join(fakeSprites.homeDir(fakeSprites.names()[0]!), guest.slice("/home/sprite/".length)) };
}

function model(ws: () => Workspace) {
  return (req: ModelRequest) => {
    const last = JSON.stringify(req.messages.at(-1)?.content ?? "");
    const { guest } = ws();
    if (last.includes("SEEDED"))
      return {
        tool: "execute",
        input: {
          command: `rm -r ${guest}/build-cache && echo cleared >> ${guest}/runs.log && echo CACHE-CLEARED`,
          purpose: "Clear build cache",
        },
      };
    if (last.includes('"type":"tool_result"'))
      return {
        text: `Finished: ${last.includes("CACHE-CLEARED") ? "the build cache is cleared" : "nothing was removed"}.`,
      };
    if (last.includes("clear the build cache") && req.tools?.some((t) => t.name === "execute"))
      return {
        tool: "execute",
        input: {
          command: `mkdir -p ${guest}/build-cache && echo stale > ${guest}/build-cache/stale.bin && echo SEEDED`,
          purpose: "Find build cache",
        },
      };
    return { text: "ok" };
  };
}

function buttons(post: SlackPost): Array<{ action_id: string; value: string }> {
  const blocks = (post.blocks ?? []) as Array<{ elements?: Array<{ action_id?: string; value?: string }> }>;
  return blocks
    .flatMap((b) => b.elements ?? [])
    .filter((e): e is { action_id: string; value: string } => !!e.action_id);
}

async function askAndAwaitCard(h: SlackJourney): Promise<{ card: SlackPost; mention: string }> {
  const mention = nextTs();
  const before = h.slack.posts.length;
  await h.deliver({
    type: "app_mention",
    user: ASKER,
    channel: CHANNEL,
    channel_type: "channel",
    text: `<@${BOT_USER}> please clear the build cache`,
    ts: mention,
  });
  const card = await waitFor(
    async () => h.slack.posts.slice(before).find((p) => buttons(p).length > 0),
    "the approval card",
  );
  return { card: structuredClone(card), mention };
}

function click(h: SlackJourney, card: SlackPost, actionId: string, user = ASKER): Promise<void> {
  const action = buttons(card).find((b) => b.action_id === actionId);
  assert.ok(action, `the card offers ${actionId}: ${JSON.stringify(buttons(card))}`);
  return h.action({
    user: { id: user },
    channel: { id: card.channel },
    container: { type: "message", channel_id: card.channel, message_ts: card.ts, thread_ts: card.thread_ts },
    message: { ts: card.ts, thread_ts: card.thread_ts, text: card.text, blocks: card.blocks },
    trigger_id: "trigger",
    response_url: "https://hooks.example.com/actions/x",
    actions: [{ type: "button", action_id: actionId, value: action.value, block_id: "approval", action_ts: nextTs() }],
  });
}

function threadPosts(h: SlackJourney, mention: string): SlackPost[] {
  return h.slack.posts.filter((p) => p.channel === CHANNEL && p.thread_ts === mention);
}

function cardNow(h: SlackJourney, card: SlackPost): SlackPost {
  return h.slack.posts.find((p) => p.channel === card.channel && p.ts === card.ts)!;
}

const cleared = (h: SlackJourney, mention: string) =>
  threadPosts(h, mention).filter((p) => /build cache is cleared/.test(p.text ?? ""));

test(
  "S2: a risky command's approval card: Approve runs it once, Deny stops it",
  journeyTestOptions(180_000),
  async (t) => {
    const h = await startSlackJourney((slack) => {
      slack.users.set(ASKER, { id: ASKER, name: "asker", email: "asker@example.com" });
      slack.channels.set(CHANNEL, { id: CHANNEL, name: "team" });
      slack.channels.set(DM, { id: DM, name: "", is_im: true });
      slack.dmFor.set(ASKER, DM);
    });
    const resources = h.app.built.sandboxResources;
    const scope = `channel:${CHANNEL}` as const;
    const asAsker = resources.forTurn({ actorId: ASKER, scopeId: scope, isCurrent: async () => true });
    let ws = workspace();
    const fresh = async () => {
      ws = workspace();
      const computer = await asAsker.create(ASKER, scope, resources.defaultBackend());
      await asAsker.setDefault(ASKER, scope, computer.id);
    };
    h.app.gateway.respond = model(() => ws);
    try {
      await t.test(
        "the card goes to the requester's DM and Approve runs the command once, answering in the thread",
        async () => {
          await fresh();
          const { card, mention } = await askAndAwaitCard(h);
          assert.equal(card.channel, DM);
          assert.ok(existsSync(join(ws.host(), "build-cache/stale.bin")), "nothing runs before the click");
          await click(h, card, "hilo_allow_once");
          await waitFor(async () => cleared(h, mention).length > 0, "the result in the origin thread");
          assert.equal(existsSync(join(ws.host(), "build-cache")), false);
          assert.equal(readFileSync(join(ws.host(), "runs.log"), "utf8"), "cleared\n");
          assert.equal(buttons(cardNow(h, card)).length, 0, "the card no longer offers buttons");
          await click(h, card, "hilo_allow_once");
          await sleep(2_000);
          assert.equal(
            readFileSync(join(ws.host(), "runs.log"), "utf8"),
            "cleared\n",
            "a second click does not run it again",
          );
          assert.equal(cleared(h, mention).length, 1);
        },
      );

      await t.test("Deny leaves everything in place and tells the user", async () => {
        await fresh();
        const { card, mention } = await askAndAwaitCard(h);
        await click(h, card, "hilo_deny");
        await waitFor(async () => /denied/i.test(cardNow(h, card).text ?? ""), "the card to say it was denied");
        await sleep(2_000);
        assert.ok(existsSync(join(ws.host(), "build-cache/stale.bin")), "the cache is untouched");
        assert.equal(existsSync(join(ws.host(), "runs.log")), false, "the command never ran");
        assert.equal(cleared(h, mention).length, 0);
      });

      await t.test("an approval nobody clicks runs nothing and leaves no run stuck", async () => {
        await fresh();
        const { card, mention } = await askAndAwaitCard(h);
        await sleep(5_000);
        assert.ok(existsSync(join(ws.host(), "build-cache/stale.bin")));
        assert.equal(existsSync(join(ws.host(), "runs.log")), false);
        assert.equal(cleared(h, mention).length, 0);
        assert.ok(buttons(cardNow(h, card)).length > 0, "the card still offers its buttons");
        const pending = (await h.app.built.runs.list()).filter((r) => r.status === "pending");
        assert.deepEqual(
          pending.map((r) => r.id),
          [],
        );
      });
    } finally {
      await h.stop();
    }
  },
);
