#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

USAGE="Usage: $0 <stage> [-- extra qm args]

Stages, run in this order for a first deploy:
  preflight        verify local tools, AWS auth, and that placeholder values were replaced
  render           regenerate infra/terraform.tfvars from qm.config.jsonc
  infra-plan       terraform init + plan (writes infra/qm.tfplan, applies nothing)
  infra-apply      apply the reviewed infra/qm.tfplan
  image            build and publish the Lambda MicroVM agent-computer image
  secrets          push .env secret values to the provider's secret store
  doctor           verify prerequisites against the live AWS account (read-only)
  plan             qm plan: resolve config, report what 'up' would do, change nothing
  up               bring the deployment up (builds/publishes images, deploys ECS services)
  check-live       verify the running deployment end-to-end, including the private canary
  all              run every stage above in order, pausing for confirmation before infra-apply and up
  teardown-plan    terraform plan -destroy against infra/qm.tfplan (review only, no mutation)

Every stage must run from this directory (deploy/layers/springworks) so it
picks up this directory's qm.config.jsonc, .env, and infra/ state.
"

PROFILE="${AWS_PROFILE:-}"
PROFILE_ARGS=()
if [[ -n "$PROFILE" ]]; then
  PROFILE_ARGS=(--profile "$PROFILE")
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required tool: $1" >&2
    exit 1
  }
}

confirm() {
  local prompt="$1"
  read -r -p "$prompt [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

check_no_placeholders() {
  local failed=0
  if grep -q '000000000000' qm.config.jsonc infra/terraform.tfvars 2>/dev/null; then
    echo "qm.config.jsonc / infra/terraform.tfvars still reference the placeholder AWS account id 000000000000 — set aws.accountId first" >&2
    failed=1
  fi
  if grep -q 'springworks.example.com' qm.config.jsonc 2>/dev/null; then
    echo "qm.config.jsonc still uses the placeholder publicUrl springworks.example.com — set it to the real CloudFront/ALB hostname once infra is applied" >&2
    failed=1
  fi
  if grep -q 'replace-me/repository' infra/terraform.tfvars 2>/dev/null; then
    echo "infra/terraform.tfvars still has the placeholder GitHub repository replace-me/repository — set aws.githubRepository (or the equivalent config field) to Springworks' real deploy repo" >&2
    failed=1
  fi
  if grep -q 'replace-with-alb-hostname' qm.config.jsonc 2>/dev/null; then
    echo "qm.config.jsonc still has the placeholder AWS_PUBLIC_ORIGIN_URL — set it from the Terraform ALB output after infra-apply" >&2
    failed=1
  fi
  return $failed
}

stage_preflight() {
  require_cmd npm
  require_cmd terraform
  require_cmd docker
  require_cmd aws
  require_cmd openssl
  echo "node: $(node --version)"
  node -e 'process.exit(parseInt(process.versions.node) >= 24 ? 0 : 1)' ||
    { echo "Node >=24 is required (this repo's qm CLI refuses older runtimes)" >&2; exit 1; }
  aws "${PROFILE_ARGS[@]}" sts get-caller-identity
  aws "${PROFILE_ARGS[@]}" ec2 describe-availability-zones --region "$(node -e "console.log(require('jsonc-parser').parse(require('fs').readFileSync('qm.config.jsonc','utf8')).aws.region)" 2>/dev/null || echo us-west-2)" --filters Name=state,Values=available >/dev/null
  if [[ ! -f .env ]]; then
    echo ".env is missing — run 'npm exec qm -- setup' first" >&2
    exit 1
  fi
  if [[ "$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env)" != "600" ]]; then
    echo "warning: .env is not mode 600; tighten its permissions before continuing" >&2
  fi
  git -C . check-ignore --quiet .env || { echo ".env is not gitignored — stop and fix this before anything else" >&2; exit 1; }
  check_no_placeholders
  echo "preflight OK"
}

stage_render() {
  npm exec qm -- infra render
}

stage_infra_plan() {
  check_no_placeholders
  terraform -chdir=infra init
  terraform -chdir=infra plan -out=qm.tfplan
  echo "reviewed plan written to infra/qm.tfplan — inspect it, then run: $0 infra-apply"
}

stage_infra_apply() {
  if [[ ! -f infra/qm.tfplan ]]; then
    echo "no infra/qm.tfplan — run '$0 infra-plan' first and review it" >&2
    exit 1
  fi
  confirm "Apply infra/qm.tfplan against the Springworks AWS account now?" || { echo "aborted"; exit 1; }
  terraform -chdir=infra apply qm.tfplan
  echo
  echo "next: copy the cloudfront_hostname and alb_hostname outputs below into"
  echo "qm.config.jsonc (publicUrl and env.core.AWS_PUBLIC_ORIGIN_URL), then run:"
  echo "  npm exec qm -- infra render && terraform -chdir=infra plan -out=qm.tfplan && $0 infra-apply"
  terraform -chdir=infra output
}

stage_image() {
  npm exec qm -- infra build-image
}

stage_secrets() {
  npm exec qm -- check
  npm exec qm -- secrets push
}

stage_doctor() {
  npm exec qm -- doctor
}

stage_plan() {
  npm exec qm -- plan
}

stage_up() {
  confirm "Deploy springworks-qm to AWS now (qm up --yes)?" || { echo "aborted"; exit 1; }
  npm exec qm -- up --yes
}

stage_check_live() {
  npm exec qm -- check --live
}

stage_teardown_plan() {
  terraform -chdir=infra plan -destroy \
    -var='ecr_force_delete=true' \
    -var='object_store_force_destroy=true' \
    -var='db_skip_final_snapshot=true' \
    -var='secret_recovery_window_days=0'
  echo "review only. Teardown itself follows AGENTS.md's 'Bootstrapping the AWS target' section verbatim — this script does not execute it."
}

stage_all() {
  stage_preflight
  stage_render
  stage_infra_plan
  stage_infra_apply
  stage_image
  stage_secrets
  stage_doctor
  stage_plan
  stage_up
  stage_check_live
}

STAGE="${1:-}"
case "$STAGE" in
  preflight) stage_preflight ;;
  render) stage_render ;;
  infra-plan) stage_infra_plan ;;
  infra-apply) stage_infra_apply ;;
  image) stage_image ;;
  secrets) stage_secrets ;;
  doctor) stage_doctor ;;
  plan) stage_plan ;;
  up) stage_up ;;
  check-live) stage_check_live ;;
  teardown-plan) stage_teardown_plan ;;
  all) stage_all ;;
  *)
    echo "$USAGE" >&2
    exit 1
    ;;
esac
