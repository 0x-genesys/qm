# Vendored pi-ai 0.82.0 (qm.2)

qm installs `@earendil-works/pi-ai` from the GitHub release
[`vendored-pi-ai-0.82.0-qm.2`](https://github.com/yc-software/qm/releases/tag/vendored-pi-ai-0.82.0-qm.2),
built from stock npm 0.82.0 plus `provider-error.patch` and `fetch-options.patch` (dist only; version
unchanged; not sent upstream).

`provider-error.patch`: stock pi-ai folds a provider HTTP failure into the display string `errorMessage`, so qm
had to parse text to tell a budget cap from a rate limit. The patch keeps the structured data next to it:

- `AssistantMessage.providerError?: { status?, type?, code?, body? }`, from the SDK error, in the
  error path of openai-completions, openai-responses, azure-openai-responses, openai-codex-responses,
  anthropic-messages, google-generative-ai, google-vertex, mistral-conversations and
  bedrock-converse-stream (`extractProviderError` in `dist/utils/error-body.js`).
- `AssistantMessage.rawStopReason?: string` when a stop/finish reason maps to `stopReason: "error"`
  (anthropic-messages, openai-completions, bedrock-converse-stream), e.g. Anthropic `refusal`.

`errorMessage` is byte-for-byte what stock 0.82.0 produces.

`fetch-options.patch`: stock pi-ai builds its Anthropic and OpenAI SDK clients itself and gives callers no
say in how they fetch, so when a model gateway answers with a redirect to another origin, the SDK follows
it and sends the gateway key and qm's request context headers there. The patch adds
`StreamOptions.fetchOptions`, a `RequestInit` that anthropic-messages, openai-responses and
openai-completions pass to the SDK with each request, `streamSimple` included. qm sets
`{ redirect: "error" }` on gateway-routed requests.

The vendored pi-coding-agent (`vendored-pi-coding-agent-0.82.0-security.7`) is security.5 with only its
`npm-shrinkwrap.json` pi-ai entry repointed at this tarball, so there is one pi-ai in the tree; the root
`overrides` entry enforces the same.

Rebuild (both are byte-reproducible and verify their inputs' SHA-256; the repack downloads the published
qm.2 tarball, so it runs after that release exists):

    vendor/pi-ai/build.sh                 # earendil-works-pi-ai-0.82.0-qm.2.tgz
    vendor/pi-ai/repack-coding-agent.sh   # earendil-works-pi-coding-agent-0.82.0-qm-security.7.tgz

Drop this directory when qm upgrades past 0.82.0 to a pi-ai that exposes equivalent fields and options.
