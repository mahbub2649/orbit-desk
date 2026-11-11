variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Isolated subnets, at least two availability zones."
  type        = list(string)
}

variable "client_security_group_ids" {
  description = "Security groups allowed to connect on 5432."
  type        = list(string)
}

variable "engine_version" {
  description = "Aurora PostgreSQL version. Auto-pause at 0 ACU needs a recent version."
  type        = string
  default     = "17.11"
}

variable "database_name" {
  type    = string
  default = "orbitdesk"
}

variable "master_username" {
  type    = string
  default = "orbitdesk"
}

variable "min_acu" {
  description = "Minimum capacity. 0 lets the cluster pause when idle."
  type        = number
  default     = 0
}

variable "max_acu" {
  description = "Maximum capacity. The AWS free plan allows up to 4 ACU per cluster."
  type        = number
  default     = 2
}

variable "auto_pause_seconds" {
  type    = number
  default = 900
}

variable "backup_retention_days" {
  type    = number
  default = 1
}

variable "deletion_protection" {
  description = "Keep true for anything that is not a short-lived demo."
  type        = bool
  default     = true
}

variable "final_snapshot" {
  type    = bool
  default = true
}
