# One-time setup, applied by a person with admin access. Everything here is free or near free:
# the Terraform state bucket, GitHub's OIDC identity provider, two roles that GitHub Actions can
# assume without stored keys, and a monthly budget alarm.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "orbit-desk", ManagedBy = "terraform", Stack = "bootstrap" } }
}

data "aws_caller_identity" "me" {}

locals {
  account_id   = data.aws_caller_identity.me.account_id
  state_bucket = "orbit-desk-tfstate-${local.account_id}-${var.region}"
  github_oidc  = "token.actions.githubusercontent.com"
}

# ---------- Terraform state: encrypted, versioned, private, locked with S3's native lock file ----------

resource "aws_s3_bucket" "state" {
  #checkov:skip=CKV_AWS_144:Cross-Region replication is not allowed in this AWS project; versioning protects history
  #checkov:skip=CKV_AWS_145:SSE-S3 encryption; a CMK costs $1/month
  #checkov:skip=CKV_AWS_18:Access logging for the state bucket is a production next step (or CloudTrail data events)
  #checkov:skip=CKV2_AWS_62:No consumers for state-bucket event notifications
  bucket        = local.state_bucket
  force_destroy = false
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

# SSE-S3; a CMK costs $1/month
#trivy:ignore:AVD-AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 90 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

# ---------- GitHub Actions OIDC: short-lived credentials, no access keys anywhere ----------

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.enable_github_oidc ? 1 : 0
  url            = "https://${local.github_oidc}"
  client_id_list = ["sts.amazonaws.com"]
}

# Only workflows from this one repository, on the listed refs or events, can assume each role.
data "aws_iam_policy_document" "trust" {
  for_each = var.enable_github_oidc ? { plan = var.plan_subjects, deploy = var.deploy_subjects } : {}
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github[0].arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "${local.github_oidc}:sub"
      values   = [for s in each.value : "repo:${var.github_repo}:${s}"]
    }
  }
}

# Plan role: read-only, plus the state lock file. Used on pull requests.
resource "aws_iam_role" "plan" {
  count                = var.enable_github_oidc ? 1 : 0
  name                 = "orbit-desk-github-plan"
  assume_role_policy   = data.aws_iam_policy_document.trust["plan"].json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "plan_readonly" {
  count      = var.enable_github_oidc ? 1 : 0
  role       = aws_iam_role.plan[0].name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

# Deploy role: manages the app stack. PowerUserAccess covers every service except IAM, and the
# inline policy below allows IAM changes only to roles named orbit-desk-*.
resource "aws_iam_role" "deploy" {
  count                = var.enable_github_oidc ? 1 : 0
  name                 = "orbit-desk-github-deploy"
  assume_role_policy   = data.aws_iam_policy_document.trust["deploy"].json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "deploy_poweruser" {
  count      = var.enable_github_oidc ? 1 : 0
  role       = aws_iam_role.deploy[0].name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

data "aws_iam_policy_document" "state_access" {
  statement {
    sid       = "StateObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.state.arn}/orbit-desk/*"]
  }
  statement {
    sid       = "StateBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]
  }
}

data "aws_iam_policy_document" "deploy_iam" {
  statement {
    sid = "AppRolesOnly"
    actions = [
      "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole", "iam:UpdateAssumeRolePolicy",
      "iam:TagRole", "iam:UntagRole", "iam:ListRoleTags", "iam:PassRole",
      "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:ListRolePolicies",
      "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole",
    ]
    resources = ["arn:aws:iam::${local.account_id}:role/orbit-desk-app-*"]
  }
  statement {
    sid       = "ServiceLinkedRoles"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["arn:aws:iam::${local.account_id}:role/aws-service-role/*"]
  }
}

# Terraform reads secret versions while planning, which ReadOnlyAccess does not allow. The plan
# role may read only this app's own secrets. Trade-off: anyone who can open a pull request in the
# repository can run a plan; keep the repository's collaborators trusted.
data "aws_iam_policy_document" "plan_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:orbit-desk-app-*"]
  }
}

resource "aws_iam_role_policy" "plan_secrets" {
  count  = var.enable_github_oidc ? 1 : 0
  name   = "app-secrets-read"
  role   = aws_iam_role.plan[0].id
  policy = data.aws_iam_policy_document.plan_secrets.json
}

resource "aws_iam_role_policy" "plan_state" {
  count  = var.enable_github_oidc ? 1 : 0
  name   = "terraform-state"
  role   = aws_iam_role.plan[0].id
  policy = data.aws_iam_policy_document.state_access.json
}

resource "aws_iam_role_policy" "deploy_state" {
  count  = var.enable_github_oidc ? 1 : 0
  name   = "terraform-state"
  role   = aws_iam_role.deploy[0].id
  policy = data.aws_iam_policy_document.state_access.json
}

resource "aws_iam_role_policy" "deploy_iam" {
  count  = var.enable_github_oidc ? 1 : 0
  name   = "app-roles"
  role   = aws_iam_role.deploy[0].id
  policy = data.aws_iam_policy_document.deploy_iam.json
}

# ---------- Cost guardrail ----------

resource "aws_budgets_budget" "monthly" {
  name         = "orbit-desk-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = var.budget_email == "" ? [] : [
      { type = "ACTUAL", pct = 50 }, { type = "ACTUAL", pct = 100 }, { type = "FORECASTED", pct = 100 },
    ]
    content {
      comparison_operator        = "GREATER_THAN"
      notification_type          = notification.value.type
      threshold                  = notification.value.pct
      threshold_type             = "PERCENTAGE"
      subscriber_email_addresses = [var.budget_email]
    }
  }
}
