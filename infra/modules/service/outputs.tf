output "repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "repository_name" {
  value = aws_ecr_repository.app.name
}

output "cluster_arn" {
  value = aws_ecs_cluster.this.arn
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "service_name" {
  value = aws_ecs_service.app.name
}

output "task_definition_arn" {
  value = aws_ecs_task_definition.app.arn
}

output "task_family" {
  value = aws_ecs_task_definition.app.family
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "task_role_arn" {
  value = aws_iam_role.task.arn
}

output "app_security_group_id" {
  value = aws_security_group.app.id
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.app.name
}

output "app_secret_arn" {
  value = aws_secretsmanager_secret.app.arn
}
