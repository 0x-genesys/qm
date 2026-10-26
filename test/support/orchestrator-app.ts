import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp as buildAppRaw } from "./build-app.ts";
import type { TurnRequest, ScopeId } from "../../src/types.ts";
import { testConfig } from "./test-config.ts";
import type { Config } from "../../src/config.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import { hashId } from "../../src/util/crypto.ts";
import { encodeRef, serviceCredRef } from "../../src/acl/resource-ref.ts";
import type { AclStore } from "../../src/acl/acl-store.ts";
import type { SecurityScreener } from "../../src/security/security-screener.ts";

export const noDefaultSandbox = new WeakSet<object>();
function requestScope(req: TurnRequest): string | null {
  const c = req.conversation;
  if (c.kind === "dm") return `personal:${req.actor.externalId}`;
  if ((c.kind === "channel" || c.kind === "group") && c.channelRef) return `${c.kind}:${c.channelRef}`;
  return null;
}
export async function selectComputer(built: ReturnType<typeof buildAppRaw>, actorId: string, scope: ScopeId) {
  const asSpeaker = built.sandboxResources.forTurn({ actorId, scopeId: scope, isCurrent: async () => true });
  const computer = await asSpeaker.create(actorId, scope, built.sandboxResources.defaultBackend());
  await asSpeaker.setDefault(actorId, scope, computer.id);
  return computer;
}
export function buildApp(...args: Parameters<typeof buildAppRaw>): ReturnType<typeof buildAppRaw> {
  const built = buildAppRaw(...args);
  const ready = new Map<string, Promise<void>>();
  const ensure = (actorId: string, scope: string) => {
    let p = ready.get(scope);
    if (!p) {
      p = (async () => {
        if (noDefaultSandbox.has(built)) return;
        if (await built.sandboxResources.resolve(scope as ScopeId)) return;
        await selectComputer(built, actorId, scope as ScopeId);
      })();
      ready.set(scope, p);
    }
    return p;
  };
  const turn = built.app.turn.bind(built.app);
  built.app.turn = async (req, ...rest) => {
    const scope = requestScope(req);
    if (scope) await ensure(req.actor.externalId, scope);
    return turn(req, ...rest);
  };
  return built;
}

export function freshApp(overrides: Partial<Config> = {}, securityScreener?: SecurityScreener) {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "ap-")),
    ...overrides,
  });
  config.spritesSandbox.namePrefix ??= `test-${hashId([config.dataDir]).slice(0, 10)}`;
  return buildApp(config, securityScreener ? { securityScreener } : {});
}

export function spyProvisioning(sandbox: Sandbox) {
  const counts = { provisioned: 0, live: 0 };
  const provision = sandbox.provision.bind(sandbox);
  const teardown = sandbox.teardown.bind(sandbox);
  sandbox.provision = async (layers, opts) => {
    counts.provisioned++;
    counts.live++;
    return provision(layers, opts);
  };
  sandbox.teardown = async (handle, opts) => {
    await teardown(handle, opts);
    counts.live--;
  };
  return counts;
}

export const internalActor = { externalId: "U1" };

export function dm(text: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return {
    surface: "test",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:t1" },
    text,
    ...extra,
  };
}

export function channel(text: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return {
    surface: "slack",
    actor: internalActor,
    conversation: { kind: "channel", threadRef: "ch:C1:t1", channelRef: "C1", audience: [internalActor] },
    text,
    gatewayContext: { reactionGuidance: "react with a Slack emoji short-name like :pray:" },
    ...extra,
  };
}

export async function grantCred(acl: AclStore, org: ScopeId, slug: string, grantee: ScopeId = org): Promise<void> {
  await acl.grant({
    ownerScopeId: org,
    ref: encodeRef(serviceCredRef(slug)),
    granteeScopeId: grantee,
    permission: "read",
    grantedBy: "admin@default-org",
  });
}
