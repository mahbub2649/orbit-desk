output "schedule_name" {
  value = aws_scheduler_schedule.audit_check.name
}

output "scheduler_role_arn" {
  value = aws_iam_role.scheduler.arn
}
