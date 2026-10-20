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
  lines?: Record<string, string[]>;
  sessionId: string;
  anchorSeq?: number;
}

const ENVIRONMENT_CHANGES =
  "Environment changes: sections below replace their earlier versions unless their heading says they list only changed lines or additions; unlisted sections are unchanged. Inventories are not permission grants; access is checked live.";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const lineHash = (line: string) => sha(line).slice(0, 12);

function heldLineTexts(history: readonly SessionEntry[], sinceSeq: number): Map<string, string> {
  const texts = new Map<string, string>();
  for (const entry of history) {
    if (entry.type !== "user" || entry.seq < sinceSeq) continue;
    const environment = (entry.payload as { environment?: unknown } | null)?.environment;
    if (typeof environment !== "string") continue;
    for (const line of environment.split("\n")) {
      texts.set(lineHash(line), line);
      texts.set(lineHash(line.slice(2)), line.slice(2));
    }
  }
  return texts;
}

function changedLines(
  text: string,
  lines: readonly string[],
  previous: readonly string[],
  held: () => Map<string, string>,
): string | null {
  if (previous[0] !== lines[0]) return null;
  const current = text.split("\n");
  const texts = held();
  const before = previous.map((hash) => texts.get(hash));
  const kept = new Set(lines);
  const was = new Set(previous);
  const out = [`${current[0]} (changed lines only: + added, - removed; all other lines are unchanged)`];
  let context: string | undefined;
  const emit = (version: readonly (string | undefined)[], index: number, mark: string) => {
    const heading = version.slice(1, index).findLast((line) => line?.startsWith("#"));
    if (heading !== undefined && heading !== context) out.push(`  ${heading}`);
    context = heading;
    out.push(`${mark} ${version[index]}`);
  };
  for (const [index, hash] of previous.entries()) {
    if (kept.has(hash)) continue;
    if (before[index] === undefined) return null;
    emit(before, index, "-");
  }
  for (const [index, hash] of lines.entries()) if (!was.has(hash)) emit(current, index, "+");
  const delta = out.join("\n");
  return delta.length * 2 <= text.length ? delta : null;
}

function addedLines(text: string, lines: readonly string[], previous: readonly string[]): string {
  const seen = new Set(previous);
  const current = text.split("\n");
  const added = current.filter((_, index) => !seen.has(lines[index]!));
  return added.length ? [`${current[0]} (additions only; earlier entries still apply)`, ...added].join("\n") : "";
}

export function environmentDelta(
  blocks: Record<string, string>,
  history: readonly SessionEntry[],
  sessionId: string,
  additive: ReadonlySet<string> = new Set(),
): { text: string; record: EnvironmentSnapshot } {
  const { previous, anchorSeq } = retainedSnapshot(
    history,
    (entry) => (entry.payload as { environmentSnapshot?: EnvironmentSnapshot } | null)?.environmentSnapshot,
  );
  const current = Object.fromEntries(Object.entries(blocks).filter(([, text]) => text.trim()));
  const hashes = Object.fromEntries(Object.entries(current).map(([key, text]) => [key, sha(text)]));
  const lines = Object.fromEntries(Object.entries(current).map(([key, text]) => [key, text.split("\n").map(lineHash)]));
  const record: EnvironmentSnapshot = {
    hashes,
    lines: { ...lines },
    sessionId,
    ...(anchorSeq !== undefined ? { anchorSeq } : {}),
  };
  if (!previous) return { text: Object.values(current).join("\n\n"), record };
  let held: Map<string, string> | undefined;
  const heldTexts = () => (held ??= heldLineTexts(history, anchorSeq ?? 0));
  const changed = Object.entries(current).flatMap(([key, text]) => {
    const before = previous.lines?.[key];
    if (before && additive.has(key)) {
      record.lines![key] = [...new Set([...before, ...lines[key]!])];
      return previous.hashes[key] === hashes[key] ? [] : [addedLines(text, lines[key]!, before)].filter(Boolean);
    }
    if (previous.hashes[key] === hashes[key]) return [];
    return [(before && changedLines(text, lines[key]!, before, heldTexts)) || text];
  });
  const removed = Object.keys(previous.hashes).filter((key) => !(key in current));
  return {
    text:
      changed.length || removed.length
        ? [
            ENVIRONMENT_CHANGES,
            ...changed,
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
