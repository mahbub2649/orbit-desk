# EventBridge Scheduler runs a one-off Fargate task every night that re-verifies the
# hash-chained audit log (python -m app.verify_audit). The task prints its result as Splunk HEC
# JSON; a CloudWatch metric filter and alarm in the service module turn a failure into an alert.

data "aws_caller_identity" "me" {}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.me.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "orbit-desk-app-${var.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

data "aws_iam_policy_document" "run_task" {
  statement {
    actions   = ["ecs:RunTask"]
    resources = ["arn:aws:ecs:*:${data.aws_caller_identity.me.account_id}:task-definition/${var.task_family}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.cluster_arn]
    }
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = [var.execution_role_arn, var.task_role_arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  statement {
    actions   = ["ecs:TagResource"]
    resources = ["arn:aws:ecs:*:${data.aws_caller_identity.me.account_id}:task/*"]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "run-audit-check"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.run_task.json
}

resource "aws_scheduler_schedule" "audit_check" {
  #checkov:skip=CKV_AWS_297:Uses the AWS-owned key; the schedule holds no sensitive data
  name                         = "${var.name}-audit-check"
  description                  = "Nightly verification of the hash-chained audit log"
  schedule_expression          = var.schedule_expression
  schedule_expression_timezone = var.timezone
  state                        = "ENABLED"

  flexible_time_window { mode = "OFF" }

  target {
    arn      = var.cluster_arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      # The family without a revision always runs the latest active revision.
      task_definition_arn = "arn:aws:ecs:${var.region}:${data.aws_caller_identity.me.account_id}:task-definition/${var.task_family}"
      launch_type         = "FARGATE"
      task_count          = 1
      propagate_tags      = "TASK_DEFINITION"

      network_configuration {
        subnets          = var.subnet_ids
        security_groups  = var.security_group_ids
        assign_public_ip = true
      }
    }

    # For an ECS target, the input is the RunTask "overrides" object.
    input = jsonencode({
      containerOverrides = [{ name = "app", command = ["python", "-m", "app.verify_audit"] }]
    })

    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 3600
    }
  }
}
