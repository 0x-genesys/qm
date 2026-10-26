org_id              = "springworks"
account_id          = "000000000000"
region              = "us-west-2"
cluster_name        = "springworks-qm"
public_url          = "https://springworks.example.com"
cloud_map_namespace = "springworks.internal"
secrets_prefix      = "springworks/qm/"
github_oidc_provider_arn = "arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com"
github_environment  = ""
object_store_bucket = "qm-springworks-c15da0aa0c78"
transfer_lifecycle_prefix = "transfer/"
deploy_microvm_image = "springworks-qm-sandbox"
deploy_microvm_execution_role_arn = "arn:aws:iam::000000000000:role/springworks-qm-microvm-exec"
github_repository   = "replace-me/repository"
github_ref          = "refs/heads/main"
certificate_arn     = ""
core_public_hosts   = []
github_subject_prefix = ""
services            = {
  "core": {
    "ecr_repository": "springworks-qm-core",
    "ecs_service": "springworks-qm-core",
    "cpu": 2048,
    "memory": 4096,
    "architecture": "arm64",
    "internal_port": 8080
  },
  "web-ui": {
    "ecr_repository": "springworks-qm-web-ui",
    "ecs_service": "springworks-qm-web-ui",
    "cpu": 512,
    "memory": 1024,
    "architecture": "arm64",
    "internal_port": 8080
  },
  "portal": {
    "ecr_repository": "springworks-qm-portal",
    "ecs_service": "springworks-qm-portal",
    "cpu": 512,
    "memory": 1024,
    "architecture": "arm64",
    "internal_port": 8080
  },
  "admin": {
    "ecr_repository": "springworks-qm-admin",
    "ecs_service": "springworks-qm-admin",
    "cpu": 512,
    "memory": 1024,
    "architecture": "arm64",
    "internal_port": 8080
  },
  "auth": {
    "ecr_repository": "springworks-qm-auth",
    "ecs_service": "springworks-qm-auth",
    "cpu": 512,
    "memory": 1024,
    "architecture": "arm64",
    "internal_port": 8080
  }
}
secret_names        = [
  "ADMIN_GRANTS",
  "ANTHROPIC_API_KEY",
  "AUTH_ALLOWED_EMAILS",
  "AUTH_CLIENT_SECRET",
  "AUTH_EMAIL_FROM",
  "AUTH_SIGNING_JWK",
  "AUTH_TOKEN_SECRET",
  "CAPABILITY_SECRET",
  "CONNECTOR_SECRET_KEY",
  "CORE_SIGNING_SECRET",
  "DATABASE_CA_CERT",
  "DATABASE_URL",
  "OPENROUTER_API_KEY",
  "PORTAL_IDENTITY_SECRET",
  "PORTAL_SESSION_SECRET",
  "RESEND_API_KEY",
  "SKILL_SIGNING_SECRET",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN"
]
