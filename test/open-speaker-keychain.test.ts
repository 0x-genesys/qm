import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnSandboxes, type TurnSandboxContext } from "../src/core/orchestrator/sandboxes.ts";

test("Open speaker's private box rechecks revocation before reuse and is destroyed, never shared", async () => {
  let member = true;
  let posture = "open";
  const global = { scopeId: "org:test", mode: "ro", mountPath: "global" };
  const handle = { id: "owner-test", cwd: "/tmp/owner-test" };
  const provisions: unknown[][] = [];
  const releases: unknown[][] = [];
  const audits: unknown[] = [];
  const context = {
    deps: {
      sandbox: {
        provision: async (...args: unknown[]) => {
          provisions.push(args);
          return handle;
        },
        teardown: async (...args: unknown[]) => {
          releases.push(args);
        },
      },
      auditLog: { record: (event: unknown) => audits.push(event) },
      config: { resolveSharingPostureDurable: async () => posture },
      isCurrentSharedScopeMember: async () => member,
    },
    input: {},
    actor: { id: "alice", type: "internal" },
    session: { id: "session-one" },
    resolution: { layers: [global, { scopeId: "channel:room", mode: "rw", mountPath: "." }] },
    scopeId: "channel:room",
    memoryScopeId: "channel:room",
    transferId: "turn-one",
    isolateOwnerKeychain: true,
    openSpeakerKeychain: true,
    privateBoxAvailable: true,
    connectorEnv: {},
    credentialServices: [],
    quarantinedServices: [],
  } as unknown as TurnSandboxContext;
  const boxes = createTurnSandboxes(context);
  assert.equal(await boxes.provisionPrivateBox!(), handle);
  assert.equal(await boxes.provisionPrivateBox!(), handle);
  assert.equal(provisions.length, 1);
  assert.deepEqual(provisions[0]![0], [global]);
  assert.deepEqual((provisions[0]![1] as { scratch: unknown }).scratch, { key: "private-box:session-one:turn-one" });
  member = false;
  await assert.rejects(boxes.provisionPrivateBox!(), /no longer authorized/);
  member = true;
  posture = "isolated";
  await assert.rejects(boxes.provisionPrivateBox!(), /no longer authorized/);
  posture = "open";
  const command = boxes.privateBoxCommand!("true");
  assert.match(command, /unset AGENT_API_TOKEN AGENT_OAUTH_CONSENT_TOKEN AGENT_CREDENTIAL_TOKEN AWS_ACCESS_KEY_ID/);
  const brokered = boxes.privateBoxCommand!("true", {
    AGENT_CREDENTIAL_TOKEN: "room-capability",
    AWS_REGION: "us-west-2",
  });
  assert.match(brokered, /^unset AGENT_API_TOKEN AGENT_OAUTH_CONSENT_TOKEN AWS_ACCESS_KEY_ID /);
  assert.doesNotMatch(brokered, /AGENT_CREDENTIAL_TOKEN|AWS_REGION/);
  assert.ok(!JSON.stringify(audits).includes("synthetic-secret"));
  await boxes.reclaimBox();
  assert.deepEqual(releases, [[handle, { destroy: true }]]);
  assert.equal(boxes.privateBox.handle, null);
});
