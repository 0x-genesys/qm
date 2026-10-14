import assert from "node:assert/strict";
import test from "node:test";
import { createAgentTools, type ToolContextRef } from "../src/harness/agent-tools.ts";
import { createToolContext } from "../src/tools/primitives.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { collectBytes } from "../src/util/bytes.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";

const owner = scopeId("personal", "tester");

function fixture(stdout: string, screenToolResult?: ToolContextRef["screenToolResult"]) {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const emitted: Record<string, unknown>[] = [];
  const context = createToolContext({
    sandbox: { run: async () => ({ stdout, stderr: "", code: 0, timedOut: false }) } as unknown as Sandbox,
    provision: async () => ({ id: "sandbox", rootDir: "/workspace" }),
    layers: [{ scopeId: owner, mountPath: "", mode: "rw" }],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => true,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    files,
    createdBy: "tester",
    runId: "output-recovery",
    commandCredentials: [{ handle: "sample", env: [{ key: "SECRET_TOKEN", value: "example-secret", secret: true }] }],
  });
  const execute = createAgentTools({
    current: context,
    scopeLabel: owner,
    screenToolResult,
    emit: (entry) => {
      if (entry.type === "tool_result") emitted.push(entry.payload as Record<string, unknown>);
    },
  }).find((tool) => tool.name === "execute")!;
  return {
    files,
    emitted,
    run: async () => {
      const invoke = execute.execute as unknown as (
        id: string,
        params: unknown,
      ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
      const result = await invoke("output-call", {
        command: "generate-output",
        purpose: "Check captured output",
        credentials: ["sample"],
      });
      return result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
    },
  };
}

test("a result exactly at the preview cap is complete without a stored copy", async () => {
  const f = fixture("a".repeat(99_991));
  const seen = await f.run();
  assert.equal(seen.length, 100_000);
  assert.doesNotMatch(seen, /truncated/);
  assert.equal((await f.files.listOwnedByScopes([owner])).files.length, 0);
});

test("an oversized result has a bounded Unicode-safe preview and a byte-exact retrievable masked copy", async () => {
  const stdout = "a".repeat(100_025) + "😀example-secret終";
  const f = fixture(stdout);
  const seen = await f.run();
  assert.ok(seen.length <= 100_000);
  assert.match(seen, /truncated/);
  assert.doesNotMatch(seen, /\uFFFD|example-secret/);
  assert.ok(seen.endsWith("終\n[exit 0]"));
  const saved = f.emitted[0]!.fullResult as { fileId: string; sizeBytes: number };
  assert.ok(saved?.fileId, "the replay and caller must retain a recovery reference");
  assert.match(seen, new RegExp(`/v1/files/${saved.fileId}/content`));
  const opened = await f.files.open(saved.fileId);
  assert.equal(opened?.artifact.ownerScopeId, owner);
  const data = await collectBytes(opened!.stream);
  const expected = stdout.replace("example-secret", "<redacted:credential>") + "\n[exit 0]";
  assert.equal(data.data.toString("utf8"), expected);
  assert.equal(saved.sizeBytes, Buffer.byteLength(expected));
  assert.match(seen, new RegExp(`${saved.sizeBytes} UTF-8 bytes`));
  assert.equal(f.emitted[0]!.result, seen);
  assert.equal(f.emitted[0]!.isError, false);
});

test("quarantining an oversized result does not publish its full output", async () => {
  const f = fixture("untrusted".repeat(15_000), async () => ({ outcome: "quarantine" }));
  assert.match(await f.run(), /quarantined/);
  assert.equal((await f.files.listOwnedByScopes([owner])).files.length, 0);
  assert.equal(f.emitted[0]!.fullResult, undefined);
});

test("storage failure reports missing recovery without changing the command result", async (t) => {
  const f = fixture("x".repeat(100_050));
  t.mock.method(f.files, "put", async () => {
    throw new Error("storage unavailable");
  });
  const seen = await f.run();
  assert.match(seen, /storage failed; no retrieval reference/);
  assert.ok(seen.endsWith("[exit 0]"));
  assert.equal(f.emitted[0]!.outputStorageError, "storage unavailable");
  assert.equal(f.emitted[0]!.isError, false);
  assert.equal(f.emitted[0]!.fullResult, undefined);
});
