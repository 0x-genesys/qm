import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAwsSandbox } from "../src/sandbox/aws-sandbox.ts";
import { createE2bSandbox } from "../src/sandbox/e2b-sandbox.ts";
import { createManagedAgentsSandbox } from "../src/sandbox/managed-agents-sandbox.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";
import { createSandboxResources, type SandboxResource } from "../src/sandbox/sandbox-resources.ts";
import { createSandboxRouter } from "../src/sandbox/sandbox-routing.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { installFakeE2b } from "./support/fake-e2b.ts";
import { installFakeManagedAgents } from "./support/fake-managed-agents.ts";
import { installFakeMicrovm } from "./support/fake-microvm.ts";

const workspace = () => createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "resource-parking-")));
const fixtures = [
  {
    backend: "e2b",
    setup() {
      const fake = installFakeE2b();
      const name = (record: SandboxResource) => sandboxScopeName("parking", record.backingScopeId);
      return {
        sandbox: createE2bSandbox(workspace(), { client: fake.client, namePrefix: "parking" }),
        parked: (record: SandboxResource) => fake.current(name(record))?.state === "paused",
        creations: (record: SandboxResource) => fake.createdCount(name(record)),
        cleanup: () => fake.cleanup(),
      };
    },
  },
  {
    backend: "do-managed-agents",
    setup() {
      const fake = installFakeManagedAgents();
      const name = (record: SandboxResource) => sandboxScopeName("parking", record.backingScopeId);
      return {
        sandbox: createManagedAgentsSandbox(workspace(), { client: fake.client, namePrefix: "parking" }),
        parked: (record: SandboxResource) => fake.current(name(record))?.state === "paused",
        creations: (record: SandboxResource) => fake.createdCount(name(record)),
        cleanup: () => fake.cleanup(),
      };
    },
  },
  {
    backend: "aws",
    setup() {
      const fake = installFakeMicrovm();
      return {
        sandbox: createAwsSandbox(workspace(), {
          region: "us-west-2",
          imageIdentifier: "fixture",
          s3Bucket: "fixture",
          api: fake.api,
          s3: fake.s3,
          fetchImpl: fake.fetchImpl,
        }),
        parked: (record: SandboxResource) => fake.bodies.get(record.machineId!)?.state === "SUSPENDED",
        creations: () => fake.runCount,
        cleanup() {},
      };
    },
  },
] as const;

for (const fixture of fixtures) {
  test(`${fixture.backend} resource creation parks and execution resumes the same saved computer`, async () => {
    const { sandbox, parked, creations, cleanup } = fixture.setup();
    const backends = { [fixture.backend]: sandbox };
    const resources = createSandboxResources({
      records: createMemoryMap(),
      defaults: createMemoryMap(),
      backends,
      defaultBackend: fixture.backend,
      lock: createMemoryAdvisoryLock(),
      canUseScope: async () => true,
    });
    const router = createSandboxRouter({ backends, defaultBackend: fixture.backend, resources });
    try {
      const record = await resources.create("owner", "personal:owner", fixture.backend);
      assert.equal(parked(record), true);
      const layers = [{ scopeId: "personal:owner", mode: "rw" as const, mountPath: "/" }];
      const first = await router.provision(layers, { sandboxId: record.id });
      assert.equal(parked(record), false);
      await router.writeFile(first, "result", "saved work");
      await router.teardown(first);
      const resumed = await router.provision(layers, { sandboxId: record.id });
      assert.equal(await router.readFile(resumed, "result"), "saved work");
      assert.equal(creations(record), 1);
      await router.teardown(resumed);
      assert.equal(parked(record), true);
    } finally {
      cleanup();
    }
  });
}
