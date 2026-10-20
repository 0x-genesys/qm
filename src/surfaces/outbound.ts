import { createHash } from "node:crypto";
import type { DeliveryProvenance, Destination, OutgoingAttachment, ScopeId } from "../types.ts";
import type { TurnOrigin } from "../core/turn-origin.ts";
import { acquireLeaseWithin, type SessionStore } from "../sessions/session-store.ts";
import type { SessionStateBus } from "../runs/session-state-bus.ts";
import type { IdempotencyStore } from "../idempotency/idempotency-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { errMessage, reportFailure } from "../util/errors.ts";

/** One message for a surface. The surface's sender posts it before `send` resolves; the key keeps retries idempotent. */
export interface OutboundPost {
  destination: Destination;
  text: string;
  attachments?: OutgoingAttachment[];
  idempotencyKey: string;
  provenance?: DeliveryProvenance;
  /** When the content was produced, if well before now (a recovered run reply); bounds Slack's duplicate check. */
  createdAt?: number;
  /** A resend after a failed attempt that Slack may have accepted anyway: check for an earlier copy first. */
  retry?: boolean;
}

export interface PostReceipt {
  /** A Slack DM post: the DM thread it landed in. */
  recipientThreadRef?: string;
  /** A live turn handler owns this run's reply, so nothing was posted. */
  deferred?: boolean;
  /** The surface failed transiently; the post is saved and `retryQueued` sends it once the surface recovers. */
  queued?: boolean;
}

export type SurfaceSender = (post: OutboundPost) => Promise<PostReceipt | void>;

export interface Outbound {
  send(post: OutboundPost): Promise<PostReceipt | void>;
  register(types: readonly string[], sender: SurfaceSender): () => void;
  /** Re-sends posts that failed transiently; returns how many went out. */
  retryQueued(now?: number): Promise<number>;
}

/** A post whose surface was unreachable, kept until it goes out or ages out. */
export interface QueuedPost {
  post: OutboundPost;
  firstFailedAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
}

const RETRY_MAX_AGE_MS = 6 * 60 * 60_000;
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_BACKOFF_MS = 10 * 60_000;
const retryDelay = (attempts: number): number => Math.min(RETRY_MAX_BACKOFF_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
const isPermanent = (error: unknown): boolean => (error as { permanent?: boolean } | null)?.permanent === true;

const DEFERRED = new Error("deferred to a live turn handler");

/**
 * Routes each post to the sender its surface registered. A key that already went out is not sent again (the
 * shared idempotency store remembers it across processes). With `retries`, a transient surface failure (Slack
 * down, rate limited) saves the post and counts it as sent; `retryQueued` keeps trying it with backoff for up to
 * six hours. Without `retries`, or for a permanent refusal, the error is thrown and the key is not remembered.
 */
export function createOutbound(opts: {
  idempotency?: Pick<IdempotencyStore, "once">;
  retries?: DurableMap<QueuedPost>;
  afterSend?: (post: OutboundPost, receipt: PostReceipt) => void;
}): Outbound {
  const senders = new Map<string, SurfaceSender[]>();
  const senderFor = (type: string): SurfaceSender | undefined => senders.get(type)?.at(-1);
  const once =
    opts.idempotency?.once.bind(opts.idempotency) ?? (async (_: string, fn: () => Promise<void>) => (await fn(), true));
  // Web posts are local transcript writes; a failure there is not a surface outage worth replaying.
  const retryable = (post: OutboundPost, error: unknown): boolean =>
    Boolean(opts.retries) && post.destination.type !== "web" && !isPermanent(error);
  return {
    async send(post) {
      const sender = senderFor(post.destination.type);
      if (!sender) throw new Error(`no ${post.destination.type} connection is available to post this message`);
      let receipt: PostReceipt = {};
      let posted = false;
      try {
        await once(`post:${post.idempotencyKey}`, async () => {
          try {
            receipt = (await sender(post)) ?? {};
          } catch (error) {
            if (!retryable(post, error)) throw error;
            const now = Date.now();
            await opts.retries!.put(post.idempotencyKey, {
              post,
              firstFailedAt: now,
              attempts: 1,
              nextAttemptAt: now + retryDelay(1),
              lastError: errMessage(error),
            });
            reportFailure("outbound: post failed, queued for retry", error, `key=${post.idempotencyKey}`);
            receipt = { queued: true };
            return;
          }
          if (receipt.deferred) throw DEFERRED;
          posted = true;
        });
      } catch (error) {
        if (error === DEFERRED) return { deferred: true };
        throw error;
      }
      if (posted) opts.afterSend?.(post, receipt);
      return receipt;
    },
    register(types, sender) {
      for (const type of types) senders.set(type, [...(senders.get(type) ?? []), sender]);
      return () => {
        for (const type of types)
          senders.set(
            type,
            (senders.get(type) ?? []).filter((s) => s !== sender),
          );
      };
    },
    async retryQueued(now = Date.now()) {
      if (!opts.retries) return 0;
      let sent = 0;
      for (const [key, queued] of await opts.retries.entries()) {
        if (queued.nextAttemptAt > now) continue;
        const { post } = queued;
        if (now - queued.firstFailedAt > RETRY_MAX_AGE_MS) {
          await opts.retries.delete(key);
          reportFailure("outbound: gave up on a queued post", new Error(queued.lastError), `key=${key}`);
          continue;
        }
        const sender = senderFor(post.destination.type);
        try {
          if (!sender) throw new Error(`no ${post.destination.type} connection is available to post this message`);
          const receipt =
            (await sender({ ...post, retry: true, createdAt: post.createdAt ?? queued.firstFailedAt })) ?? {};
          if (receipt.deferred) continue;
          await opts.retries.delete(key);
          opts.afterSend?.(post, receipt);
          sent += 1;
        } catch (error) {
          if (isPermanent(error)) {
            await opts.retries.delete(key);
            reportFailure("outbound: queued post refused (not retried)", error, `key=${key}`);
            continue;
          }
          const attempts = queued.attempts + 1;
          await opts.retries.put(key, {
            ...queued,
            attempts,
            nextAttemptAt: now + retryDelay(attempts),
            lastError: errMessage(error),
          });
        }
      }
      return sent;
    },
  };
}

export function turnPostProvenance(input: {
  origin: Pick<TurnOrigin, "kind">;
  surface: string | undefined;
  fireKey: string;
  sourceScopeId: ScopeId;
  sourceThreadRef: string;
  sourceSessionId?: string;
  sourceUserSeq?: number;
  sourceAssistantEntrySeq?: number;
}): DeliveryProvenance {
  return {
    trigger: input.origin.kind === "automation" ? (input.surface ?? "wake") : "conversation",
    surface: input.surface ?? "unknown",
    fireKey: input.fireKey,
    sourceScopeId: input.sourceScopeId,
    sourceThreadRef: input.sourceThreadRef,
    ...(input.sourceSessionId !== undefined ? { sourceSessionId: input.sourceSessionId } : {}),
    ...(input.sourceUserSeq !== undefined ? { sourceUserSeq: input.sourceUserSeq } : {}),
    ...(input.sourceAssistantEntrySeq !== undefined ? { sourceAssistantEntrySeq: input.sourceAssistantEntrySeq } : {}),
  };
}

const TRANSCRIPT_LEASE_WAIT_MS = 2 * 60_000;

function keyTurnId(key: string): string {
  const h = createHash("sha256").update(`outbound:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type TranscriptSessions = Pick<
  SessionStore,
  "getByThread" | "acquireLease" | "peekLease" | "releaseLease" | "appendMany" | "getEntries" | "participantsOf"
>;

interface TranscriptDeps {
  sessions: TranscriptSessions;
  sessionStates?: SessionStateBus;
  leaseWaitMs?: number;
}

/**
 * Appends one message to a session, once per key, and tells open web views to reload. Waits for a running turn
 * there to finish first.
 */
export async function appendToTranscript(
  deps: TranscriptDeps,
  session: { id: string; threadRef: string; scopeId: ScopeId },
  entry: { type: "assistant" | "user"; payload: Record<string, unknown> },
  key: string,
  alreadyThere?: () => Promise<boolean>,
): Promise<void> {
  const wait = deps.leaseWaitMs ?? TRANSCRIPT_LEASE_WAIT_MS;
  const { lease } = await acquireLeaseWithin(deps.sessions, session.id, "backfill", wait);
  if (!lease)
    throw Object.assign(
      new Error("that conversation stayed busy, so the message was not added to it — try again shortly"),
      { busy: true },
    );
  const turnId = keyTurnId(key);
  try {
    const present = alreadyThere
      ? await alreadyThere()
      : (await deps.sessions.getEntries(session.id, { turnId })).some((e) => e.type === entry.type);
    if (present) return;
    await deps.sessions.appendMany({ ...lease, turnId }, [{ ...entry, scopeLabel: session.scopeId }]);
  } finally {
    await deps.sessions.releaseLease(lease);
  }
  const participants = await deps.sessions.participantsOf(session.id).catch(() => []);
  deps.sessionStates?.emit({
    threadRef: session.threadRef,
    sessionId: session.id,
    state: "idle",
    at: Date.now(),
    ...(participants.length ? { participants } : {}),
  });
}

/**
 * Web conversations have no transport besides their transcript: a post from elsewhere (a cron, another
 * session, a recovered run reply) becomes an assistant message there. A conversation's own posts are already
 * in its transcript, so they need nothing.
 */
export function createWebSender(deps: {
  sessions: TranscriptSessions;
  sessionStates?: SessionStateBus;
}): SurfaceSender {
  return async (post) => {
    const { destination: dest, provenance } = post;
    const fromElsewhere = provenance !== undefined && provenance.sourceThreadRef !== dest.target;
    if (!post.text.trim() || (dest.webTranscript?.kind !== "reply" && !fromElsewhere)) return;
    const session = await deps.sessions.getByThread(dest.target);
    if (!session) throw new Error(`web conversation ${dest.target} does not exist`);
    await appendToTranscript(deps, session, { type: "assistant", payload: { text: post.text } }, post.idempotencyKey);
  };
}
