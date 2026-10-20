import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateEntryTokens,
  overBudgetFraction,
  planCompaction,
  summarizedDocuments,
  withSummarizedDocuments,
} from "../src/harness/context-compaction.ts";
import { estimateDocumentTokens } from "../src/core/document-kinds.ts";
import { createContextSummaryPayload } from "../src/sessions/session-store.ts";
import type { ScopeId, SessionEntry } from "../src/types.ts";

let seq = 0;
function entry(type: SessionEntry["type"], payload: unknown): SessionEntry {
  seq += 1;
  return {
    sessionId: "budget",
    seq,
    parentSeq: null,
    type,
    payload,
    scopeLabel: "personal:tester" as ScopeId,
    createdAt: seq,
  };
}

const pdf = (name: string, artifactId: string, sizeBytes = 1_000_000) => ({
  name,
  mimetype: "application/pdf",
  sizeBytes,
  direction: "in" as const,
  artifactId,
});

test("a user entry's document attachments count at their expanded size", () => {
  const plain = entry("user", { text: "please review" });
  const withPdf = entry("user", { text: "please review", attachments: [pdf("contract.pdf", "f1")] });
  assert.ok(estimateEntryTokens(withPdf) - estimateEntryTokens(plain) >= 250_000);
  const outbound = entry("user", {
    text: "please review",
    attachments: [{ ...pdf("contract.pdf", "f1"), direction: "out" }],
  });
  assert.equal(estimateEntryTokens(outbound), estimateEntryTokens(plain));
  assert.ok(estimateDocumentTokens({ name: "notes.txt", mimetype: "text/plain", sizeBytes: 50_000_000 }) <= 50_000);
});

test("history that is small in words but carries large PDFs compacts them out of the kept window", () => {
  const budget = 1_000_000;
  const history = [
    entry("user", { text: "here are the agreements", attachments: [pdf("a.pdf", "fa"), pdf("b.pdf", "fb")] }),
    entry("assistant", { text: "Read both." }),
    entry("user", { text: "and the amendment", attachments: [pdf("c.pdf", "fc")] }),
    entry("assistant", { text: "Read it." }),
    entry("user", { text: "and the exhibits", attachments: [pdf("d.pdf", "fd"), pdf("e.pdf", "fe")] }),
    entry("assistant", { text: "Read them." }),
  ];
  assert.ok(overBudgetFraction(history, budget, 0.9), "five 1MB PDFs no longer look like a few hundred tokens");
  const plan = planCompaction(history, budget, 0.6);
  assert.ok(plan);
  const keptDocuments = summarizedDocuments(plan.kept).length;
  assert.ok(keptDocuments * 250_000 <= budget * 0.6, `kept ${keptDocuments} documents`);
  assert.deepEqual(
    summarizedDocuments(plan.toSummarize).map((document) => document.name),
    ["a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf"].slice(0, 5 - keptDocuments),
  );
});

test("summaries list compacted documents once and carry them forward", () => {
  const first = summarizedDocuments([
    entry("user", { text: "x", attachments: [pdf("a.pdf", "fa"), pdf("b.pdf", "fb")] }),
  ]);
  const text = withSummarizedDocuments("Earlier: reviewed two agreements.", first);
  assert.match(text, /"a\.pdf" \(file fa\)/);
  assert.match(text, /GET \$AGENT_API_URL\/v1\/files\/<file id>\/content/);
  assert.equal(withSummarizedDocuments(text, first), text);
  const prior = entry("system", createContextSummaryPayload(1, text, first));
  const carried = summarizedDocuments([
    prior,
    entry("user", { text: "y", attachments: [pdf("c.pdf", "fc"), pdf("a.pdf", "fa")] }),
  ]);
  assert.deepEqual(
    carried.map((document) => document.artifactId),
    ["fb", "fc", "fa"],
  );
  const next = withSummarizedDocuments(`New summary.\n\n${text}`, carried);
  assert.equal(next.match(/no longer included inline/g)?.length, 1);
  assert.match(next, /"c\.pdf" \(file fc\)/);
  assert.equal(withSummarizedDocuments(next, []), "New summary.\n\nEarlier: reviewed two agreements.");
});
