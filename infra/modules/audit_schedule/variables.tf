variable "name" {
  type = string
}

variable "region" {
  type = string
}

variable "cluster_arn" {
  type = string
}

variable "task_family" {
  type = string
}

variable "execution_role_arn" {
  type = string
}

variable "task_role_arn" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "security_group_ids" {
  type = list(string)
}

variable "schedule_expression" {
  type    = string
  default = "cron(0 3 * * ? *)"
}

variable "timezone" {
  type    = string
  default = "Europe/Helsinki"
}
