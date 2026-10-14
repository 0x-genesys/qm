// Quote-then-answer threads: a reply that answers several quoted points can be split into side-by-side
// columns inside the same session pane. Each column is a lightweight fork of the session cut at the
// reply; it sees the shared context up to the split plus its own column, and never appears in the
// sidebar. Folding back collapses the columns into the vertical transcript again.
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { ArrowUp, Columns3, CornerDownRight, FoldHorizontal, X } from "lucide";
import { api } from "./core-bridge";
import { icon } from "./icons";
import { markdown } from "./message-markdown";
import { waveLoader } from "./ui";
import type { QuotedPoint, QuotedReply } from "./quoted-reply";

export { parseQuotedReply } from "./quoted-reply";

interface ThreadTurn {
  role: "user" | "assistant";
  text: string;
}

interface ThreadColumn {
  point: QuotedPoint;
  threadSessionId: string | null;
  turns: ThreadTurn[];
  draft: string;
  sending: boolean;
  error: string;
}

export interface ThreadSummary {
  quote: string;
  line: string;
}

interface ThreadSplit {
  key: string;
  sessionId: string;
  fromSeq: number;
  status: "opening" | "open" | "folding" | "folded";
  columns: ThreadColumn[];
  summaries: ThreadSummary[];
  error: string;
}

const splits = new Map<string, ThreadSplit>();
const listeners = new Set<() => void>();

let version = 0;

/** Bumps on every thread change; transcript row caches key on it. */
export function threadsVersion(): number {
  return version;
}

function changed(): void {
  version++;
  for (const listener of listeners) listener();
}

/** Re-render the transcript whenever thread state changes. Returns an unsubscribe. */
export function onThreadsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function threadKey(sessionId: string, seq: number): string {
  return `${sessionId}:${seq}`;
}

export function threadSplit(sessionId: string | null, seq: number | undefined): ThreadSplit | undefined {
  if (!sessionId || seq === undefined) return undefined;
  return splits.get(threadKey(sessionId, seq));
}

/** Open (or reopen) the columns for a reply. Each point gets its own hidden fork of the session. */
export async function splitIntoThreads(sessionId: string, fromSeq: number, reply: QuotedReply): Promise<void> {
  const key = threadKey(sessionId, fromSeq);
  const existing = splits.get(key);
  if (existing && existing.status !== "folded") return;
  const split: ThreadSplit = existing ?? {
    key,
    sessionId,
    fromSeq,
    status: "opening",
    columns: reply.points.map((point) => ({
      point,
      threadSessionId: null,
      turns: [],
      draft: "",
      sending: false,
      error: "",
    })),
    summaries: [],
    error: "",
  };
  split.status = existing ? "open" : "opening";
  split.error = "";
  splits.set(key, split);
  changed();
  if (existing) return;
  try {
    const { threads } = await api<{ threads: { sessionId: string }[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/threads`,
      { method: "POST", body: JSON.stringify({ fromSeq, points: reply.points.map((p) => p.quote) }) },
    );
    split.columns.forEach((column, i) => (column.threadSessionId = threads[i]?.sessionId ?? null));
    split.status = "open";
  } catch (err) {
    splits.delete(key);
    split.error = err instanceof Error ? err.message : "Could not split into threads.";
  }
  changed();
}

async function sendInColumn(split: ThreadSplit, column: ThreadColumn): Promise<void> {
  const text = column.draft.trim();
  if (!text || column.sending || !column.threadSessionId) return;
  column.turns.push({ role: "user", text });
  column.draft = "";
  column.sending = true;
  column.error = "";
  changed();
  try {
    const { reply } = await api<{ reply: string }>(
      `/api/sessions/${encodeURIComponent(column.threadSessionId)}/thread-turns`,
      { method: "POST", body: JSON.stringify({ text }) },
    );
    column.turns.push({ role: "assistant", text: reply });
  } catch (err) {
    column.error = err instanceof Error ? err.message : "Reply failed.";
  } finally {
    column.sending = false;
    changed();
  }
}

async function foldBack(split: ThreadSplit): Promise<void> {
  if (split.status !== "open") return;
  split.status = "folding";
  changed();
  const active = split.columns.filter((c) => c.turns.length && c.threadSessionId);
  try {
    const { summaries } = active.length
      ? await api<{ summaries: { threadSessionId: string; line: string }[] }>(
          `/api/sessions/${encodeURIComponent(split.sessionId)}/threads/fold`,
          { method: "POST", body: JSON.stringify({ threads: active.map((c) => c.threadSessionId) }) },
        )
      : { summaries: [] };
    split.summaries = active.map((c) => ({
      quote: c.point.quote,
      line: summaries.find((s) => s.threadSessionId === c.threadSessionId)?.line ?? "",
    }));
    split.status = "folded";
  } catch (err) {
    split.status = "open";
    split.error = err instanceof Error ? err.message : "Could not fold the threads back.";
  }
  changed();
}

function dropSummary(split: ThreadSplit, index: number): void {
  split.summaries.splice(index, 1);
  changed();
}

/** The control in a reply's hover footer. */
export function splitButton(onSplit: () => void, count: number, busy: boolean): TemplateResult {
  return html`<button
    class="msg-copy msg-split"
    type="button"
    title=${`Split into ${count} threads`}
    aria-label=${`Split into ${count} threads`}
    ?disabled=${busy}
    @click=${onSplit}
  >
    ${busy ? waveLoader({ width: 13, height: 13, label: "Splitting" }) : icon(Columns3, 13)}
  </button>`;
}

/** One-line remains of folded threads, shown under the reply in the vertical transcript. */
export function foldedThreads(split: ThreadSplit, reopen: () => void): TemplateResult | typeof nothing {
  if (split.status !== "folded" || !split.summaries.length) return nothing;
  return html`<div class="thread-summaries" role="list" aria-label="Folded threads">
    ${split.summaries.map(
      (s, i) =>
        html`<div class="thread-summary" role="listitem">
          ${icon(CornerDownRight, 13)}
          <button class="thread-summary-text" type="button" title="Reopen threads" @click=${reopen}>
            <span class="thread-summary-quote">${clip(s.quote, 48)}</span>
            <span class="thread-summary-line">${s.line}</span>
          </button>
          <button
            class="thread-summary-drop"
            type="button"
            title="Drop this summary"
            aria-label="Drop this summary"
            @click=${() => dropSummary(split, i)}
          >
            ${icon(X, 12)}
          </button>
        </div>`,
    )}
  </div>`;
}

function clip(text: string, n: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

class ThreadSplitView extends LitElement {
  static properties = { split: { attribute: false } };
  declare split: ThreadSplit;

  private unsubscribe?: () => void;

  protected createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    // Column state is mutated in place, so a changed `split` reference can't be relied on.
    this.unsubscribe = onThreadsChange(() => this.requestUpdate());
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
  }

  private send(column: ThreadColumn): void {
    void sendInColumn(this.split, column).then(() => this.scrollColumn(column));
    this.scrollColumn(column);
  }

  private scrollColumn(column: ThreadColumn): void {
    const index = this.split.columns.indexOf(column);
    requestAnimationFrame(() => {
      const body = this.querySelectorAll<HTMLElement>(".thread-col-body")[index];
      body?.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
    });
  }

  private onKey(e: KeyboardEvent, column: ThreadColumn): void {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.send(column);
    }
  }

  private column(column: ThreadColumn, index: number): TemplateResult {
    const ready = Boolean(column.threadSessionId);
    return html`<section class="thread-col" aria-label=${`Thread ${index + 1}`}>
      <header class="thread-col-quote" title=${column.point.quote}>${markdown(column.point.quote)}</header>
      <div class="thread-col-body">
        <div class="thread-col-answer">${markdown(column.point.answer)}</div>
        ${column.turns.map((turn) =>
          turn.role === "user"
            ? html`<div class="thread-turn thread-user"><div class="thread-user-bubble">${turn.text}</div></div>`
            : html`<div class="thread-turn thread-assistant">${markdown(turn.text)}</div>`,
        )}
        ${column.sending ? html`<div class="thread-turn thread-pending">${waveLoader({ width: 18, height: 12, label: "Replying" })}</div>` : nothing}
        ${column.error ? html`<div class="composer-error inline">${column.error}</div>` : nothing}
      </div>
      <form
        class="thread-composer"
        @submit=${(e: Event) => {
          e.preventDefault();
          this.send(column);
        }}
      >
        <textarea
          rows="1"
          .value=${column.draft}
          placeholder=${ready ? "Reply in this thread" : "Opening thread…"}
          aria-label=${`Reply in thread ${index + 1}`}
          ?disabled=${!ready}
          @input=${(e: Event) => {
            const el = e.target as HTMLTextAreaElement;
            column.draft = el.value;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
            this.requestUpdate();
          }}
          @keydown=${(e: KeyboardEvent) => this.onKey(e, column)}
        ></textarea>
        <button
          class="thread-send"
          type="submit"
          aria-label="Send"
          ?disabled=${!ready || column.sending || !column.draft.trim()}
        >
          ${icon(ArrowUp, 14)}
        </button>
      </form>
    </section>`;
  }

  protected render() {
    const split = this.split;
    if (!split) return nothing;
    const busy = split.status === "opening" || split.status === "folding";
    return html`<div
      class="thread-split ${split.columns.length > 3 ? "scrolls" : ""}"
      aria-busy=${busy ? "true" : "false"}
    >
      <div class="thread-split-bar">
        <span class="thread-split-label">${icon(Columns3, 13)} ${split.columns.length} threads</span>
        <button class="thread-fold" type="button" ?disabled=${busy} @click=${() => void foldBack(split)}>
          ${split.status === "folding" ? waveLoader({ width: 13, height: 13, label: "Folding" }) : icon(FoldHorizontal, 13)}
          Fold back
        </button>
      </div>
      ${split.error ? html`<div class="composer-error inline">${split.error}</div>` : nothing}
      <div class="thread-cols" role="group" aria-label="Threads">
        ${repeat(
          split.columns,
          (_c, i) => i,
          (c, i) => this.column(c, i),
        )}
      </div>
    </div>`;
  }
}

if (!customElements.get("qm-thread-split")) customElements.define("qm-thread-split", ThreadSplitView);
