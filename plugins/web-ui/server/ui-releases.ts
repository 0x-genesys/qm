import { LRUCache } from "lru-cache";
import { UI_RELEASE_META } from "../../chassis/src/ui-release.ts";

const MIN_UI_PROTOCOL = 1;

export interface UiRelease {
  id: string;
  protocol: number;
}

export class UiReleaseError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const POINTER_TTL_MS = 10_000;

export function parseUiRelease(value: unknown): UiRelease {
  const { id, protocol } = (value ?? {}) as { id?: unknown; protocol?: unknown };
  if (typeof id !== "string" || !/^[a-f0-9]{8,64}$/.test(id) || !Number.isSafeInteger(protocol))
    throw new Error("release manifest needs a hex id and an integer protocol");
  return { id, protocol: protocol as number };
}

export function uiProtocolSupported(header: string | string[] | undefined): boolean {
  if (header === undefined) return true;
  const protocol = Number.parseInt(Array.isArray(header) ? (header[0] ?? "") : header, 10);
  return protocol >= MIN_UI_PROTOCOL;
}

export function withReleaseMeta(html: string, id: string | undefined): string {
  return id ? html.replace("</head>", `<meta name="${UI_RELEASE_META}" content="${id}" />\n</head>`) : html;
}

export function createUiReleases(base: string, fetchImpl: typeof fetch = fetch) {
  const pointers = new LRUCache<string, { release: UiRelease; checkedAt: number }>({ max: 200 });
  const documents = new LRUCache<string, string>({ max: 64 });

  async function get(path: string): Promise<Response | null> {
    const response = await fetchImpl(`${base}/${path}`, { signal: AbortSignal.timeout(5_000) });
    if (response.status === 403 || response.status === 404) return null;
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response;
  }

  async function release(channel: string): Promise<UiRelease> {
    const cached = pointers.get(channel);
    if (cached && Date.now() - cached.checkedAt < POINTER_TTL_MS) return cached.release;
    let found: UiRelease;
    try {
      const response = await get(`channels/${channel}.json`);
      if (!response) throw new UiReleaseError(404, `No web UI release is published on channel "${channel}".`);
      found = parseUiRelease(await response.json());
    } catch (error) {
      if (!cached || error instanceof UiReleaseError) throw error;
      console.error(`[web-ui] release channel ${channel} unreadable, serving ${cached.release.id}:`, String(error));
      pointers.set(channel, { release: cached.release, checkedAt: Date.now() });
      return cached.release;
    }
    if (found.protocol < MIN_UI_PROTOCOL)
      throw new UiReleaseError(
        503,
        `Web UI release ${found.id} speaks protocol ${found.protocol}; this server needs ${MIN_UI_PROTOCOL} or newer. Publish a newer release.`,
      );
    pointers.set(channel, { release: found, checkedAt: Date.now() });
    return found;
  }

  async function document(channel: string, name: "index.html" | "shared.html"): Promise<string> {
    const { id } = await release(channel);
    const key = `${id}/${name}`;
    const hit = documents.get(key);
    if (hit !== undefined) return hit;
    const response = await get(`releases/${key}`);
    if (!response) throw new UiReleaseError(503, `Web UI release ${id} is missing ${name}.`);
    const html = withReleaseMeta(await response.text(), id);
    documents.set(key, html);
    return html;
  }

  return { release, document, assetUrl: (path: string) => `${base}${path}` };
}
