# The app on ECS Fargate behind an Application Load Balancer.
#
# Ingress: only CloudFront reaches the load balancer (its managed prefix list), and the listener
# forwards a request only when it carries the secret origin header that CloudFront adds. Anything
# else gets 403, so the ALB cannot be used to bypass CloudFront.

data "aws_region" "current" {}
data "aws_caller_identity" "me" {}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

locals {
  container = "app"
  port      = 8000
}

# ---------- Image registry ----------

resource "aws_ecr_repository" "app" {
  #checkov:skip=CKV_AWS_136:AES256 (AWS-managed) encryption; a customer-managed KMS key costs $1/month
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.force_delete_images
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 10 most recent images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 10 }
      action       = { type = "expire" }
    }]
  })
}

# ---------- Secrets the app reads at start ----------

# Created with empty values. Put real keys in with the AWS CLI (see infra/README.md); Terraform
# ignores later changes so they never end up in a plan or in state.
resource "aws_secretsmanager_secret" "app" {
  #checkov:skip=CKV_AWS_149:Encrypted with the AWS-managed Secrets Manager key
  #checkov:skip=CKV2_AWS_57:Third-party API keys cannot be rotated automatically; the RDS-managed DB secret rotates on its own
  name                    = "orbit-desk-app-${var.name}-keys"
  description             = "Optional API keys for Orbit Desk (Anthropic, Jira, Slack)"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({ ANTHROPIC_API_KEY = "", JIRA_API_TOKEN = "", SLACK_WEBHOOK_URL = "" })
  lifecycle { ignore_changes = [secret_string] }
}

# ---------- Logs ----------

resource "aws_cloudwatch_log_group" "app" {
  #checkov:skip=CKV_AWS_158:Encrypted by CloudWatch Logs with AWS-managed keys; CMK optional
  #checkov:skip=CKV_AWS_338:14-day retention for a demo; forward audit events (Splunk HEC format) for long-term keeping
  name              = "/ecs/${var.name}"
  retention_in_days = var.log_retention_days
}

# Audit events are written as Splunk HEC JSON; this turns a failed nightly chain check into a metric.
resource "aws_cloudwatch_log_metric_filter" "audit_broken" {
  name           = "${var.name}-audit-chain-broken"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ ($.sourcetype = \"orbitdesk:audit_check\") && ($.event.ok IS FALSE) }"
  metric_transformation {
    name          = "AuditChainBroken"
    namespace     = "OrbitDesk"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "audit_checked" {
  name           = "${var.name}-audit-chain-checked"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.sourcetype = \"orbitdesk:audit_check\" }"
  metric_transformation {
    name      = "AuditChainChecked"
    namespace = "OrbitDesk"
    value     = "1"
  }
}

# ---------- IAM: execution role (ECS itself) and task role (the app) ----------

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    # Confused-deputy protection: only ECS tasks in this account may use the role.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.me.account_id]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "orbit-desk-app-${var.name}-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.db_secret_arn, aws_secretsmanager_secret.app.arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "read-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# The app makes no AWS API calls, so its task role has no permissions at all.
resource "aws_iam_role" "task" {
  name               = "orbit-desk-app-${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

# ---------- Cluster, task definition ----------

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

locals {
  environment = merge({
    DB_HOST          = var.db_host
    DB_PORT          = tostring(var.db_port)
    DB_NAME          = var.db_name
    DB_SSLMODE       = "require"
    PUBLIC_URL       = var.public_url
    TLE_CACHE_DIR    = "/tmp/orbitdesk"
    AUDIT_HEC_STDOUT = "true"
    PYTHONUNBUFFERED = "1"
  }, var.extra_environment)

  secrets = [
    { name = "DB_USERNAME", valueFrom = "${var.db_secret_arn}:username::" },
    { name = "DB_PASSWORD", valueFrom = "${var.db_secret_arn}:password::" },
    { name = "ANTHROPIC_API_KEY", valueFrom = "${aws_secretsmanager_secret.app.arn}:ANTHROPIC_API_KEY::" },
    { name = "JIRA_API_TOKEN", valueFrom = "${aws_secretsmanager_secret.app.arn}:JIRA_API_TOKEN::" },
    { name = "SLACK_WEBHOOK_URL", valueFrom = "${aws_secretsmanager_secret.app.arn}:SLACK_WEBHOOK_URL::" },
  ]
}

resource "aws_ecs_task_definition" "app" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name         = local.container
    image        = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
    essential    = true
    environment  = [for k, v in local.environment : { name = k, value = v }]
    secrets      = local.secrets
    portMappings = [{ containerPort = local.port, protocol = "tcp" }]
    healthCheck = {
      command     = ["CMD-SHELL", "python -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:${local.port}/api/health', timeout=4)\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 90
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "app"
      }
    }
  }])
}

# ---------- Security groups ----------

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "HTTP from CloudFront only"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront" {
  #checkov:skip=CKV_AWS_260:False positive: the source is the CloudFront origin-facing prefix list, not 0.0.0.0/0
  security_group_id = aws_security_group.alb.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  description       = "CloudFront origin-facing addresses"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_app" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = local.port
  to_port                      = local.port
  description                  = "To the app tasks"
}

resource "aws_security_group" "app" {
  name        = "${var.name}-app"
  description = "App tasks: in from the ALB only"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = local.port
  to_port                      = local.port
  description                  = "From the load balancer"
}

# Outbound HTTPS for public data feeds (USGS, GDACS, NASA, NOAA, CelesTrak) and AWS APIs.
resource "aws_vpc_security_group_egress_rule" "app_https" {
  security_group_id = aws_security_group.app.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to public feeds and AWS APIs"
}

# Some public feeds still answer on plain HTTP.
resource "aws_vpc_security_group_egress_rule" "app_http" {
  security_group_id = aws_security_group.app.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  description       = "HTTP to public feeds"
}

resource "aws_vpc_security_group_egress_rule" "app_db" {
  security_group_id = aws_security_group.app.id
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
  description       = "PostgreSQL inside the VPC"
}

# ---------- Load balancer ----------

resource "aws_lb" "this" {
  #checkov:skip=CKV_AWS_91:No access-log bucket in the demo; enable with an S3 bucket in production
  #checkov:skip=CKV2_AWS_20:Viewers are redirected to HTTPS by CloudFront; the ALB is not reachable directly
  #checkov:skip=CKV2_AWS_28:WAF belongs on CloudFront, the only way in; listed as a production next step
  name                       = var.name
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = var.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
  idle_timeout               = 120
}

resource "aws_lb_target_group" "app" {
  #checkov:skip=CKV_AWS_378:Target traffic stays inside the VPC on the task port
  name                 = var.name
  port                 = local.port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 15

  health_check {
    path                = "/api/health"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  #checkov:skip=CKV_AWS_2:No custom domain, so no ACM certificate; CloudFront terminates TLS and the ALB accepts CloudFront only
  #checkov:skip=CKV_AWS_103:HTTP listener, see CKV_AWS_2
  #checkov:skip=CKV2_AWS_20:Viewers are redirected to HTTPS by CloudFront; the ALB is not reachable directly
  #checkov:skip=CKV_AWS_378:See CKV_AWS_2
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "from_cloudfront" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10

  condition {
    http_header {
      http_header_name = var.origin_header_name
      values           = [var.origin_header_value]
    }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# ---------- Service ----------

resource "aws_ecs_service" "app" {
  #checkov:skip=CKV_AWS_333:Public IP for outbound feeds instead of a NAT gateway; inbound is ALB-only (ADR 0001)
  name                              = var.name
  cluster                           = aws_ecs_cluster.this.id
  task_definition                   = aws_ecs_task_definition.app.arn
  desired_count                     = var.desired_count
  launch_type                       = "FARGATE"
  platform_version                  = "LATEST"
  health_check_grace_period_seconds = 120
  enable_execute_command            = false
  propagate_tags                    = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.public_subnet_ids
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true # outbound to public feeds without a NAT gateway; inbound stays ALB-only
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = local.container
    container_port   = local.port
  }

  depends_on = [aws_lb_listener_rule.from_cloudfront]
}

# ---------- Alarms ----------

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name}-5xx"
  alarm_description   = "The app returned server errors through the load balancer"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.this.arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_topic_arn == "" ? [] : [var.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "unhealthy" {
  alarm_name          = "${var.name}-unhealthy-targets"
  alarm_description   = "No healthy app task behind the load balancer"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.this.arn_suffix, TargetGroup = aws_lb_target_group.app.arn_suffix }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_topic_arn == "" ? [] : [var.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "cpu" {
  alarm_name          = "${var.name}-cpu-high"
  alarm_description   = "App CPU above 85% for 10 minutes"
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = { ClusterName = aws_ecs_cluster.this.name, ServiceName = aws_ecs_service.app.name }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = var.alarm_topic_arn == "" ? [] : [var.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "audit_broken" {
  alarm_name          = "${var.name}-audit-chain-broken"
  alarm_description   = "The nightly check found an edited or deleted audit event"
  namespace           = "OrbitDesk"
  metric_name         = "AuditChainBroken"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_topic_arn == "" ? [] : [var.alarm_topic_arn]
}
