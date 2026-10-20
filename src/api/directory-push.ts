import type { App } from "./app.ts";
import type { DirectoryMember } from "../directory/directory-store.ts";

export interface DirectoryPush {
  members?: DirectoryMember[];
  channels?: Array<{ channelId: string; name: string; isPrivate?: boolean; isExternal?: boolean }>;
  channelMembers?: Array<{ channelId: string; principalId: string }>;
  channelRosterIds?: string[];
  channelRevocations?: Array<{ channelId: string; principalId: string }>;
  groupMembers?: Array<{ groupId: string; principalId: string }>;
  groupIds?: string[];
  groupRosterIds?: string[];
  workspaceUrl?: string;
  membersSyncedAt?: number;
  channelsSyncedAt?: number;
  partialChannels?: boolean;
  groupsSyncedAt?: number;
}

export interface DirectoryPushOutcome {
  members?: boolean;
  channels?: boolean;
  groups?: boolean;
}

export async function applyDirectoryPush(
  app: Pick<App, "setDirectoryWorkspaceUrl" | "upsertDirectory" | "upsertChannels" | "upsertGroups">,
  push: DirectoryPush,
): Promise<DirectoryPushOutcome> {
  const workspaceUrl = push.workspaceUrl?.replace(/\/+$/, "");
  if (workspaceUrl && /^https:\/\/[^\s/]+$/.test(workspaceUrl)) await app.setDirectoryWorkspaceUrl(workspaceUrl);
  const outcome: DirectoryPushOutcome = {};
  if (push.members) outcome.members = await app.upsertDirectory(push.members, push.membersSyncedAt);
  if (push.channels)
    outcome.channels = await app.upsertChannels(
      push.channels,
      push.channelMembers,
      push.channelsSyncedAt,
      push.channelRosterIds,
      push.channelRevocations,
      push.partialChannels === true,
    );
  if (push.groupMembers)
    outcome.groups = await app.upsertGroups(push.groupMembers, push.groupsSyncedAt, push.groupIds, push.groupRosterIds);
  return outcome;
}
