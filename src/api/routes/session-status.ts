import type { Run } from "../../runs/run-store.ts";
import type { TurnResult } from "../../types.ts";
import { isWebhookThreadRef } from "../../webhooks/webhook-store.ts";
import { bearerMatches, sendJson } from "../http.ts";
import type { BaseCtx, Route } from "./route.ts";

type SessionState = "accepted" | "queued" | "running" | "idle" | "failed";

const MAX_KEY_LENGTH = 512;
const FAILED_OUTCOMES: ReadonlySet<TurnResult["status"]> = new Set(["failed", "refused", "pending_approval"]);

function stateOf(run: Run | null): SessionState {
  if (!run) return "accepted";
  if (run.status === "pending") return "queued";
  if (run.status === "running") return "running";
  if (run.status === "failed" || (run.result && FAILED_OUTCOMES.has(run.result.status))) return "failed";
  return "idle";
}

async function sessionStatus(ctx: BaseCtx): Promise<void> {
  const { req, res, deps, url } = ctx;
  const token = deps.sessionStatusToken;
  if (!token) return sendJson(res, 404, { error: "not_found" });
  if (!bearerMatches(req, token)) return sendJson(res, 401, { error: "unauthorized" });
  const { sessions, runs } = deps;
  if (!sessions || !runs) return sendJson(res, 503, { error: "session_status_unavailable" });
  const key = url.searchParams.get("session") ?? "";
  if (!key || key.length > MAX_KEY_LENGTH)
    return sendJson(res, 400, { error: "bad_request", message: "session must be a sessionRef or sessionId" });
  const byRef = isWebhookThreadRef(key);
  const session = byRef ? await sessions.getByThread(key) : await sessions.get(key);
  if (!byRef && (!session || !isWebhookThreadRef(session.threadRef))) return sendJson(res, 404, { error: "not_found" });
  const sessionRef = byRef ? key : session!.threadRef;
  const run = await runs.latestForThread(sessionRef);
  sendJson(res, 200, {
    sessionRef,
    sessionId: session?.id ?? null,
    state: stateOf(run),
    outcome: run?.result?.status ?? null,
    runId: run?.id ?? null,
    queuedAt: run?.createdAt ?? null,
    startedAt: run?.startedAt ?? null,
    finishedAt: run?.finishedAt ?? null,
  });
}

export const sessionStatusRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "GET", path: "/v1/session-status", auth: "public", handle: sessionStatus },
];
