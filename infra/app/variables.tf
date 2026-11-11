variable "region" {
  type    = string
  default = "eu-north-1"
}

variable "name" {
  description = "Prefix for every resource in this stack."
  type        = string
  default     = "orbit-desk"
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "image_tag" {
  description = "Image tag to run, normally the git commit SHA pushed by CI."
  type        = string
}

variable "db_min_acu" {
  type    = number
  default = 0
}

variable "db_max_acu" {
  type    = number
  default = 2
}

variable "protect_data" {
  description = "Deletion protection and a final snapshot for the database; refuses to delete images. Set false only for a throwaway demo."
  type        = bool
  default     = true
}

variable "public_url" {
  description = "The public URL, used in Slack links. Set to the CloudFront URL after the first apply."
  type        = string
  default     = ""
}

variable "extra_environment" {
  description = "Non-secret app settings, e.g. { JIRA_BASE_URL = \"...\", JIRA_PROJECT_KEY = \"XEYE\" }."
  type        = map(string)
  default     = {}
}

variable "alarm_email" {
  description = "Email for CloudWatch alarm notifications. Empty: alarms still show in the console."
  type        = string
  default     = ""
}
