output "endpoint" {
  value = aws_rds_cluster.this.endpoint
}

output "port" {
  value = aws_rds_cluster.this.port
}

output "database_name" {
  value = aws_rds_cluster.this.database_name
}

output "master_secret_arn" {
  description = "Secrets Manager secret (JSON with username and password) that RDS manages."
  value       = aws_rds_cluster.this.master_user_secret[0].secret_arn
}

output "cluster_id" {
  value = aws_rds_cluster.this.cluster_identifier
}
