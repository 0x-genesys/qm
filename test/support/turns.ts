import { randomUUID } from "node:crypto";
import { createPostgresRunStore } from "../../src/runs/postgres-run-store.ts";
import type { Run, RunStore } from "../../src/runs/run-store.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import type { SessionStore } from "../../src/sessions/session-store.ts";
import type { TurnResult } from "../../src/types.ts";
import { registerAbsurdSchema, TURN_QUEUES } from "../../src/turns/absurd-schema.ts";
import { bindTurnLedger } from "../../src/turns/turn-engine.ts";
import { createTurnLedger, type TurnLedger } from "../../src/turns/turn-ledger.ts";
import { freshTestDatabase } from "./test-database.ts";

export interface ClaimedTurn {
  run: Run;
  token: string;
  ledger: TurnLedger;
}

export async function claimTurn(ledger: TurnLedger, runId?: string): Promise<ClaimedTurn | null> {
  const passed: ClaimedTurn[] = [];
  try {
    for (const queue of TURN_QUEUES) {
      for (;;) {
        const token = `test:${randomUUID()}`;
        const { claimed, run } = await ledger.claim(queue, token, "test");
        if (!claimed) break;
        if (!run) continue;
        if (!runId || run.id === runId) return { run, token, ledger };
        passed.push({ run, token, ledger });
      }
    }
    return null;
  } finally {
    for (const other of passed) await ledger.handBack(other.run, other.token, { unstarted: true });
  }
}

export function finishTurn(
  claimed: ClaimedTurn,
  result: TurnResult,
  status: "done" | "failed" = "done",
): Promise<boolean> {
  return claimed.ledger.finish(claimed.run, claimed.token, { status, result });
}

export interface TestRunStore {
  runs: RunStore;
  ledger: TurnLedger;
  sessions: SessionStore;
  databaseUrl: string;
  close(): Promise<void>;
}

export function testRunStore(databaseUrl = freshTestDatabase()): TestRunStore {
  registerAbsurdSchema(databaseUrl);
  const sessions = createPostgresSessionStore(databaseUrl);
  const store = createPostgresRunStore(databaseUrl);
  const ledger = createTurnLedger(databaseUrl, { onTerminal: (run) => store.runs.emitTerminal?.(run) });
  const runs: RunStore = { ...store.runs, ...bindTurnLedger(store.runs, ledger) };
  return {
    runs,
    ledger,
    sessions,
    databaseUrl,
    async close() {
      await ledger.close();
      await store.close();
    },
  };
}
