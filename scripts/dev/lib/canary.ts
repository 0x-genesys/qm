import { WebClient } from "@slack/web-api";
import { errMessage } from "../../../src/util/errors.ts";
import { slackWebClientOptions } from "../../../src/slack/web-client.ts";

export interface CanaryChannelCandidate {
  id: string;
  name: string;
  is_archived?: boolean;
}

const CI_THROWAWAY = /^ci-[a-z0-9-]*-?\d+$/;

export function pickCanaryChannel(channels: CanaryChannelCandidate[]): CanaryChannelCandidate | null {
  const live = channels.filter((c) => c.id && c.name && !c.is_archived);
  return live.find((c) => c.name === "dev-canary") ?? live.find((c) => CI_THROWAWAY.test(c.name)) ?? null;
}

export async function discoverCanaryChannel(
  botToken: string,
  slackApiUrl?: string,
): Promise<CanaryChannelCandidate | null> {
  const client = new WebClient(botToken, slackWebClientOptions(10_000, slackApiUrl));
  const channels: CanaryChannelCandidate[] = [];
  let pages = 0;
  try {
    for await (const page of client.paginate("users.conversations", {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
    })) {
      channels.push(...((page as { channels?: CanaryChannelCandidate[] }).channels ?? []));
      const dedicated = channels.find((c) => c.name === "dev-canary" && !c.is_archived);
      if (dedicated) return dedicated;
      if (++pages >= 5) break;
    }
  } catch (error) {
    console.warn(`[dev] canary channel discovery stopped after ${pages} page(s): ${errMessage(error)}`);
  }
  return pickCanaryChannel(channels);
}
