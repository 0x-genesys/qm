import { ErrorCode, WebClient, type WebClientOptions } from "@slack/web-api";

export type SlackWebClientFactory = (token: string, options: WebClientOptions) => Pick<WebClient, "apiCall">;

export function slackWebClientOptions(timeout = 20_000, slackApiUrl?: string): WebClientOptions {
  return {
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    attachOriginalToWebAPIRequestError: false,
    timeout,
    ...(slackApiUrl ? { slackApiUrl } : {}),
  };
}

export function slackWebClient(
  token: string,
  factory: SlackWebClientFactory = (token, options) => new WebClient(token, options),
  timeout = 20_000,
) {
  return factory(token, slackWebClientOptions(timeout));
}

export interface SlackCallFailure {
  retryAfter?: number;
  platformError?: string;
  status?: number;
}

export function slackCallFailure(error: unknown): SlackCallFailure {
  const e = (error ?? {}) as { code?: unknown; retryAfter?: unknown; statusCode?: unknown; data?: { error?: unknown } };
  return {
    ...(e.code === ErrorCode.RateLimitedError && typeof e.retryAfter === "number" ? { retryAfter: e.retryAfter } : {}),
    ...(e.code === ErrorCode.PlatformError && typeof e.data?.error === "string" ? { platformError: e.data.error } : {}),
    ...(e.code === ErrorCode.HTTPError && typeof e.statusCode === "number" ? { status: e.statusCode } : {}),
  };
}
