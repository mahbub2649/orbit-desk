output "state_bucket" {
  value = aws_s3_bucket.state.bucket
}

output "plan_role_arn" {
  value = one(aws_iam_role.plan[*].arn)
}

output "deploy_role_arn" {
  value = one(aws_iam_role.deploy[*].arn)
}

output "backend_config" {
  description = "Paste into infra/app/backend.hcl (not committed)."
  value       = <<-EOT
    bucket       = "${aws_s3_bucket.state.bucket}"
    key          = "orbit-desk/app.tfstate"
    region       = "${var.region}"
    use_lockfile = true
    encrypt      = true
  EOT
}
