import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { loadConfig, type Config } from "../../src/config.ts";
import { createSdkModalClient } from "../../src/sandbox/modal-client.ts";
import type { SandboxBackendName } from "../../src/sandbox/sandbox-routing.ts";
import { fakeSprites } from "../support/auto-fake-sprites.ts";
import type { ModelReply, ModelRequest } from "./support/fake-gateway.ts";
import { journeyTestOptions, startJourneyApp, waitFor } from "./support/journey-app.ts";

const provider = (process.env.JOURNEY_SANDBOX_PROVIDER ?? "local") as SandboxBackendName;
const LOCAL_IMAGE = "qm-sandbox-local:journey";

const requiredEnv: Record<SandboxBackendName, string[]> = {
  local: [],
  sprites: ["SPRITES_TOKEN"],
  smolmachines: ["SMOLMACHINES_TOKEN"],
  e2b: ["E2B_API_KEY"],
  modal: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
  agent37: ["AGENT37_API_KEY"],
  superserve: ["SUPERSERVE_API_KEY", "SUPERSERVE_TEMPLATE"],
  "do-managed-agents": ["DO_AGENTS_API_TOKEN"],
  aws: ["AWS_SANDBOX_S3_BUCKET"],
  porter: ["PORTER_TOKEN"],
};

function skipReason(): string | false {
  if (!process.env.DATABASE_URL) return "journeys need DATABASE_URL (run them through npm run test:journey)";
  const missing = (requiredEnv[provider] ?? []).filter((name) => !process.env[name]);
  return missing.length ? `${provider} sandbox journey needs ${missing.join(", ")}` : false;
}

function sandboxConfig(): Partial<Config> {
  const env = loadConfig(process.env);
  return {
    sandboxBackend: provider,
    localSandbox: { ...env.localSandbox, image: env.localSandbox.image ?? LOCAL_IMAGE },
    spritesSandbox: env.spritesSandbox,
    smolmachinesSandbox: env.smolmachinesSandbox,
    e2bSandbox: env.e2bSandbox,
    modalSandbox: env.modalSandbox,
    agent37Sandbox: env.agent37Sandbox,
    superserveSandbox: env.superserveSandbox,
    managedAgentsSandbox: env.managedAgentsSandbox,
    awsSandbox: env.awsSandbox,
    porterSandbox: env.porterSandbox,
  };
}

function buildLocalImage(): void {
  execFileSync(
    "docker",
    ["build", "-q", "-f", "local/Dockerfile", "--build-arg", "BASE=node:24-slim", "-t", LOCAL_IMAGE, "."],
    {
      stdio: "ignore",
    },
  );
}

async function deleteUnderneath(config: Partial<Config>, machine: string): Promise<void> {
  if (provider === "local") {
    execFileSync("docker", ["rm", "-f", machine], { stdio: "ignore" });
  } else if (provider === "sprites") {
    const base = config.spritesSandbox?.baseUrl ?? "https://api.sprites.dev";
    const res = await fetch(`${base}/v1/sprites/${machine}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${config.spritesSandbox?.token}` },
    });
    assert.ok(res.ok, `sprites delete ${machine}: ${res.status}`);
  } else if (provider === "modal") {
    const modal = config.modalSandbox!;
    const client = createSdkModalClient({
      tokenId: modal.tokenId!,
      tokenSecret: modal.tokenSecret!,
      appName: modal.appName ?? "qm",
      ...(modal.environment ? { environment: modal.environment } : {}),
    });
    const session = await client.fromName(machine);
    assert.ok(session, `modal sandbox ${machine} exists`);
    await session.terminate();
  } else {
    throw new Error(`no out-of-band delete for ${provider}`);
  }
}

const lostCause: Partial<Record<SandboxBackendName, RegExp>> = {
  local: /other side closed|ECONNREFUSED|ECONNRESET|is gone/,
  sprites: /no longer exists/,
  modal: /stopped \(exit -?\d+\) mid-command/,
};

type Step = (previous: string) => ModelReply;

function toolResultText(req: ModelRequest): string | undefined {
  const last = req.messages.at(-1);
  if (!Array.isArray(last?.content)) return undefined;
  const results = (last.content as Array<{ type?: string; content?: unknown }>).filter((b) => b.type === "tool_result");
  if (!results.length) return undefined;
  return results
    .map((b) =>
      typeof b.content === "string"
        ? b.content
        : (b.content as Array<{ text?: string }>).map((part) => part.text ?? "").join(""),
    )
    .join("\n");
}

test(`sandbox basics on ${provider}`, { ...journeyTestOptions(600_000), skip: skipReason() }, async (t) => {
  const started = Date.now();
  if (provider === "local") buildLocalImage();
  if (provider === "sprites") fakeSprites.cleanup();
  const config = sandboxConfig();
  const app = await startJourneyApp(
    { maxRequestBytes: 10_000_000, contextWindowTokens: 200_000, maxOutputTokens: 8000 },
    { ...config, securityScreen: "observe" },
  );
  let steps: Step[] = [];
  let results: string[] = [];
  let issued = 0;
  app.gateway.respond = (req) => {
    if (JSON.stringify(req.system).includes("security boundary classifier")) return { text: '{"decision":"auto"}' };
    if (!req.tools?.length) return { text: "NONE" };
    const previous = toolResultText(req);
    if (previous !== undefined) results.push(previous);
    const next = steps.shift();
    if (!next) return { text: `done after ${results.length} tool calls` };
    issued++;
    return next(previous ?? "");
  };
  const actor = `x1-${provider}-${Date.now()}@example.com`;
  const threadRef = `web:${actor}:x1`;
  const turn = async (text: string, script: Step[]) => {
    steps = script;
    results = [];
    const result = await app.webTurn(actor, threadRef, text);
    assert.equal(result.status, "ok", `turn "${text}" failed: ${result.reason}`);
    assert.ok(result.reply?.trim(), "the user gets a reply");
    return results;
  };
  const exec =
    (command: string, extra: Record<string, unknown> = {}): Step =>
    () => ({
      tool: "execute",
      input: { command, purpose: "journey step", ...extra },
    });
  let sandboxId = "";
  let actions: string[] = [];
  const marker = `x1-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await t.test("a new scope gets a default computer on first use", async () => {
      const out = await turn("Run a quick command for me.", [
        exec(`echo ${marker}-$((6*7))`),
        () => ({
          tool: "sandbox",
          input: { action: "create", backend: provider, name: "x1", purpose: "first computer" },
        }),
        (created) => {
          sandboxId = /"id":"([^"]+)"/.exec(created)?.[1] ?? "";
          return { tool: "sandbox", input: { action: "set_default", sandbox_id: sandboxId, purpose: "use it" } };
        },
        () => ({ tool: "sandbox", input: { action: "list", purpose: "inventory" } }),
        exec(`echo ${marker}-$((6*7))`),
      ]);
      t.diagnostic(`first execute: ${out[0]}`);
      assert.ok(sandboxId, `sandbox create: ${out[1]}`);
      const listed = JSON.parse(out[3]!) as {
        defaultSandboxId: string;
        providers: Array<{ name: string; actions: string[] }>;
      };
      assert.equal(listed.defaultSandboxId, sandboxId);
      actions = listed.providers.find((p) => p.name === provider)?.actions ?? [];
      assert.match(out[4]!, new RegExp(`${marker}-42\\n[\\s\\S]*\\[exit 0\\]`));
    });

    await t.test("run a command and get its stdout back", async () => {
      const out = await turn("What kernel is this, and print a multi-line result.", [
        exec(`uname -s; printf 'line-%s\\n' 1 2 3; echo err-${marker} >&2; exit 3`),
      ]);
      assert.match(out[0]!, /Linux\nline-1\nline-2\nline-3/);
      assert.match(out[0]!, new RegExp(`err-${marker}`));
      assert.match(out[0]!, /\[exit 3\]/);
    });

    await t.test("write a file and read it back", async () => {
      const body = `notes for ${marker}\nsecond line\n`;
      const out = await turn("Save my notes and show them to me.", [
        () => ({ tool: "files", input: { action: "write", path: "x1/notes.txt", data: body } }),
        exec("cat x1/notes.txt && wc -l < x1/notes.txt"),
        () => ({ tool: "files", input: { action: "read", path: "x1/notes.txt" } }),
      ]);
      assert.match(out[1]!, new RegExp(`notes for ${marker}\\nsecond line\\n2\\n`));
      assert.ok(out[2]!.includes(body.trim()), `read back: ${out[2]}`);
    });

    await t.test("start a background process and poll it", async () => {
      const out = await turn("Kick off the slow job in the background and tell me when it finishes.", [
        exec(`for i in 1 2 3; do echo tick-$i-${marker}; sleep 1; done; echo finished`, {
          background: true,
          purpose: "slow job",
        }),
        (startedText) => ({
          tool: "background",
          input: { action: "poll", process_id: /started (\S+)/.exec(startedText)?.[1] ?? "", wait_seconds: 30 },
        }),
      ]);
      assert.match(out[0]!, /started \S+/);
      const polled = out.slice(1).join("\n");
      assert.match(polled, new RegExp(`tick-3-${marker}\\nfinished`));
      assert.match(polled, /exit(ed)?\W+0|exit 0/);
    });

    await t.test("the computer survives a pause and resume", async () => {
      const restart = actions.includes("restart");
      const out = await turn("Pick up where we left off.", [
        ...(restart
          ? [
              (): ModelReply => ({
                tool: "sandbox",
                input: { action: "restart", sandbox_id: sandboxId, purpose: "restart" },
              }),
            ]
          : []),
        exec("cat x1/notes.txt"),
      ]);
      t.diagnostic(
        restart ? "restarted through the sandbox tool" : `${provider} has no restart; resumed after the turn parked it`,
      );
      assert.match(out.at(-1)!, new RegExp(`notes for ${marker}`));
    });

    await t.test("a computer lost mid-command reports the provider's cause", async (st) => {
      if (!lostCause[provider]) {
        st.skip(`no out-of-band delete wired for ${provider}`);
        return;
      }
      const record = await app.built.sandboxResources.get(sandboxId);
      const before = issued;
      const running = turn("Run the long import.", [exec("sleep 120; echo never")]);
      await waitFor(async () => issued > before, "the long command to be issued");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await deleteUnderneath(config, record.machineId!);
      const out = await running;
      t.diagnostic(`lost result: ${out[0]}`);
      assert.ok(!out[0]!.includes("never"), "the command did not finish");
      assert.match(out[0]!, lostCause[provider]!);
    });
  } finally {
    t.diagnostic(`${provider} wall time ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (sandboxId) {
      await app.built.sandboxResources
        .setDefault(actor, (await app.built.sandboxResources.get(sandboxId)).ownerScopeId, null)
        .catch(() => {});
      await app.built.sandboxResources
        .retire(actor, sandboxId)
        .catch((e: unknown) => t.diagnostic(`retire: ${String(e)}`));
    }
    await app.stop();
  }
});
