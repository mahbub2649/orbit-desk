variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "image_tag" {
  description = "Tag of the image in this module's ECR repository."
  type        = string
}

variable "cpu" {
  type    = number
  default = 1024
}

variable "memory" {
  type    = number
  default = 2048
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "db_host" {
  type = string
}

variable "db_port" {
  type = number
}

variable "db_name" {
  type = string
}

variable "db_secret_arn" {
  description = "Secrets Manager secret with username and password keys (managed by RDS)."
  type        = string
}

variable "public_url" {
  type = string
}

variable "origin_header_name" {
  type    = string
  default = "X-Origin-Verify"
}

variable "origin_header_value" {
  type      = string
  sensitive = true
}

variable "extra_environment" {
  description = "Non-secret settings, for example JIRA_BASE_URL or INTEL_ENABLED."
  type        = map(string)
  default     = {}
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "alarm_topic_arn" {
  type    = string
  default = ""
}

variable "force_delete_images" {
  description = "Allow destroying the repository while it still holds images (demo stacks)."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Protect the load balancer from accidental deletion."
  type        = bool
  default     = true
}
