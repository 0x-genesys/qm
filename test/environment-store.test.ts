import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryEnvironmentStore, resolveEnvironmentId } from "../src/environments/environment-store.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";
import { scopeId } from "../src/types.ts";

describe("environments (the computer a conversation points at)", () => {
  let t = 1_000;
  const now = (): number => ++t;
  const store = (): ReturnType<typeof createMemoryEnvironmentStore> => createMemoryEnvironmentStore({ now });
  const present = async (): Promise<boolean> => true;

  it("an unattached scope resolves to its own default environment (id == scopeId)", async () => {
    const s = store();
    const scope = scopeId("channel", "C-eng");
    assert.equal(await resolveEnvironmentId(s, scope, present), scope);
  });

  it("resolveEnvironmentId is the identity when no store is wired (zero-migration default)", async () => {
    const scope = scopeId("personal", "U1");
    assert.equal(await resolveEnvironmentId(undefined, scope, present), scope);
  });

  it("the default environment's machine/volume names are exactly today's scope-keyed names", async () => {
    const scope = scopeId("channel", "C-eng");
    const envId = await resolveEnvironmentId(store(), scope, present);
    assert.equal(sandboxScopeName("qm", envId), sandboxScopeName("qm", scope));
  });

  it("an attachment redirects the machine + backup key to the environment id", async () => {
    const s = store();
    const scope = scopeId("channel", "C-eng");
    const owner = scopeId("personal", "U-owner");
    await s.create({ id: owner, name: "prod", ownerActorId: "U-owner" });
    await s.attach(scope, owner, "U-owner");

    const resolved = await resolveEnvironmentId(s, scope, present);
    assert.equal(resolved, owner, "the attached scope provisions through the environment id");
    assert.equal(sandboxScopeName("qm", resolved), sandboxScopeName("qm", owner));
    assert.notEqual(sandboxScopeName("qm", resolved), sandboxScopeName("qm", scope));
  });

  it("two scopes attached to one environment resolve to the SAME id (advisory lock keys on it)", async () => {
    const s = store();
    const env = scopeId("personal", "U-owner");
    await s.create({ id: env, name: "prod", ownerActorId: "U-owner" });
    const a = scopeId("channel", "C-a");
    const b = scopeId("channel", "C-b");
    await s.attach(a, env, "U-owner");
    await s.attach(b, env, "U-owner");

    const ra = await resolveEnvironmentId(s, a, present);
    const rb = await resolveEnvironmentId(s, b, present);
    assert.equal(ra, rb);
    assert.equal(sandboxScopeName("qm", ra), sandboxScopeName("qm", rb));
  });

  it("a room's attachment lapses once the owner who attached it is no longer a member of the room", async () => {
    const s = store();
    const room = scopeId("channel", "C-eng");
    const owner = scopeId("personal", "U-owner");
    await s.create({ id: owner, name: "prod", ownerActorId: "U-owner" });
    await s.attach(room, owner, "U-owner");
    const members = new Set(["U-owner", "U-other"]);
    const isMember = async (person: string, scope: string): Promise<boolean> => scope === room && members.has(person);

    assert.equal(await resolveEnvironmentId(s, room, isMember), owner);
    members.delete("U-owner");
    assert.equal(await resolveEnvironmentId(s, room, isMember), room, "the room falls back to its own computer");
    assert.ok(await s.getAttachment(room), "the attachment row stays; it is honoured only while the owner is present");
  });

  it("a personal scope's attachment does not depend on room membership", async () => {
    const s = store();
    const owner = scopeId("personal", "U-owner");
    await s.create({ id: owner, name: "prod", ownerActorId: "U-owner" });
    await s.attach(scopeId("personal", "U-owner-alias"), owner, "U-owner");
    const never = async (): Promise<boolean> => false;
    assert.equal(await resolveEnvironmentId(s, scopeId("personal", "U-owner-alias"), never), owner);
  });

  it("create is idempotent on id (re-naming the same default env returns the first record)", async () => {
    const s = store();
    const id = scopeId("channel", "C-eng");
    const first = await s.create({ id, name: "prod", ownerActorId: "U1" });
    const second = await s.create({ id, name: "staging", ownerActorId: "U2" });
    assert.equal(second.name, "prod", "the original name + owner stand");
    assert.equal(second.ownerActorId, "U1");
    assert.equal(first.createdAt, second.createdAt);
  });

  it("attachmentsFor lists every scope pointing at an environment", async () => {
    const s = store();
    const env = scopeId("personal", "U-owner");
    await s.create({ id: env, name: "prod", ownerActorId: "U-owner" });
    await s.attach(scopeId("channel", "C-a"), env, "U-owner");
    await s.attach(scopeId("channel", "C-b"), env, "U-owner");
    const attached = (await s.attachmentsFor(env)).map((a) => a.scopeId).sort();
    assert.deepEqual(attached, [scopeId("channel", "C-a"), scopeId("channel", "C-b")].sort());
  });
});
