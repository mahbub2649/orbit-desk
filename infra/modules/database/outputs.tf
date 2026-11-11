output "endpoint" {
  value = data.aws_rds_cluster.this.endpoint
}

output "port" {
  value = data.aws_rds_cluster.this.port
}

output "database_name" {
  value = var.database_name
}

output "username" {
  value = var.master_username
}

output "cluster_id" {
  value = data.aws_rds_cluster.this.cluster_identifier
}

output "connect_resource_arn" {
  description = "Resource for rds-db:connect: this cluster's database user."
  value       = "arn:aws:rds-db:${var.region}:${split(":", data.aws_rds_cluster.this.arn)[4]}:dbuser:${data.aws_rds_cluster.this.cluster_resource_id}/${var.master_username}"
}
