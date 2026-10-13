import assert from "node:assert/strict";
import { test } from "node:test";
import { journeyTestOptions, startJourneyApp } from "./support/journey-app.ts";

const PROVIDER_REQUEST_BYTES = 10 * 1024 * 1024;
const PROVIDER_CONTEXT_TOKENS = 1_000_000;
const TURNS = 42;
const CSV_LINES = 25_000;
const BIG_CSV_LINES = 120_000;
const PDF_BYTES = 2_400_000;

function ledgerCsv(turn: number, lines = CSV_LINES): Uint8Array {
  const rows = Array.from({ length: lines }, (_, i) => `${turn}-${i},${(i * 37) % 1000},${(i * 91) % 977}.${i % 100}`);
  return Buffer.from(`id,debit,credit\n${rows.join("\n")}\n`);
}

function statementPdf(turn: number): Uint8Array {
  const page = `BT /F1 24 Tf 72 720 Td (Statement for turn ${turn}) Tj ET`;
  const scan = Buffer.alloc(PDF_BYTES, 0x41);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${page.length} >>\nstream\n${page}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${scan.length} >>\nstream\n${scan.toString("latin1")}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("a long web session with repeated uploads keeps answering", journeyTestOptions(600_000), async () => {
  const app = await startJourneyApp(
    {
      maxRequestBytes: PROVIDER_REQUEST_BYTES,
      contextWindowTokens: PROVIDER_CONTEXT_TOKENS,
      maxOutputTokens: 32_000,
    },
    { securityScreen: "observe" },
  );
  app.gateway.respond = (req) =>
    JSON.stringify(req.system).includes("security boundary classifier")
      ? { text: '{"decision":"auto"}' }
      : { text: `reply ${req.messages.length}` };
  const actor = "analyst@example.com";
  const threadRef = `web:${actor}:finance-${Date.now()}`;
  const outcomes: Array<{ turn: number; status: string; reason?: string; reply?: string }> = [];
  try {
    for (let turn = 1; turn <= TURNS; turn++) {
      const attachments = [];
      if (turn % 5 === 0) attachments.push(await app.upload(`ledger-${turn}.csv`, "text/csv", ledgerCsv(turn)));
      if (turn % 14 === 0)
        attachments.push(await app.upload(`statement-${turn}.pdf`, "application/pdf", statementPdf(turn)));
      if (turn === 22)
        attachments.push(await app.upload("full-year-export.csv", "text/csv", ledgerCsv(turn, BIG_CSV_LINES)));
      const text = attachments.length
        ? `Turn ${turn}: here is the next batch, reconcile it against the earlier ones.`
        : `Turn ${turn}: what is the running total so far?`;
      const result = await app.webTurn(actor, threadRef, text, attachments);
      outcomes.push({ turn, status: result.status, reason: result.reason, reply: result.reply });
    }
    const unanswered = outcomes.filter((o) => o.status !== "ok" || !o.reply?.trim());
    assert.deepEqual(
      unanswered,
      [],
      `every turn gets a reply; provider rejections: ${JSON.stringify(app.gateway.rejected.slice(0, 3))}`,
    );
    assert.deepEqual(app.gateway.rejected, [], "no request exceeded the provider's byte or token limit");
  } finally {
    await app.stop();
  }
});
