# QM deployment

This directory is one QM deployment: a config, a secret contract, and a
sandbox layer that customizes the agent without forking the core images. Commit
everything here except `.env`, which holds the secret values and is covered by
the scaffolded `.gitignore`.

## Where the documentation lives

- `package.json` pins the exact CLI version this directory is interpreted by,
  so every checkout resolves the same `qm`. `contract` in the config is only
  the coarse compatibility floor; this pin is the reproducible one. Upgrade it
  deliberately and re-run `qm check` afterwards.
- `qm.config.jsonc` describes what to run. Every field carries a comment
  explaining it, including the full list of services, so read the file itself
  before changing it. It is JSON with comments (the `tsconfig.json` dialect).
  That applies only to the config: `tool.json` files must stay strict JSON.
- `.env.example` is the secret catalog. It lists every secret the platform
  knows, what each one is for, what enables it, and the command that produces a
  value when one exists. The secrets the current config needs appear uncommented.
  `qm init` creates a gitignored `.env`, generates its local signing
  keys, and leaves provider credentials blank for you to fill in. Never write a
  secret value into any other file.
- `slack-app-manifest.yml` creates the optional qm bot app. Slack OIDC
  deployments also get `slack-sso-manifest.yml`. Run
  `npm exec qm -- slack render` after changing `publicUrl`, then
  `npm exec qm -- outputs` for creation links.

## Customizing the sandbox

`sandbox/` defines what the agent gets in its execution environment:

- A skill is `sandbox/skills/<id>/SKILL.md`: markdown with `name` and
  `description` frontmatter that teaches the agent a workflow and when to use it.
- A tool is `sandbox/tools/<id>/tool.json`: a descriptor whose minimal form is
  `{ "id": ..., "advertise": ..., "install": { "binary": ... } }`, with the
  executable next to it when the binary is not already in the base image.
- `sandbox/Dockerfile` is optional and only needed for system packages or
  runtimes.

The scaffold ships a working example, the `greet` skill and `example-tool`.
Copy its shape, then replace or delete it.

## The workflow

Run every command from this directory.

1. `npm exec qm -- check` validates the config and the sandbox layer and prints the
   secret names the config currently requires. It builds nothing, and when
   credential values are already present in `.env` it also verifies them
   against their providers, so run it after every edit.
2. `npm exec qm -- plan` reports what deployment would do
   without changing anything.
3. After the target prerequisites are complete, `npm exec qm -- up` brings the
   deployment up and prints the URLs. An AWS directory must first complete the
   edge and authenticated-portal steps in its AWS bootstrap section below.
   `--build-from <path to a QM checkout>` builds modified runtime code
   from your source fork or a contributor checkout.
4. `npm exec qm -- status`, `npm exec qm -- logs [service]`, and
   `npm exec qm -- down` show
   what is running, tail logs, and stop the deployment.
5. `npm exec qm -- secrets push` uploads the `.env` values to the deploy target.
   The docker target reads `.env` directly and does not need it.

`npm exec qm -- help` lists everything else, including `sandbox build` and
`rollback`.

## Bootstrapping the AWS target

1. Replace the account and GitHub placeholders. The account must already have
   GitHub's IAM OIDC provider. Check it with
   `aws iam get-open-id-connect-provider --open-id-connect-provider-arn arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com`.
   If it is absent, an account administrator creates it once with
   `aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com`.
2. Run `npm exec qm -- infra render`, review the result, then run
   `terraform -chdir=infra init && terraform -chdir=infra apply`. This creates
   inert ECS services, RDS, CloudFront, an ALB origin restricted to CloudFront,
   and the MicroVM roles. Set `publicUrl` to
   `https://<cloudfront_hostname>` and
   `env.core.AWS_PUBLIC_ORIGIN_URL` to `http://<alb_hostname>`.
   A deployment with a separate `apiUrl` or `AWS_DEPLOY_APPS_DOMAIN` instead
   sets `certificate_arn`, points those HTTPS hostnames at `<alb_hostname>`,
   and uses the ALB directly; the generated security group exposes only that
   TLS listener in direct mode.
3. Sign-in is handled by the built-in `auth` broker: set
   `env.auth.AUTH_ALLOWED_EMAIL_DOMAIN` (or leave it out and supply
   `AUTH_ALLOWED_EMAILS`), then run `npm exec qm -- setup` for the sender address
   and the Resend or SMTP credentials; the CLI generates the broker's keys and the
   portal's client credentials and wires `OIDC_*` itself. To use an external
   identity provider instead, drop `"auth"` from `services`, configure
   `env.portal` with the provider's OIDC endpoints and an `OIDC_ALLOWED_EMAILS`
   or `OIDC_ALLOWED_EMAIL_DOMAIN` tenant gate, and register
   `<publicUrl>/auth/callback` with the provider. Add optional services and their
   ECS/ECR entries now, then render and apply once more.
4. Run `npm exec qm -- infra build-image` to build the Lambda MicroVM guest image
   and record its immutable version and execution role in the config.
5. Fill the gitignored `.env` and run `npm exec qm -- secrets push`.
6. Run `npm exec qm -- doctor`, `npm exec qm -- plan`,
   `npm exec qm -- up --yes`, and
   `npm exec qm -- check --live`, in that order.

To tear down this target, run `npm exec qm -- down`, then persist the destructive
lifecycle settings in Terraform state with `terraform -chdir=infra apply
-var='ecr_force_delete=true' -var='object_store_force_destroy=true'
-var='db_skip_final_snapshot=true' -var='secret_recovery_window_days=0'`.
After that apply completes, run
`npm exec qm -- infra delete-task-definitions --yes`, then
`npm exec qm -- infra delete-image --yes`, then run `terraform -chdir=infra destroy
-var='ecr_force_delete=true' -var='object_store_force_destroy=true'
-var='db_skip_final_snapshot=true' -var='secret_recovery_window_days=0'`.
Applying the settings before destroy lets Terraform remove deployed images,
versioned objects, Secrets Manager secrets without a recovery window, and the
database without a final snapshot. Omit the database override from both
commands to retain a final RDS snapshot. Run the cleanup commands with
infrastructure-administrator credentials; the GitHub deploy role intentionally
cannot deregister or delete task definitions.

## Springworks customizations

This layer routes model inference through AWS Bedrock instead of the direct
Anthropic API:

- `env.core.HARNESS` is `"claude"` (not the scaffold default `"pi"`), and
  `env.core.CLAUDE_CODE_USE_BEDROCK` is `"1"`. The `claude` harness spawns a
  real Claude Code subprocess per turn; with `CLAUDE_CODE_USE_BEDROCK` set, that
  subprocess bills and routes every model call through Bedrock in this AWS
  account and region (see the source fork's `src/harness/bedrock-env.ts` for
  the exact passthrough env list).
- `modelProvider` stays `"anthropic"` and `ANTHROPIC_API_KEY` stays a required
  secret, because `qm check`/`qm doctor` validate that key directly against the
  Anthropic API regardless of which harness actually serves traffic. That key
  is a deploy-time validation/fallback credential only; it is not what bills
  production usage once Bedrock routing is active. A Springworks operator who
  wants to drop the direct Anthropic key entirely would need to extend the CLI's
  own provider validation (`cli/src/config.ts`) to recognize Bedrock-carried
  auth — out of scope for this change, which intentionally kept the surface
  area small.
- No AWS access keys are set anywhere in this config. `infra/main.tf` grants
  the ECS core task role (`aws_iam_role.core_task`, via the added
  `aws_iam_role_policy.core_task_bedrock` statement) `bedrock:InvokeModel` /
  `bedrock:InvokeModelWithResponseStream` on Anthropic Claude foundation models
  and cross-region inference profiles; ECS injects that role's credentials into
  the task through `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, which the Claude
  harness now forwards to its subprocess. Confirm the configured `aws.region`
  (and `env.core.AWS_REGION`, kept in sync with it) actually offers the Claude
  models you intend to use in Bedrock before applying.
- `deploy.sh` in this directory wraps the AWS bootstrap sequence above
  (`preflight`, `render`, `infra-plan`, `infra-apply`, `image`, `secrets`,
  `doctor`, `plan`, `up`, `check-live`) into one script with a placeholder
  guard, so a first deploy can't accidentally apply against the scaffolded
  `000000000000` account id or `springworks.example.com` URL. Run
  `./deploy.sh` with no arguments for the stage list, or `./deploy.sh all` to
  run every stage in order with a confirmation prompt before `infra-apply` and
  `up`.
