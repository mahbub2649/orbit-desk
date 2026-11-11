# Orbit Desk on AWS

Terraform for running Orbit Desk on AWS in one Region (eu-north-1 by default).

```text
 viewer ──HTTPS──▶ CloudFront ──HTTP + secret header──▶ ALB (CloudFront prefix list only)
                   security headers                        │
                   /assets/* cached                        ▼
                                              ECS Fargate task (public subnet, ALB-only inbound)
                                                 │ secrets from Secrets Manager at start
                                                 │ logs (Splunk HEC JSON audit lines) ─▶ CloudWatch Logs
                                                 │ IAM auth token (15 min), TLS          │ metric filter
                                                 ▼                                       ▼
                                    Aurora PostgreSQL Serverless v2 (express      alarms ─▶ SNS
                                    configuration, internet access gateway,
                                    0–2 ACU, pauses when idle, no password)
 EventBridge Scheduler ── nightly ──▶ one-off Fargate task: python -m app.verify_audit
```

| Directory | What it creates |
|---|---|
| `bootstrap/` | Once, by an admin: state bucket (versioned, encrypted, S3-native locking), GitHub OIDC provider, a read-only **plan** role and a **deploy** role for GitHub Actions, a monthly budget alarm |
| `app/` | The stack, from five modules |
| `modules/network` | VPC, two public subnets, no NAT gateway ([ADR 0001](../docs/adr/0001-no-nat-gateway.md)), flow logs for rejected traffic |
| `modules/database` | Aurora PostgreSQL Serverless v2 with **express configuration** (see below): IAM authentication only, PostgreSQL logs to CloudWatch, pauses at 0 ACU |
| `modules/service` | ECR (scan on push, immutable tags), ECS cluster and service (circuit breaker with rollback), ALB, security groups, log group, alarms |
| `modules/edge` | CloudFront with the default certificate, managed security headers, caching for `/assets/*` only |
| `modules/audit_schedule` | EventBridge Scheduler running the nightly audit-chain check as a Fargate task |

## Deploy

```bash
# 1. Bootstrap (once). Needs admin credentials, e.g. from `aws login`.
cd infra/bootstrap
cp terraform.tfvars.example terraform.tfvars        # set github_repo and budget_email
terraform init && terraform apply
terraform output -raw backend_config > ../app/backend.hcl

# 2. Tell GitHub Actions where things are (no secrets: OIDC needs only role ARNs).
gh variable set AWS_REGION        --body eu-north-1
gh variable set TF_STATE_BUCKET   --body "$(terraform output -raw state_bucket)"
gh variable set AWS_PLAN_ROLE_ARN   --body "$(terraform output -raw plan_role_arn)"
gh variable set AWS_DEPLOY_ROLE_ARN --body "$(terraform output -raw deploy_role_arn)"
gh variable set PROTECT_DATA      --body false      # demo only: lets Destroy remove the database

# 3. Deploy: build, scan, push the image, terraform apply.
gh workflow run deploy.yml

# 4. Optional API keys, never in Terraform or git:
aws secretsmanager put-secret-value --secret-id "$(terraform -chdir=../app output -raw app_secret_arn)" \
  --secret-string '{"ANTHROPIC_API_KEY":"...","JIRA_API_TOKEN":"...","SLACK_WEBHOOK_URL":""}'
aws ecs update-service --cluster orbit-desk --service orbit-desk --force-new-deployment

# 5. Remove everything the app stack created.
gh workflow run destroy.yml -f confirm="destroy orbit-desk"
```

## Two constraints of this AWS project, and how the code handles them

The stack was deployed to a project on AWS's new, free-plan experience. Two organization guardrails
shaped it:

1. **The service control policy denies `iam:CreateOpenIDConnectProvider`**, so GitHub Actions
   cannot get an OIDC role here. The bootstrap has `enable_github_oidc` (true by default; false in
   this project), the workflows are ready for any account where OIDC is allowed, and deploys in this
   project run from a workstation with short-lived `aws login` credentials. No access keys were
   created as a workaround.
2. **Free-plan projects may create Aurora only with express configuration**
   (`FreeTierRestrictionError` otherwise). Such a cluster has no VPC, is reached through Aurora's
   internet access gateway, and accepts IAM authentication only. The Terraform AWS provider has no
   argument for it yet, so `modules/database` runs `express_cluster.sh` from a `terraform_data`
   resource and reads the cluster back with a data source. The app signs a 15-minute token per
   connection; the task role may only `rds-db:connect` as its own user. There is no database
   password anywhere. Express clusters also refuse an initial database name and log exports at
   creation; the script uses the built-in `postgres` database (tables live in the `orbitdesk`
   schema) and turns log export on afterwards.

## Verified on 2026-11-12

Deployed with `terraform apply` (58 resources), then destroyed:

- `https://<distribution>.cloudfront.net/api/health` returned 200; the app served 19 live events
  and 53 satellites with orbit data fetched from CelesTrak (outbound without NAT works).
- The ALB without the secret header could not be reached (CloudFront prefix list only).
- CloudFront added HSTS, `X-Frame-Options` and `X-Content-Type-Options`.
- Migrations and the demo seed ran over IAM database authentication; audit events appeared in
  CloudWatch Logs as Splunk HEC JSON.
- A one-off EventBridge schedule with the nightly target started a Fargate task
  (`startedBy: chronos-schedule/...`) that ran `python -m app.verify_audit`, verified 12 events and
  exited 0.
- All four CloudWatch alarms reached OK once the task was healthy.

![Orbit Desk running on AWS](../docs/aws-live.png)

## Cost (eu-north-1, while running)

| Part | Roughly |
|---|---|
| Fargate task, 1 vCPU / 2 GB | $0.05 an hour |
| Application Load Balancer | $0.03 an hour plus traffic |
| Public IPv4 addresses (ALB and task) | $0.015 an hour |
| Aurora Serverless v2, 0–2 ACU | about $0.07 an hour at 0.5 ACU; storage only while paused (free-plan credits apply) |
| CloudFront, logs, secrets, scheduler | cents |

About **$3–4 a day** while it runs. The bootstrap stack costs nothing except a few cents of S3.

## Security choices

- **No long-lived AWS keys.** GitHub Actions exchanges an OIDC token for one-hour credentials. The
  deploy role trusts only `main` of this repository; the plan role only pull requests and `main`.
- **Least privilege where it matters.** The deploy role has PowerUserAccess but can change IAM only
  for roles named `orbit-desk-app-*`. The app's own task role has no permissions.
- **No database password at all.** IAM database authentication with 15-minute tokens. Optional API
  keys go into Secrets Manager with the CLI, never through Terraform; ECS injects them at start.
- **One way in.** Viewers reach CloudFront only; the ALB accepts CloudFront's addresses with the
  secret header; the database accepts only IAM-signed connections from the app's role.
- **Checked in CI.** Checkov (Terraform), Trivy (dependencies, IaC, the built image) and gitleaks
  (git history). Every accepted finding is skipped inline with its reason.

## Production next steps

WAF on CloudFront, a custom domain with ACM certificates end to end, access logs for CloudFront and
the ALB, customer-managed KMS keys, an AWS Backup plan, two tasks across zones, and approvals on a
protected `production` environment.
