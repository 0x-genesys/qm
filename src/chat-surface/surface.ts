import type { IncomingHttpHeaders } from "node:http";
import type { Tenant } from "../tenant.ts";
import type {
  ActorAssertion,
  ConversationKind,
  DeliveryProvenance,
  Destination,
  OutgoingAttachment,
  ScopeId,
} from "../types.ts";
import type { PostReceipt } from "../surfaces/outbound.ts";
import type { SlackNative } from "./slack.ts";

interface SurfaceCapabilities {
  threads: boolean;
  edits: boolean;
  reactions: boolean;
  richCards: boolean;
  format: "mrkdwn" | "markdown" | "plain";
}

export interface SurfaceUser {
  id: string;
  email?: string;
  displayName?: string;
  guest?: boolean;
  bot?: boolean;
  timezone?: string;
}

interface SurfaceAttachment {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url?: string;
}

interface SurfaceConversationRef {
  kind: ConversationKind;
  key: string;
  name?: string;
  thread?: string;
  members?: SurfaceUser[];
}

export interface InboundMessage {
  tenant: Tenant;
  account: string;
  conversation: SurfaceConversationRef;
  messageId: string;
  author: SurfaceUser;
  text: string;
  attachments: SurfaceAttachment[];
  mentions: Record<string, string>;
  mentionsSelf: boolean;
  threadEngaged: boolean;
}

export interface SurfaceRequest {
  headers: IncomingHttpHeaders;
  pathWithQuery: string;
  rawBody: string;
}

export type InboundOutcome =
  { status: 401; reason: string } | { status: 400; reason: string } | { status: 200; messages: InboundMessage[] };

interface DeliveryCtx {
  tenant: Tenant;
  scopeId?: ScopeId;
  destination: Destination;
  idempotencyKey: string;
  provenance?: DeliveryProvenance;
  createdAt?: number;
  retry?: boolean;
}

interface OutboundItem {
  text: string;
  attachments?: OutgoingAttachment[];
}

interface SurfaceNatives {
  slack: SlackNative;
}

export interface Surface {
  readonly kind: string;
  readonly name: string;
  readonly label: string;
  readonly destinationTypes: readonly string[];
  readonly capabilities: SurfaceCapabilities;
  normalize?(request: SurfaceRequest): Promise<InboundOutcome>;
  deliver(ctx: DeliveryCtx, item: OutboundItem): Promise<PostReceipt | void>;
  principalFor(user: SurfaceUser): ActorAssertion;
  native<K extends keyof SurfaceNatives>(kind: K): SurfaceNatives[K] | null;
}
