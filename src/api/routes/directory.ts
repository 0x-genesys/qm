import { isPrincipalType, PRINCIPAL_TYPES } from "../../types.ts";
import type { DirectoryMember } from "../../directory/directory-store.ts";
import { canonicalPerson } from "../../directory/person.ts";
import { applyDirectoryPush, type DirectoryPush } from "../directory-push.ts";
import { sendJson } from "../http.ts";
import { audit, isObj, orgScope } from "./shared.ts";
import { withActor, type ApiCtx, type Route } from "./route.ts";

const numOrUndef = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

async function deactivatePrincipal(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.identity) return sendJson(res, 404, { error: "not_found" });
  const id = ctx.params.id!;
  if (!id) return sendJson(res, 404, { error: "not_found" });
  await deps.identity.deactivate(id);
  audit(deps, { principalId: id, action: "principal.deactivate", resource: "principal", scopeLabel: orgScope(deps) });
  return sendJson(res, 200, { ok: true, principalId: id, active: false });
}

async function reactivatePrincipal(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.identity) return sendJson(res, 404, { error: "not_found" });
  const id = ctx.params.id!;
  if (!id) return sendJson(res, 404, { error: "not_found" });
  await deps.identity.reactivate(id);
  audit(deps, { principalId: id, action: "principal.reactivate", resource: "principal", scopeLabel: orgScope(deps) });
  return sendJson(res, 200, { ok: true, principalId: id, active: true });
}

async function canonicalPrincipal(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const id = ctx.params.id!;
  if (!id) return sendJson(res, 404, { error: "not_found" });
  await deps.identity?.refresh(true);
  return sendJson(res, 200, { principalId: id, canonicalId: canonicalPerson(id) });
}

async function pushDirectory(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  const b = body as {
    members?: unknown;
    channels?: unknown;
    channelMembers?: unknown;
    channelRosterIds?: unknown;
    channelRevocations?: unknown;
    groupMembers?: unknown;
    groupIds?: unknown;
    groupRosterIds?: unknown;
    workspaceUrl?: unknown;
    membersSyncedAt?: unknown;
    channelsSyncedAt?: unknown;
    partialChannels?: unknown;
    groupsSyncedAt?: unknown;
  };
  if (!Array.isArray(b.members) && !Array.isArray(b.channels) && !Array.isArray(b.groupMembers)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "members[], channels[], and/or groupMembers[] required",
    });
  }
  if (
    b.partialChannels !== undefined &&
    (typeof b.partialChannels !== "boolean" ||
      (b.partialChannels &&
        (!Array.isArray(b.channels) ||
          !Array.isArray(b.channelMembers) ||
          numOrUndef(b.channelsSyncedAt) === undefined)))
  ) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "partial channels require channels[], channelMembers[] and channelsSyncedAt",
    });
  }
  if (Array.isArray(b.members) && b.members.some((m) => isObj(m) && !isPrincipalType(m.type))) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `member type must be one of: ${PRINCIPAL_TYPES.join(", ")}`,
    });
  }
  const isMembership = (m: unknown): m is { channelId: string; principalId: string } =>
    isObj(m) && typeof m.channelId === "string" && typeof m.principalId === "string";
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((item): item is string => typeof item === "string") : undefined;
  const push: DirectoryPush = {
    workspaceUrl: typeof b.workspaceUrl === "string" ? b.workspaceUrl : undefined,
    members: Array.isArray(b.members)
      ? b.members
          .filter(
            (m): m is DirectoryMember =>
              isObj(m) &&
              typeof m.principalId === "string" &&
              typeof m.displayName === "string" &&
              isPrincipalType(m.type),
          )
          .map((m) => ({
            principalId: m.principalId,
            displayName: m.displayName,
            type: m.type,
            ...(typeof m.slackId === "string" && m.slackId ? { slackId: m.slackId } : {}),
            ...(typeof m.avatarUrl === "string" && m.avatarUrl.startsWith("https://")
              ? { avatarUrl: m.avatarUrl }
              : {}),
          }))
      : undefined,
    channels: Array.isArray(b.channels)
      ? b.channels.filter(
          (c): c is { channelId: string; name: string; isPrivate?: boolean; isExternal?: boolean } =>
            isObj(c) && typeof c.channelId === "string" && typeof c.name === "string",
        )
      : undefined,
    partialChannels: b.partialChannels === true,
    channelMembers: Array.isArray(b.channelMembers) ? b.channelMembers.filter(isMembership) : undefined,
    channelRevocations: Array.isArray(b.channelRevocations) ? b.channelRevocations.filter(isMembership) : undefined,
    channelRosterIds: strings(b.channelRosterIds),
    groupMembers: Array.isArray(b.groupMembers)
      ? b.groupMembers.filter(
          (m): m is { groupId: string; principalId: string } =>
            isObj(m) && typeof m.groupId === "string" && typeof m.principalId === "string",
        )
      : undefined,
    groupIds: strings(b.groupIds),
    groupRosterIds: strings(b.groupRosterIds),
    membersSyncedAt: numOrUndef(b.membersSyncedAt),
    channelsSyncedAt: numOrUndef(b.channelsSyncedAt),
    groupsSyncedAt: numOrUndef(b.groupsSyncedAt),
  };
  const outcome = await applyDirectoryPush(app, push);
  if (push.partialChannels && outcome.channels === false)
    return sendJson(res, 409, { error: "stale_directory_observation" });
  return sendJson(res, 200, {
    ok: true,
    ...(push.members ? { members: push.members.length } : {}),
    ...(push.channels ? { channels: push.channels.length } : {}),
    ...(push.groupMembers ? { groupMembers: push.groupMembers.length } : {}),
  });
}

async function directoryMeta(ctx: ApiCtx): Promise<void> {
  const { res, app } = ctx;
  return sendJson(res, 200, await app.directoryMeta());
}

const SLACK_ID_RE = /^[UW][A-Z0-9]{8,}$/;
async function resolveDirectory(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return sendJson(res, 400, { error: "bad_request", message: "q (a name to resolve) required" });
  const r = await app.resolveRecipient(q);
  let found: DirectoryMember[] = [];
  if (r.kind === "one") found = [r.member];
  else if (r.kind === "ambiguous") found = r.candidates;
  const matches = found.map((m) => {
    const slackId = m.slackId ?? (SLACK_ID_RE.test(m.principalId) ? m.principalId : undefined);
    return slackId ? { ...m, slackId } : m;
  });
  return sendJson(res, 200, { matches });
}

async function channelMembership(ctx: ApiCtx): Promise<void> {
  return sendJson(ctx.res, 200, {
    member: await ctx.app.channelMember(ctx.params.channelId!, ctx.params.principalId!),
  });
}

export const directoryRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/principals/:id/canonical", auth: "source", handle: canonicalPrincipal },
  { method: "GET", path: "/v1/directory/meta", auth: "source", handle: directoryMeta },
  {
    method: "GET",
    path: "/v1/directory/channels/:channelId/members/:principalId",
    auth: "source",
    handle: channelMembership,
  },
  { method: "GET", path: "/v1/directory/resolve", actor: "person", auth: "either", handle: resolveDirectory },
  ...withActor("system", [
    { method: "POST", path: "/v1/principals/:id/deactivate", auth: "source", handle: deactivatePrincipal },
    { method: "POST", path: "/v1/principals/:id/reactivate", auth: "source", handle: reactivatePrincipal },
    { method: "POST", path: "/v1/directory", auth: "source", handle: pushDirectory },
  ]),
];
