variable "organization_id" {
  description = "Optional numeric Google Cloud organization ID. Null creates projects under No organization."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.organization_id == null || can(regex("^[0-9]+$", var.organization_id))
    error_message = "organization_id must be null or numeric."
  }
}

variable "billing_account" {
  description = "Billing account attached to the three Osfo projects."
  type        = string

  validation {
    condition     = can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account))
    error_message = "billing_account must use the 000000-000000-000000 form."
  }
}

variable "project_ids" {
  description = "Globally unique project IDs for the foundation, development, and production boundaries."
  type = object({
    foundation  = string
    development = string
    production  = string
  })
}

variable "state_bucket_names" {
  description = "Globally unique GCS bucket names for each isolated Terraform state root."
  type = object({
    foundation  = string
    development = string
    production  = string
  })
}

variable "saved_plan_bucket_name" {
  description = "Globally unique foundation GCS bucket for encrypted, short-lived saved plans."
  type        = string
}

variable "github_repository" {
  description = "GitHub repository in owner/name form, retained as an audit label."
  type        = string

  validation {
    condition     = can(regex("^[^/]+/[^/]+$", var.github_repository))
    error_message = "github_repository must use owner/name form."
  }
}

variable "github_repository_id" {
  description = "Immutable numeric GitHub repository ID used by the OIDC trust condition."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "github_repository_id must be numeric."
  }
}

variable "github_repository_owner_id" {
  description = "Immutable numeric GitHub repository owner ID used by the OIDC trust condition."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_owner_id))
    error_message = "github_repository_owner_id must be numeric."
  }
}

variable "region" {
  description = "Selected region for development and production infrastructure."
  type        = string
  default     = "us-east4"

  validation {
    condition     = var.region == "us-east4"
    error_message = "Osfo v1 is structurally fixed to us-east4."
  }
}
