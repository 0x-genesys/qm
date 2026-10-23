import { isObj } from "../util/objects.ts";

/**
 * Readable text for Slack messages whose content lives in Block Kit `blocks`
 * or legacy `attachments` rather than the top-level `text` field. Integration
 * bots (Amazon Q Developer / AWS Chatbot, CI, monitoring) often post with an
 * empty `text`, so without this the mirror and wake context see a blank message.
 */

const MAX_DERIVED_CHARS = 4_000;
const MAX_ATTACHMENTS = 10;
const MAX_DEPTH = 6;

type Obj = Record<string, unknown>;

function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function textObject(v: unknown): string {
  if (typeof v === "string") return v.trim();
  return isObj(v) ? s(v.text) : "";
}

function richElement(el: unknown, depth: number): string {
  if (!isObj(el) || depth > MAX_DEPTH) return "";
  switch (el.type) {
    case "text":
      return typeof el.text === "string" ? el.text : "";
    case "link":
      return s(el.text) && s(el.url) ? `<${s(el.url)}|${s(el.text)}>` : s(el.url) || s(el.text);
    case "user":
      return s(el.user_id) ? `<@${s(el.user_id)}>` : "";
    case "channel":
      return s(el.channel_id) ? `<#${s(el.channel_id)}>` : "";
    case "usergroup":
      return s(el.usergroup_id) ? `<!subteam^${s(el.usergroup_id)}>` : "";
    case "broadcast":
      return s(el.range) ? `<!${s(el.range)}>` : "";
    case "emoji":
      return s(el.name) ? `:${s(el.name)}:` : "";
    case "date":
      return s(el.fallback);
    case "rich_text_section":
      return richChildren(el.elements, depth + 1).join("");
    case "rich_text_preformatted":
      return "```" + richChildren(el.elements, depth + 1).join("") + "```";
    case "rich_text_quote":
      return richChildren(el.elements, depth + 1)
        .join("")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "rich_text_list":
      return richChildren(el.elements, depth + 1)
        .map((item) => `• ${item}`)
        .join("\n");
    default:
      return "";
  }
}

function richChildren(elements: unknown, depth: number): string[] {
  return (Array.isArray(elements) ? elements : []).map((el) => richElement(el, depth));
}

function blockText(block: unknown, depth: number): string {
  if (!isObj(block) || depth > MAX_DEPTH) return "";
  switch (block.type) {
    case "header":
      return textObject(block.text);
    case "section": {
      const parts = [textObject(block.text)];
      for (const field of Array.isArray(block.fields) ? block.fields : []) parts.push(textObject(field));
      return parts.filter(Boolean).join("\n");
    }
    case "context":
      return (Array.isArray(block.elements) ? block.elements : [])
        .map((el) => (isObj(el) && (el.type === "mrkdwn" || el.type === "plain_text") ? s(el.text) : ""))
        .filter(Boolean)
        .join(" ");
    case "rich_text":
      return richChildren(block.elements, depth + 1)
        .filter(Boolean)
        .join("\n")
        .trim();
    case "markdown":
      return s(block.text);
    default:
      return "";
  }
}

export function blocksText(blocks: unknown, depth = 0): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((b) => blockText(b, depth))
    .filter(Boolean)
    .join("\n");
}

/** Forwards and link unfurls are rendered (or deliberately skipped) elsewhere. */
function isContentAttachment(a: Obj): boolean {
  return !(
    a.is_msg_unfurl === true ||
    a.is_share === true ||
    a.is_app_unfurl === true ||
    typeof a.from_url === "string" ||
    typeof a.original_url === "string"
  );
}

function attachmentText(a: Obj): string {
  const parts: string[] = [];
  const pre = s(a.pretext);
  if (pre) parts.push(pre);
  const author = s(a.author_name);
  if (author) parts.push(author);
  const title = s(a.title);
  if (title) parts.push(s(a.title_link) ? `<${s(a.title_link)}|${title}>` : title);
  const body = s(a.text);
  if (body) parts.push(body);
  for (const field of Array.isArray(a.fields) ? a.fields : []) {
    if (!isObj(field)) continue;
    const name = s(field.title);
    const value = s(field.value);
    if (name || value) parts.push(name && value ? `${name}: ${value}` : name || value);
  }
  const nested = blocksText(a.blocks, 1);
  if (nested) parts.push(nested);
  const footer = s(a.footer);
  if (footer) parts.push(footer);
  if (!parts.length) {
    const fallback = s(a.fallback);
    if (fallback) parts.push(fallback);
  }
  return parts.join("\n");
}

function cap(text: string): string {
  return text.length > MAX_DERIVED_CHARS ? `${text.slice(0, MAX_DERIVED_CHARS)}…` : text;
}

/**
 * Text to show for a message given its top-level `text`. Block Kit content is
 * used only when `text` is blank (Slack sets `text` as the blocks' fallback, so
 * for ordinary messages it would duplicate). Legacy, non-forward, non-unfurl
 * attachments are appended unless their text is already present.
 */
export function withRichContent(message: { text?: unknown; blocks?: unknown; attachments?: unknown }): string {
  const base = typeof message.text === "string" ? message.text : "";
  const parts: string[] = [];
  if (!base.trim()) {
    const fromBlocks = blocksText(message.blocks);
    if (fromBlocks) parts.push(fromBlocks);
  }
  const attachments = (Array.isArray(message.attachments) ? message.attachments : [])
    // A timestamped attachment beside real text is usually a quoted/shared
    // message reference; keep the old behavior of not inlining it. When the
    // text is blank it is the only content, so render it.
    .filter((a): a is Obj => isObj(a) && isContentAttachment(a) && (!base.trim() || a.ts === undefined))
    .slice(0, MAX_ATTACHMENTS);
  for (const a of attachments) {
    const rendered = attachmentText(a);
    if (rendered && !base.includes(rendered) && !parts.some((p) => p.includes(rendered))) parts.push(rendered);
  }
  if (!parts.length) return base;
  const derived = cap(parts.join("\n"));
  return base.trim() ? `${base}\n${derived}` : derived;
}
