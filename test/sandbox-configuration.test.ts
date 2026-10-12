import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { createMemoryMap, createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createSandboxConfiguration, type StoredSandboxConfiguration } from "../src/sandbox/configuration.ts";
import { loadStartupConfig } from "../src/startup-config.ts";

const key = "sandbox-configuration-test-encryption-key";

test("sandbox overrides supply required credentials without altering shared deployment inputs", () => {
  const env = {
    SANDBOX_BACKEND: "local",
    PORTER_DEPLOY_API_TOKEN: "original-token",
    PORTER_SANDBOX_BASE_URL: "https://original.example",
    PORTER_SANDBOX_IMAGE: "original-image",
    PORTER_SANDBOX_NAME_PREFIX: "original-prefix",
    AWS_SANDBOX_S3_BUCKET: "original-bucket",
  };
  const baseline = loadConfig(env);
  const resolved = loadConfig(env, {
    SANDBOX_BACKEND: "modal",
    MODAL_TOKEN_ID: "managed-id",
    MODAL_TOKEN_SECRET: "managed-secret",
    MODAL_CPUS: "4",
    PORTER_DEPLOY_API_TOKEN: "sandbox-token",
    PORTER_SANDBOX_BASE_URL: "https://sandbox.example",
    PORTER_SANDBOX_IMAGE: "sandbox-image",
    PORTER_SANDBOX_NAME_PREFIX: "sandbox-prefix",
    AWS_SANDBOX_S3_BUCKET: "sandbox-bucket",
  });
  assert.equal(resolved.modalSandbox.cpus, 4);
  assert.equal(resolved.modalSandbox.tokenSecret, "managed-secret");
  assert.equal(resolved.porterSandbox.token, "sandbox-token");
  assert.equal(resolved.awsSandbox.s3Bucket, "sandbox-bucket");
  assert.deepEqual(resolved.porterDeploy, baseline.porterDeploy);
  assert.deepEqual(resolved.awsDeploy, baseline.awsDeploy);
  assert.throws(
    () =>
      loadConfig(
        { SANDBOX_BACKEND: "local", DEPLOY_PROVIDER: "porter", PORTER_SANDBOX_BASE_URL: "https://deploy.example" },
        { PORTER_DEPLOY_API_TOKEN: "sandbox-only-token" },
      ),
    /PORTER_DEPLOY_API_TOKEN/,
  );
});

test("configuration edits encrypt secrets, preserve unrelated overrides, reject stale writers and reset to environment", async () => {
  const backing = createMemoryMap<StoredSandboxConfiguration>();
  const config = loadConfig({
    DATABASE_URL: "postgresql://localhost/unused",
    CONNECTOR_SECRET_KEY: key,
    MODAL_CPUS: "2",
  });
  const store = createSandboxConfiguration({ backing, config });
  await store.write(
    { expectedVersion: null, set: { MODAL_CPUS: "4", MODAL_TOKEN_SECRET: "credential-for-test" } },
    "admin",
  );
  const first = await store.read();
  assert.equal(first.restartRequired, true);
  assert.equal((first.active as { modalSandbox: { cpus: number } }).modalSandbox.cpus, 2);
  assert.equal((first.nextStartup as { modalSandbox: { cpus: number } }).modalSandbox.cpus, 4);
  assert.equal(JSON.stringify(first).includes("credential-for-test"), false);
  assert.equal(JSON.stringify(await backing.entries()).includes("credential-for-test"), false);
  await assert.rejects(store.write({ expectedVersion: null, set: { MODAL_CPUS: "8" } }, "admin"), { status: 409 });
  await store.write({ expectedVersion: first.version, set: { E2B_TEMPLATE_ID: "agent-image" } }, "admin");
  const second = await store.read();
  assert.equal(second.fields.find((field) => field.name === "MODAL_CPUS")!.override, "4");
  await store.write({ expectedVersion: second.version, reset: ["MODAL_CPUS"] }, "admin");
  const reset = await store.read();
  assert.equal(reset.fields.find((field) => field.name === "MODAL_CPUS")!.value, "2");
  assert.equal(reset.fields.find((field) => field.name === "E2B_TEMPLATE_ID")!.override, "agent-image");
  for (const set of [
    { LOCAL_SANDBOX_DOCKER_BIN: "/tmp/executable" },
    { MODAL_CPUS: "NaN" },
    { DATABASE_URL: "other" },
    { MODAL_CPUS: 2 },
    { EXEC_TIMEOUT_DEFAULT_SEC: "600", EXEC_TIMEOUT_MAX_SEC: "1" },
  ]) {
    await assert.rejects(store.write({ expectedVersion: reset.version, set }, "admin"), { status: 400 });
  }
  const changedKey = createSandboxConfiguration({ backing, config: { ...config, connectorSecretKey: "wrong-key" } });
  await assert.rejects(changedKey.read());
  const ephemeral = createSandboxConfiguration({ backing: createMemoryMap(), config: loadConfig({}) });
  await assert.rejects(ephemeral.write({ expectedVersion: null, set: { MODAL_CPUS: "4" } }, "admin"), { status: 503 });
});

test("saved configuration uses provider startup validation before committing", async () => {
  const backing = createMemoryMap<StoredSandboxConfiguration>();
  const store = createSandboxConfiguration({
    backing,
    config: loadConfig({
      DATABASE_URL: "postgresql://localhost/unused",
      CONNECTOR_SECRET_KEY: key,
      SANDBOX_BACKEND: "local",
      E2B_API_KEY: "test-e2b",
      MODAL_TOKEN_ID: "test-id",
      MODAL_TOKEN_SECRET: "test-secret",
      SPRITES_TOKEN: "test-sprites",
    }),
  });
  for (const set of [
    { SANDBOX_BACKEND: "aws" },
    { E2B_MAX_LIFETIME_SEC: "30" },
    { E2B_EGRESS_PROXY_URL: "https://proxy.example:8443" },
    { MODAL_SNAPSHOT_RETENTION_SEC: "0" },
    { MODAL_EGRESS_PROXY_URL: "http://proxy.example" },
    { SPRITES_EGRESS_PROXY_ADDITIONAL_URLS: "https://proxy.example" },
  ]) {
    await assert.rejects(store.write({ expectedVersion: null, set }, "admin"), { status: 400 });
    assert.equal(await backing.get("org:default-org"), null);
  }
  await store.write({ expectedVersion: null, set: { EAGER_PROVISION: " true " } }, "admin");
  const first = await store.read();
  assert.equal((first.nextStartup as { eagerProvisionEnabled: boolean }).eagerProvisionEnabled, true);
  await store.write({ expectedVersion: first.version, set: { EAGER_PROVISION: "none" } }, "admin");
  const second = await store.read();
  assert.equal((second.nextStartup as { eagerProvisionEnabled: boolean }).eagerProvisionEnabled, false);
});

test(
  "PostgreSQL settings survive startup and concurrent edits cannot overwrite one another",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const maps = createPostgresMapFactory(process.env.DATABASE_URL!);
    const env = {
      DATABASE_URL: process.env.DATABASE_URL!,
      CONNECTOR_SECRET_KEY: key,
      ORG_ID: "sandbox-settings-test",
      SANDBOX_BACKEND: "local",
      LOCAL_SANDBOX_CPUS: "1",
    };
    const backing = maps.map<StoredSandboxConfiguration>("sandbox_configuration");
    try {
      const store = createSandboxConfiguration({ backing, config: loadConfig(env) });
      await store.write({ expectedVersion: null, set: { LOCAL_SANDBOX_CPUS: "2" } }, "admin");
      const read = await store.read();
      const results = await Promise.allSettled([
        store.write({ expectedVersion: read.version, set: { LOCAL_SANDBOX_CPUS: "3" } }, "one"),
        store.write({ expectedVersion: read.version, set: { LOCAL_SANDBOX_CPUS: "4" } }, "two"),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const loaded = await loadStartupConfig(env);
      assert.ok([3, 4].includes(loaded.localSandbox.cpus!));
      const restarted = createSandboxConfiguration({ backing, config: loaded });
      const state = await restarted.read();
      assert.equal(state.restartRequired, false);
      assert.equal(state.version, state.appliedVersion);
      const firstBoot = await loadStartupConfig({ ...env, ORG_ID: "new-org" });
      assert.equal(firstBoot.localSandbox.cpus, 1);
    } finally {
      await maps.pool.close();
    }
  },
);
