variable "name" {
  type = string
}

variable "cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "flow_log_group_arn" {
  description = "CloudWatch log group for VPC flow logs of rejected traffic. Empty disables them."
  type        = string
  default     = ""
}

variable "flow_log_role_arn" {
  type    = string
  default = ""
}
