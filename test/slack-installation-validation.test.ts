import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { WebClient } from "@slack/web-api";
import { validateSlackInstallation } from "../src/surfaces/slack-installation.ts";
import type { SlackWebClientFactory } from "../src/slack/web-client.ts";
import { startFakeSlackApi, type FakeSlackCall } from "./support/fake-slack-api.ts";

const botToken = "xoxb-test-secret";
const appToken = "xapp-test-secret";

async function slack(
  t: TestContext,
  reply: (call: FakeSlackCall) => Response,
): Promise<{ factory: SlackWebClientFactory; methods: () => string[] }> {
  const api = await startFakeSlackApi(reply);
  t.after(() => api.close());
  return {
    factory: (token, options) => new WebClient(token, { ...options, slackApiUrl: api.apiUrl }),
    methods: () => api.calls.map((call) => call.method),
  };
}

test("Slack validation explains provider throttling once, without retrying or parsing a non-JSON response", async (t) => {
  const api = await slack(t, () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }));
  await assert.rejects(
    validateSlackInstallation(botToken, appToken, api.factory),
    /in 30 seconds.*existing connection has not changed/,
  );
  assert.deepEqual(api.methods(), ["auth.test"]);
});

test("Slack validation identifies which token needs a scope", async (t) => {
  const api = await slack(t, ({ method }) =>
    Response.json(method === "auth.test" ? { ok: true, app_id: "A1" } : { ok: false, error: "missing_scope" }),
  );
  await assert.rejects(
    validateSlackInstallation(botToken, appToken, api.factory),
    /App-level token needs connections:write/,
  );
  assert.deepEqual(api.methods(), ["auth.test", "apps.connections.open"]);
});

test("Slack validation gives a recoverable bot-token error without revealing credentials", async (t) => {
  const api = await slack(t, () => Response.json({ ok: false, error: "token_revoked" }));
  await assert.rejects(validateSlackInstallation(botToken, appToken, api.factory), (error: Error) => {
    assert.match(error.message, /Bot token was rejected.*current token/);
    assert.doesNotMatch(error.message, /test-secret/);
    return true;
  });
});

test("Slack validation resolves a bot's app through bots.info and confirms the socket belongs to the same app", async (t) => {
  const api = await slack(t, ({ method, params }) => {
    if (method === "auth.test") return Response.json({ ok: true, bot_id: "B1", team_id: "T1", team: "Acme" });
    if (method === "bots.info")
      return Response.json({ ok: true, bot: { app_id: params.get("bot") === "B1" ? "A1" : "A0" } });
    return Response.json({ ok: true, url: "wss://wss-primary.slack.com/link" });
  });
  assert.deepEqual(await validateSlackInstallation(botToken, appToken, api.factory, async () => "A1"), {
    teamId: "T1",
    teamName: "Acme",
  });
  await assert.rejects(
    validateSlackInstallation(botToken, appToken, api.factory, async () => "A2"),
    /belong to different Slack apps/,
  );
});
