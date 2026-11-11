variable "region" {
  description = "The project's AWS Region. All regional resources live here."
  type        = string
  default     = "eu-north-1"
}

variable "github_repo" {
  description = "owner/name of the GitHub repository whose workflows may assume the roles."
  type        = string
}

variable "plan_subjects" {
  description = "OIDC subject suffixes allowed to assume the read-only plan role."
  type        = list(string)
  default     = ["pull_request", "ref:refs/heads/main"]
}

variable "deploy_subjects" {
  description = <<-EOT
    OIDC subject suffixes allowed to assume the deploy role. Defaults to the main branch.
    With a public repository (or a paid plan), switch to ["environment:production"] and add
    required reviewers to that environment, so every apply needs an approval.
  EOT
  type        = list(string)
  default     = ["ref:refs/heads/main"]
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget for the whole project, in USD."
  type        = number
  default     = 20
}

variable "budget_email" {
  description = "Where budget alerts go. Empty creates the budget without email alerts."
  type        = string
  default     = ""
}

variable "enable_github_oidc" {
  description = <<-EOT
    Create GitHub's OIDC provider and the plan/deploy roles. Set false where an organization
    policy (SCP) denies iam:CreateOpenIDConnectProvider, as in AWS's new-experience projects;
    deploy from a workstation with short-lived `aws login` credentials instead.
  EOT
  type        = bool
  default     = true
}
