import { BUILTIN_ACCOUNT_TYPES, orderAccountNames, type AccountType } from "../connectors/oauth.ts";
import type { ConnectorTokenStore } from "./keychain.ts";

type AccountInventory = Pick<ConnectorTokenStore, "listConnectorsByOwners">;

/** Account names `principalId` holds per connector host, from one keychain inventory read. */
export async function connectorAccountsByHost(
  tokens: AccountInventory,
  principalId: string,
): Promise<Map<string, AccountType[]>> {
  const byHost = new Map<string, AccountType[]>();
  if (!tokens.listConnectorsByOwners) return byHost;
  const owned = (await tokens.listConnectorsByOwners([principalId])).get(principalId) ?? [];
  for (const meta of owned) {
    const host = meta.host.toLowerCase();
    byHost.set(host, [...(byHost.get(host) ?? []), meta.accountType ?? "default"]);
  }
  return byHost;
}

/**
 * The account slots to try for `host`, in selection order: the `preferred` built-in slots first
 * (probed even when the store has no inventory), then every other named account, alphabetically.
 */
export async function connectorAccountNames(
  tokens: AccountInventory,
  host: string,
  principalId: string,
  preferred: readonly string[] = BUILTIN_ACCOUNT_TYPES,
): Promise<AccountType[]> {
  const byHost = await connectorAccountsByHost(tokens, principalId);
  return orderAccountNames(byHost.get(host.toLowerCase()) ?? [], preferred);
}
