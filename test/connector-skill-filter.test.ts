import test from "node:test";
import assert from "node:assert/strict";
import { filterConnectorSkills } from "../src/core/orchestrator.ts";
import type { SkillResolution } from "../src/skills/skill-store.ts";
import { scopeId } from "../src/types.ts";

function skill(name: string, connector?: string): SkillResolution {
  return {
    skill: {
      id: name,
      scopeId: scopeId("org", "acme"),
      manifest: { name, description: name, requiredCapabilities: [], ...(connector ? { connector } : {}), body: name },
      signature: "sig",
      status: "published",
      createdBy: "test",
      version: 1,
      grantedCapabilities: [],
      approvals: [],
      createdAt: 1,
      updatedAt: 1,
    },
    shadowed: [],
  };
}

const names = (resolved: SkillResolution[]) => resolved.map((entry) => entry.skill?.manifest.name);

test("a skill declaring a connector is hidden until the admin configures that provider", () => {
  const all = [
    skill("memory"),
    skill("google-workspace", "google"),
    skill("dropbox", "dropbox"),
    skill("linear", "linear"),
    skill("slack-drafts", "slack"),
  ];
  assert.deepEqual(names(filterConnectorSkills(all, [])), ["memory"]);
  assert.deepEqual(names(filterConnectorSkills(all, ["google", "linear"])), ["memory", "google-workspace", "linear"]);
  assert.deepEqual(names(filterConnectorSkills(all, ["slack"])), ["memory", "slack-drafts"]);
});

test("visibility follows the manifest field, not the skill name", () => {
  assert.deepEqual(names(filterConnectorSkills([skill("google-workspace"), skill("notes", "notion")], [])), [
    "google-workspace",
  ]);
  assert.deepEqual(names(filterConnectorSkills([skill("notes", "notion")], ["notion"])), ["notes"]);
});
