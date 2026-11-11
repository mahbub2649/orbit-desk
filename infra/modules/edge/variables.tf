variable "name" {
  type = string
}

variable "alb_dns_name" {
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
