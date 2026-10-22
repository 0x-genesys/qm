# Capability token encoding and rollout

Room capabilities carry participant assertions for authorization. Large rosters appear
in both the publishing and keychain audiences, so uncompressed tokens can exceed HTTP
header limits before a request reaches core. Increasing core's header limit does not
fix limits imposed by upstream proxies.

`CAPABILITY_TOKEN_COMPRESSION=1` enables compression of claim payloads larger than
4096 bytes for every capability audience. The signed envelope contains a base64url
raw-DEFLATE payload. Verification authenticates the envelope before inflating it,
limits decoded claims to 1 MiB, and applies the existing claim checks. Small tokens
retain their existing encoding. Tokens remain self-contained across replicas and
restarts; no authorization state is moved into a process-local cache. Compression
reduces roster repetition but is not a fixed-size token: unusually large or poorly
compressible claims can still exceed a deployment's header limit.

Compression is off by default for a staged protocol rollout:

1. Keep `CAPABILITY_TOKEN_COMPRESSION` unset or `0` while deploying this verifier to
   every core API replica, worker, and separately deployed egress proxy. Complete the
   blue-green drain of older replicas before enabling issuance.
2. Refresh saved copies of the file upload helper from `/v1/files/upload-client`;
   older copies cannot decode compressed tokens.
3. Set `CAPABILITY_TOKEN_COMPRESSION=1` on every process that issues capabilities,
   including core and workers, and restart them. New turns receive compact tokens;
   already-issued oversized tokens are not rewritten, so retry in a new turn.

To disable issuance, set the switch to `0`. Both encodings remain readable regardless
of that switch. Do not roll verifiers back to a version predating compression until
all compressed tokens have expired or been revoked. Sandbox tokens expire with their run
(see below); other capability audiences may have longer lifetimes, so inventory those
before rolling back. Leaving the updated verifiers in place is the safe rollback.

## Sandbox token lifetime

Turn tokens handed to sandboxes (agent API, credential broker, egress proxy, OAuth
consent) are bound to the run that minted them. Core refuses a run-bound token once
that run has ended and the background-job ceiling (`BACKGROUND_JOB_TTL_MAX_SEC`) has
passed, which is exactly how long a job launched by that turn can still be running.
As a self-contained backstop for verifiers without a run store, such as a separately
deployed egress proxy, the token also expires after the run's own bound
(`TURN_WALL_CLOCK_SEC`, or `RUN_MAX_AGE_MS` for unbounded turns) plus that ceiling.
There is no separate lifetime setting and no non-expiring mode. Tokens already issued
keep the lifetime they were minted with; rotate the signing secret if issued tokens
must be invalidated sooner.
