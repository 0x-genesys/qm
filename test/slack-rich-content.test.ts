import assert from "node:assert/strict";
import test from "node:test";

import { messageWithForwardedContent } from "../src/slack/forwards.ts";
import { slackMessageToIngestEvent } from "../src/slack/mirror.ts";
import { blocksText, withRichContent } from "../src/slack/rich-content.ts";
import { parseMessageEvent } from "../src/slack/payloads.ts";
import type { BotIdentity } from "../src/slack/directory.ts";

const ids = { botUserId: "UBOT", ownBotId: "BBOT" } as BotIdentity;

// Shape of an Amazon Q Developer (AWS Chatbot) CloudWatch alarm post: empty
// top-level text, content in Block Kit.
const chatbotAlarm = {
  type: "message",
  channel: "CDEV",
  ts: "1792727716.369879",
  bot_id: "BAWS",
  user: "UAWS",
  bot_profile: { name: "Amazon Q Developer" },
  text: "",
  blocks: [
    { type: "header", text: { type: "plain_text", text: ":rotating_light: CloudWatch Alarm | core-5xx | us-west-2" } },
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Threshold Crossed: 1 datapoint [12.0] was greater than the threshold (5.0).*" },
      fields: [
        { type: "mrkdwn", text: "*Alarm Name*\ncore-5xx" },
        { type: "mrkdwn", text: "*State*\nALARM" },
      ],
    },
    { type: "divider" },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: "Account: 123456789012" },
        { type: "image", image_url: "x" },
      ],
    },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Show logs" } }] },
  ],
};

test("Amazon Q alarm blocks become readable text in the mirror ingest event", () => {
  const event = slackMessageToIngestEvent(parseMessageEvent(chatbotAlarm), ids);
  assert.equal(
    event.text,
    [
      ":rotating_light: CloudWatch Alarm | core-5xx | us-west-2",
      "*Threshold Crossed: 1 datapoint [12.0] was greater than the threshold (5.0).*",
      "*Alarm Name*\ncore-5xx",
      "*State*\nALARM",
      "Account: 123456789012",
    ].join("\n"),
  );
  assert.equal(event.bot, true);
});

test("edited (message_changed) bot posts carry the new block content", () => {
  const changed = parseMessageEvent({
    type: "message",
    subtype: "message_changed",
    channel: "CDEV",
    ts: "1792727866.000000",
    message: { ...chatbotAlarm, edited: { ts: "1792727866.000000" } },
    previous_message: { ...chatbotAlarm, blocks: [] },
  });
  const event = slackMessageToIngestEvent({ ...changed.message!, channel: "CDEV" }, ids, { partial: true });
  assert.match(event.text ?? "", /core-5xx/);
});

test("legacy attachments render pretext, title, text, fields and fall back to fallback", () => {
  const text = withRichContent({
    text: "",
    attachments: [
      {
        color: "danger",
        pretext: "Alarm fired",
        title: "core-5xx",
        title_link: "https://console.aws.amazon.com/cloudwatch",
        text: "Threshold crossed",
        fields: [
          { title: "State", value: "ALARM", short: true },
          { title: "Region", value: "us-west-2", short: true },
        ],
        footer: "Amazon CloudWatch",
      },
      { fallback: "only a fallback here" },
    ],
  });
  assert.equal(
    text,
    [
      "Alarm fired",
      "<https://console.aws.amazon.com/cloudwatch|core-5xx>",
      "Threshold crossed",
      "State: ALARM",
      "Region: us-west-2",
      "Amazon CloudWatch",
      "only a fallback here",
    ].join("\n"),
  );
});

test("timestamped attachments render only when the message has no text of its own", () => {
  const attachment = { ts: "1787162400", author_name: "CloudWatch", text: "ALARM core-5xx" };
  assert.equal(withRichContent({ text: "", attachments: [attachment] }), "CloudWatch\nALARM core-5xx");
  assert.equal(withRichContent({ text: "top-level", attachments: [attachment] }), "top-level");
});

test("attachment blocks are rendered", () => {
  const text = withRichContent({
    attachments: [{ color: "#f00", blocks: [{ type: "section", text: { type: "mrkdwn", text: "inside" } }] }],
  });
  assert.equal(text, "inside");
});

test("ordinary messages are unchanged: blocks duplicate text and unfurls are skipped", () => {
  const message = {
    text: "see https://example.com <@U1>",
    blocks: [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "text", text: "see " },
              { type: "link", url: "https://example.com" },
              { type: "text", text: " " },
              { type: "user", user_id: "U1" },
            ],
          },
        ],
      },
    ],
    attachments: [
      { from_url: "https://example.com", original_url: "https://example.com", title: "Example", text: "preview" },
    ],
  };
  assert.deepEqual(messageWithForwardedContent(message), { text: message.text, files: [] });
});

test("legacy attachment text already in the top-level text is not repeated", () => {
  assert.equal(
    withRichContent({ text: "Deploy failed: api", attachments: [{ fallback: "Deploy failed: api" }] }),
    "Deploy failed: api",
  );
  assert.equal(
    withRichContent({ text: "Deploy failed", attachments: [{ title: "api", text: "exit 1" }] }),
    "Deploy failed\napi\nexit 1",
  );
});

test("rich_text blocks render lists, quotes, code and mentions when text is empty", () => {
  const text = blocksText([
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "text", text: "hi " },
            { type: "broadcast", range: "here" },
          ],
        },
        {
          type: "rich_text_list",
          style: "bullet",
          elements: [
            { type: "rich_text_section", elements: [{ type: "text", text: "one" }] },
            { type: "rich_text_section", elements: [{ type: "emoji", name: "fire" }] },
          ],
        },
        { type: "rich_text_quote", elements: [{ type: "text", text: "quoted" }] },
        { type: "rich_text_preformatted", elements: [{ type: "text", text: "code" }] },
        {
          type: "rich_text_section",
          elements: [
            { type: "link", url: "https://x.y", text: "x" },
            { type: "channel", channel_id: "C1" },
          ],
        },
      ],
    },
  ]);
  assert.equal(text, "hi <!here>\n• one\n• :fire:\n> quoted\n```code```\n<https://x.y|x><#C1>");
});

test("forwarded messages still render alongside derived content", () => {
  const result = messageWithForwardedContent({
    text: "",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "context" } }],
    attachments: [{ is_share: true, author_name: "Ada", channel_name: "ops", text: "original" }],
  });
  assert.equal(result.text, "context\n[forwarded message from Ada in #ops] original");
});

test("derived content is capped", () => {
  const text = withRichContent({ blocks: [{ type: "section", text: { type: "mrkdwn", text: "x".repeat(10_000) } }] });
  assert.ok(text.length <= 4_001);
  assert.ok(text.endsWith("…"));
});

test("malformed blocks and attachments are ignored", () => {
  assert.equal(
    withRichContent({ text: "", blocks: [null, 3, "x", { type: "section" }], attachments: [null, "x", {}] }),
    "",
  );
  assert.equal(withRichContent({ text: "plain", blocks: "nope", attachments: {} }), "plain");
});
