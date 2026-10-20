import { createHash } from "node:crypto";
import { retainedSnapshot } from "../harness/context-snapshot.ts";
import type { SandboxResources } from "../sandbox/sandbox-resources.ts";
import type { SessionEntry } from "../types.ts";
import type { AgentComputerSpec } from "../sandbox/sandbox.ts";
import { connectorLabel, type ConnectorStatusRecord } from "../credentials/connector-status.ts";

export interface WorkspaceLayoutInfo {
  hasGlobal: boolean;
  teamCount: number;
}

export function renderComputerBlock(spec: AgentComputerSpec | undefined, layout: WorkspaceLayoutInfo): string {
  if (!spec) return "";
  const lines: string[] = ["## Sandbox environment profile"];

  const size: string[] = [];
  if (spec.cpus) size.push(`${spec.cpus} vCPU`);
  if (spec.memoryMb) size.push(`${Math.round(spec.memoryMb / 1024)} GB RAM`);
  if (spec.diskGb) size.push(`${spec.diskGb} GB disk`);
  const head = [spec.os, size.join(" / ")].filter(Boolean).join(" · ");
  if (head) lines.push(`${head}.`);
  if (spec.runtimes?.length) lines.push(`Runtimes: ${spec.runtimes.toSorted().join(", ")}.`);
  if (spec.tools?.length) lines.push(`Installed CLIs: ${spec.tools.toSorted().join(", ")}.`);
  if (spec.notInstalled?.length) {
    lines.push(`NOT installed (install on demand if a task needs one): ${spec.notInstalled.toSorted().join(", ")}.`);
  }

  const cwd = spec.workdir ?? ".";
  const home = spec.homeDir ?? "~";
  const ws = [`The workspace path is \`${cwd}\` (read-write). \`$HOME\` (\`${home}\`) holds native logins and config.`];
  if (layout.hasGlobal) ws.push("Shared org files are at `./global` (read-only).");
  if (layout.teamCount > 0) {
    ws.push(`Team files are at \`./team-*\` (read-only; ${layout.teamCount} mounted).`);
  }
  lines.push(ws.join(" "));

  return lines.join("\n");
}

export function renderConnectedAppsBlock(
  record: ConnectorStatusRecord | null,
  availableProviders: readonly string[] = [],
  connectionsUrl?: string,
): string {
  const allowed = new Set(availableProviders);
  const entries = Object.entries(record?.providers ?? {})
    .filter(([name, e]) => allowed.has(name) || e.mcpLabel)
    .sort(([a], [b]) => a.localeCompare(b));
  const label = (name: string, e: (typeof entries)[number][1]) => e.mcpLabel ?? connectorLabel(name);
  const connected = entries.filter(([, e]) => e.connected && !e.needsReconnect).map(([name, e]) => label(name, e));
  const reconnect = entries
    .filter(([, e]) => e.needsReconnect)
    .map(([name, e]) => `${label(name, e)}${e.refreshError ? ` (refresh failed: ${e.refreshError})` : ""}`);
  const lines = [
    "## Connected apps",
    "This list covers direct OAuth only; it does not describe app access through separately authorized credentials. Use the matching access skill for those, respecting explicit app restrictions and account permissions.",
  ];
  if (connectionsUrl) lines.push(`Connection page: ${connectionsUrl}`);
  if (!availableProviders.length) {
    lines.push("No direct OAuth app connections are configured. Do not offer direct OAuth consent links.");
    if (!connected.length && !reconnect.length) return lines.join("\n");
  } else {
    const connectedNames = new Set(entries.filter(([, e]) => e.connected).map(([name]) => name));
    const available = availableProviders.filter((name) => !connectedNames.has(name)).sort();
    if (available.length) {
      lines.push(
        `Available to connect: ${available.map(connectorLabel).join(", ")}. Only offer direct OAuth consent links for this admin-configured list.`,
      );
    } else {
      lines.push("Only offer direct OAuth consent links for the admin-configured list below.");
    }
  }
  if (connected.length) {
    lines.push(`Connected: ${connected.join(", ")}. Use them directly; their auth is wired.`);
  }
  if (reconnect.length) {
    lines.push(`Needs reconnect: ${reconnect.join(", ")}. Do not use these apps until the user reconnects them.`);
  }
  return lines.join("\n");
}

interface EnvironmentSnapshot {
  hashes: Record<string, string>;
  entries?: Record<string, string[]>;
  sessionId: string;
  anchorSeq?: number;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const filled = (blocks: Record<string, string>) => Object.entries(blocks).filter(([, text]) => text.trim());

export function environmentDelta(
  blocks: Record<string, string>,
  history: readonly SessionEntry[],
  sessionId: string,
  growing: Record<string, string> = {},
): { text: string; record: EnvironmentSnapshot } {
  const { previous, anchorSeq } = retainedSnapshot(
    history,
    (entry) => (entry.payload as { environmentSnapshot?: EnvironmentSnapshot } | null)?.environmentSnapshot,
  );
  const current = filled(blocks);
  const grown = filled(growing);
  const record: EnvironmentSnapshot = {
    hashes: Object.fromEntries(current.map(([key, text]) => [key, sha(text)])),
    entries: Object.fromEntries(
      grown.map(([key, text]) => [key, text.split("\n").map((line) => sha(line).slice(0, 16))]),
    ),
    sessionId,
    ...(anchorSeq !== undefined ? { anchorSeq } : {}),
  };
  if (!previous) return { text: [...current, ...grown].map(([, text]) => text).join("\n\n"), record };
  const changed = current.filter(([key]) => previous.hashes[key] !== record.hashes[key]).map(([, text]) => text);
  const additions = grown.flatMap(([key, text]) => {
    const seen = previous.entries?.[key];
    if (!seen) return [text];
    const lines = text.split("\n");
    const added = lines.filter((_, index) => !seen.includes(record.entries![key]![index]!));
    if (added.some((line) => !line.startsWith("- "))) return [text];
    record.entries![key] = [...new Set([...seen, ...record.entries![key]!])];
    return added.length ? [[`${lines[0]} (additions only; earlier entries still apply)`, ...added].join("\n")] : [];
  });
  const present = new Set([...current, ...grown].map(([key]) => key));
  const removed = [...Object.keys(previous.hashes), ...Object.keys(previous.entries ?? {})].filter(
    (key) => !present.has(key),
  );
  return {
    text:
      changed.length || additions.length || removed.length
        ? [
            "Environment changes: sections below replace their earlier versions, except sections marked as additions; unlisted sections are unchanged. Inventories are not permission grants; access is checked live.",
            ...changed,
            ...additions,
            ...removed.map((key) => `No longer included: ${key}. Do not rely on its earlier inventory.`),
          ].join("\n\n")
        : "",
    record,
  };
}

export function renderSandboxProfiles(
  providers: ReturnType<SandboxResources["profiles"]>,
  layout: WorkspaceLayoutInfo,
): Record<string, string> {
  return Object.fromEntries(
    providers
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((provider) => [
        `Sandbox provider ${provider.name}`,
        [
          `## Sandbox provider ${provider.name}`,
          `Available actions: ${provider.actions.toSorted().join(", ")}.`,
          renderComputerBlock(provider.spec, layout).replace("## Sandbox environment profile\n", "") ||
            "Environment profile unknown.",
        ].join("\n"),
      ]),
  );
}
