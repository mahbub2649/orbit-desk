output "url" {
  description = "Open this in a browser."
  value       = "https://${module.edge.domain_name}"
}

output "ecr_repository_url" {
  value = module.service.repository_url
}

output "cluster_name" {
  value = module.service.cluster_name
}

output "service_name" {
  value = module.service.service_name
}

output "log_group" {
  value = module.service.log_group_name
}

output "app_secret_arn" {
  description = "Put API keys here with: aws secretsmanager put-secret-value"
  value       = module.service.app_secret_arn
}

output "database_endpoint" {
  value = module.database.endpoint
}

output "audit_schedule" {
  value = module.audit_schedule.schedule_name
}
