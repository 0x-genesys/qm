import { orderAccountNames, type AccountType } from "../connectors/oauth.ts";
import type { ConnectorTokenStore } from "./keychain.ts";

type AccountSlots = (host: string, preferred?: readonly string[]) => AccountType[];

export function accountSlots(owned: ReadonlyArray<{ host: string; accountType?: string }>): AccountSlots {
  return (host, preferred) =>
    orderAccountNames(
      owned.filter((c) => c.host.toLowerCase() === host.toLowerCase()).map((c) => c.accountType ?? "default"),
      preferred,
    );
}

export async function connectorAccountSlots(
  tokens: Pick<ConnectorTokenStore, "listConnectorsByOwners">,
  principalId: string,
): Promise<AccountSlots> {
  const owned = tokens.listConnectorsByOwners
    ? ((await tokens.listConnectorsByOwners([principalId])).get(principalId) ?? [])
    : [];
  return accountSlots(owned);
}
