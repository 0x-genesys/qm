import { test } from "node:test";
import assert from "node:assert/strict";

import { createDirectory, type BotIdentity } from "../src/slack/directory.ts";

const IDS: BotIdentity = {
  ownTeamId: "T-OWN",
  botUserId: "B-bot",
  ownBotId: "B-app",
  botHandle: "qm",
  ownWorkspaceUrl: "https://own.slack.com/",
  identityMode: "slack-id",
};

const CORE = {
  pushDirectory: async () => true,
  holdDirectorySync: (fn: (lost: Promise<void>) => Promise<unknown>) => fn(new Promise<void>(() => {})),
} as any;

function fakeClient(users: Array<Record<string, unknown>>) {
  return {
    paginate: () =>
      (async function* () {
        yield { members: users };
      })(),
    users: {
      info: async ({ user }: { user: string }) => ({ user: users.find((u) => u.id === user) }),
      list: async () => ({ members: users }),
    },
    conversations: {
      list: async () => ({ channels: [] }),
    },
  };
}

const guest = (id: string, email?: string) => ({
  id,
  team_id: "T-OWN",
  is_restricted: true,
  ...(email ? { profile: { email } } : {}),
});

test("an overridden guest classifies internal by Slack id while other guests stay external", async () => {
  const dir = createDirectory({
    core: CORE,
    ids: IDS,
    internalOverrides: async () => new Set(["u-contractor"]),
  });
  const client = fakeClient([guest("U-CONTRACTOR"), guest("U-STRANGER"), { id: "U-STAFF", team_id: "T-OWN" }]);
  const contractor = await dir.classifyUserCached(client, "U-CONTRACTOR");
  assert.equal(contractor.actor.isExternalGuest, false);
  const stranger = await dir.classifyUserCached(client, "U-STRANGER");
  assert.equal(stranger.actor.isExternalGuest, true);
  const staff = await dir.classifyUserCached(client, "U-STAFF");
  assert.ok(!staff.actor.isExternalGuest);
});

test("an overridden guest classifies internal by email even when the id differs", async () => {
  const dir = createDirectory({
    core: CORE,
    ids: IDS,
    internalOverrides: async () => new Set(["contractor@example.com"]),
  });
  const client = fakeClient([guest("U-XYZ", "Contractor@EXAMPLE.com"), guest("U-OTHER", "someone@else.com")]);
  const byEmail = await dir.classifyUserCached(client, "U-XYZ");
  assert.equal(byEmail.actor.isExternalGuest, false);
  const other = await dir.classifyUserCached(client, "U-OTHER");
  assert.equal(other.actor.isExternalGuest, true);
});

test("a Slack Connect account from another workspace is overridden by id but never by its self-reported email", async () => {
  const dir = createDirectory({
    core: CORE,
    ids: IDS,
    internalOverrides: async () => new Set(["contractor@example.com", "u-partner"]),
  });
  const connect = (id: string, email: string) => ({ id, team_id: "T-OTHER", profile: { email } });
  const client = fakeClient([
    connect("U-IMPOSTER", "contractor@example.com"),
    connect("U-PARTNER", "partner@other.example"),
    guest("U-STAFF-GUEST", "contractor@example.com"),
  ]);
  assert.equal((await dir.classifyUserCached(client, "U-IMPOSTER")).actor.isExternalGuest, true);
  assert.equal((await dir.classifyUserCached(client, "U-PARTNER")).actor.isExternalGuest, false);
  assert.equal((await dir.classifyUserCached(client, "U-STAFF-GUEST")).actor.isExternalGuest, false);
});

test("in email identity mode the override still ignores another workspace's self-reported email", async () => {
  const dir = createDirectory({
    core: CORE,
    ids: { ...IDS, identityMode: "email" },
    internalOverrides: async () => new Set(["contractor@example.com"]),
  });
  const client = fakeClient([{ id: "U-IMPOSTER", team_id: "T-OTHER", profile: { email: "contractor@example.com" } }]);
  const imposter = await dir.classifyUserCached(client, "U-IMPOSTER");
  assert.equal(imposter.actor.externalId, "contractor@example.com");
  assert.equal(imposter.actor.isExternalGuest, true);
});

test("the users.info fallback path honors the override for a user missing from the snapshot", async () => {
  const listed = fakeClient([guest("U-LISTED")]);
  const dir = createDirectory({
    core: CORE,
    ids: IDS,
    internalOverrides: async () => new Set(["u-solo"]),
  });

  await dir.classifyUserCached(listed, "U-LISTED");
  const solo = { id: "U-SOLO", team_id: "T-OWN", is_restricted: true };
  const client = {
    ...fakeClient([guest("U-LISTED")]),
    users: { info: async () => ({ user: solo }) },
  };
  const classified = await dir.classifyUserCached(client, "U-SOLO");
  assert.equal(classified.actor.isExternalGuest, false);
});

test("without an override list, guest classification is unchanged", async () => {
  const dir = createDirectory({ core: CORE, ids: IDS });
  const client = fakeClient([guest("U-CONTRACTOR")]);
  const classified = await dir.classifyUserCached(client, "U-CONTRACTOR");
  assert.equal(classified.actor.isExternalGuest, true);
});
