# Orbit Desk on AWS: VPC, Aurora Serverless v2, ECS Fargate behind an ALB, CloudFront,
# Secrets Manager, CloudWatch logs and alarms, and an EventBridge Scheduler audit check.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # Partial configuration: terraform init -backend-config=backend.hcl (see bootstrap outputs).
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "orbit-desk", ManagedBy = "terraform", Stack = var.name } }
}

# Shared secret between CloudFront and the ALB listener rule.
resource "random_password" "origin_header" {
  length  = 40
  special = false
}

# ---------- Alarm notifications (optional email) ----------

# encrypted with the AWS-managed SNS key; alarm messages hold no secrets
#trivy:ignore:AVD-AWS-0136
resource "aws_sns_topic" "alarms" {
  name              = "${var.name}-alarms"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# ---------- VPC flow logs (rejected traffic only) ----------

resource "aws_cloudwatch_log_group" "flow" {
  #checkov:skip=CKV_AWS_158:Encrypted by CloudWatch Logs with AWS-managed keys; CMK optional
  #checkov:skip=CKV_AWS_338:Rejected-traffic flow logs kept 14 days in the demo
  name              = "/vpc/${var.name}/rejected"
  retention_in_days = 14
}

data "aws_iam_policy_document" "flow_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "flow" {
  name               = "orbit-desk-app-${var.name}-flowlogs"
  assume_role_policy = data.aws_iam_policy_document.flow_trust.json
}

data "aws_iam_policy_document" "flow_write" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.flow.arn}:*"]
  }
}

resource "aws_iam_role_policy" "flow" {
  name   = "write-flow-logs"
  role   = aws_iam_role.flow.id
  policy = data.aws_iam_policy_document.flow_write.json
}

# ---------- Modules ----------

module "network" {
  source             = "../modules/network"
  name               = var.name
  cidr               = var.vpc_cidr
  enable_flow_logs   = true
  flow_log_group_arn = aws_cloudwatch_log_group.flow.arn
  flow_log_role_arn  = aws_iam_role.flow.arn
}

module "database" {
  source              = "../modules/database"
  name                = var.name
  region              = var.region
  min_acu             = var.db_min_acu
  max_acu             = var.db_max_acu
  deletion_protection = var.protect_data
}

module "service" {
  source              = "../modules/service"
  name                = var.name
  vpc_id              = module.network.vpc_id
  public_subnet_ids   = module.network.public_subnet_ids
  image_tag           = var.image_tag
  db_host             = module.database.endpoint
  db_port             = module.database.port
  db_name             = module.database.database_name
  db_username         = module.database.username
  db_connect_arn      = module.database.connect_resource_arn
  public_url          = var.public_url
  origin_header_value = random_password.origin_header.result
  extra_environment   = var.extra_environment
  alarm_topic_arn     = aws_sns_topic.alarms.arn
  force_delete_images = !var.protect_data
  deletion_protection = var.protect_data
}

module "edge" {
  source              = "../modules/edge"
  name                = var.name
  alb_dns_name        = module.service.alb_dns_name
  origin_header_value = random_password.origin_header.result
}

module "audit_schedule" {
  source             = "../modules/audit_schedule"
  name               = var.name
  region             = var.region
  cluster_arn        = module.service.cluster_arn
  task_family        = module.service.task_family
  execution_role_arn = module.service.execution_role_arn
  task_role_arn      = module.service.task_role_arn
  subnet_ids         = module.network.public_subnet_ids
  security_group_ids = [module.service.app_security_group_id]
}
