import { worthOffering, type MemorableCapture } from "./capture.ts";
import { runMemorable } from "./run.ts";

const RELAY_TIMEOUT_MS = 120_000;
const MAX_RELAY_STDOUT = 8_192;
const MAX_RELAY_STDERR = 2_048;

function refusalReason(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(text) as { error?: unknown; mode?: unknown };
      if (typeof parsed.error === "string") {
        return typeof parsed.mode === "string" ? `${parsed.error} (consent ${parsed.mode})` : parsed.error;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export type RelayOutcome = { ok: true } | { ok: false; reason: string };

export async function relayRecord(
  argv: readonly string[],
  capture: MemorableCapture,
  timeoutMs: number = RELAY_TIMEOUT_MS,
  opts?: { env: NodeJS.ProcessEnv; apiKey?: string },
): Promise<RelayOutcome> {
  const workflows = capture.workflows.filter(worthOffering).map((workflow) => ({
    ...workflow,
    tool_calls: workflow.tool_calls.map((call) => {
      const action = call.input.action;
      let name = call.name;
      if (name === "files" && (action === "read" || action === "write")) name = action;
      else if (name === "sandbox" && action === "exec") name = "execute";
      return { ...call, name };
    }),
  }));
  if (!workflows.length) return { ok: true };
  const run = await runMemorable(
    argv,
    ["record", "--scope", capture.scope_id, "-"],
    JSON.stringify({ ...capture, workflows }),
    { timeoutMs, maxStdoutBytes: MAX_RELAY_STDOUT, stdoutOverflow: "truncate", maxStderrBytes: MAX_RELAY_STDERR },
    opts,
  );
  if (run.status === "error") return { ok: false, reason: run.message.slice(0, 200) };
  if (run.status !== "exit") return { ok: false, reason: run.status };
  if (run.code === 0) return { ok: true };
  const detail = run.stderr.replace(/\s+/g, " ").trim().slice(0, 300);
  return {
    ok: false,
    reason: refusalReason(run.stdout) ?? (detail ? `exit ${run.code}: ${detail}` : `exit ${run.code}`),
  };
}
