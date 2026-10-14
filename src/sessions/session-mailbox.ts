import type { DurableMap } from "../persistence/durable-map.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";

export interface SessionMessage {
  id: string;
  recipientId: string;
  senderId: string;
  actor: OrchestratorInput["actor"];
  text: string;
  sourceEntrySeq?: number;
  audience: OrchestratorInput["conversation"]["audience"];
  createdAt: number;
  consumed?: boolean;
  wake?: { request: OrchestratorInput; mode: "steer" | "notify"; dedupKey: string };
  wakePending?: boolean;
}

export function createSessionMailbox(backing: DurableMap<SessionMessage>) {
  return {
    async send(message: SessionMessage): Promise<SessionMessage> {
      return backing.putIfAbsent(message.id, message);
    },
    async wakeable(afterId?: string): Promise<SessionMessage[]> {
      return backing.select({ where: { field: "wakePending", anyOfFold: ["true"] }, limit: 100, afterId });
    },
    async settleWake(id: string): Promise<void> {
      await backing.merge(id, { wakePending: false });
    },
    async pending(recipientId: string): Promise<SessionMessage[]> {
      const rows = await backing.select({ where: { field: "recipientId", anyOfFold: [recipientId] } });
      return rows.filter((row) => !row.consumed).sort((a, b) => a.createdAt - b.createdAt);
    },
    async acknowledge(recipientId: string, ids: string[]): Promise<void> {
      for (const id of ids) {
        const row = await backing.get(id);
        if (row?.recipientId === recipientId) await backing.merge(id, { consumed: true });
      }
    },
  };
}

export type SessionMailbox = ReturnType<typeof createSessionMailbox>;
