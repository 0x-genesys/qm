# Sandbox configuration

QM can discover sandbox controls through `GET /v1/admin/resources`. The org scope response includes a concise `sandboxConfiguration` summary and a details URL. `GET /v1/admin/sandbox-configuration` returns supported setting names and types, override sources, redacted credential status, the responding process's active configuration, and the configuration that will apply on its next startup. Provider defaults omitted by a provider adapter remain provider defaults; the API does not invent a machine specification.

Use the existing authorized admin route:

```http
PUT /v1/admin/scopes/org:<org-id>/sandbox-configuration
Content-Type: application/json

{"expectedVersion":null,"set":{"MODAL_CPUS":"4","E2B_TEMPLATE_ID":"agent-image"}}
```

Always read first and supply the returned version. `set` uses string values in the existing environment-setting syntax. Unmentioned names remain unchanged. `reset` removes named overrides and restores the startup environment or provider defaults. It does not revoke an ambient credential. Stale writes return 409; invalid inputs return 400. Writes require PostgreSQL and a stable `CONNECTOR_SECRET_KEY`; ephemeral instances expose configuration but reject writes.

Settings cover provider selection, images/templates, CPU/memory/disk options, provider credentials and URLs, sandbox lifetimes, execution limits, idle behavior, egress configuration and provider snapshot destinations. The API's field list is authoritative for supported names. Saved overrides apply only to sandbox configuration: shared Porter environment defaults and the AWS deployment bucket fallback continue to use their original deployment input.

Each process loads the saved configuration before constructing providers. Saving does not restart services. `appliedVersion` and `restartRequired` describe the responding process, not every replica. During a rolling restart, old processes retain their previous settings. Existing computers may be reused or replaced on subsequent operations: a local image change can recreate a container, and Superserve template/network changes can replace a computer. Snapshot destination changes do not migrate recovery data. Saving validates configuration syntax and requirements, not remote provider credentials or capacity.

Connection capacity is a separate live control: `sandbox-settings.connectionPoolMax`. Per-scope computer selection remains with the sandbox tool; turn limits retain their existing admin resource. Shared database routing, encryption/signing roots, storage, host executables, egress services and SDK environment controls are identified as deployment-owned. They must be changed through the deployment's configuration and secret-management path rather than an org provider override.

Storage uses the standard durable-map `sandbox_configuration` table (`id` primary key, `json` JSONB), with one organization record containing version, update attribution and encrypted overrides. It uses the existing schema registration and secret encryption helpers, with no backfill or destructive migration. Provider credentials are never returned in configuration reads. Older application versions ignore this new table; upgrade every serving process before relying on saved overrides.
