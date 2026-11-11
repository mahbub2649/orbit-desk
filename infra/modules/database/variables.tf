variable "name" {
  type = string
}

variable "region" {
  type = string
}

variable "master_username" {
  description = "Database user the app connects as, with IAM authentication."
  type        = string
  default     = "orbitdesk"
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

variable "deletion_protection" {
  description = "Keep true for anything that is not a short-lived demo."
  type        = bool
  default     = true
}
