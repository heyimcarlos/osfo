variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "us-east4"
  validation {
    condition     = var.region == "us-east4"
    error_message = "The development runtime is fixed to us-east4."
  }
}
variable "name_prefix" { type = string }
variable "platform_ready" {
  description = "Explicit operator acknowledgement that the disposable platform exists."
  type        = bool
}
variable "serving_enabled" {
  description = "Creates serving resources only after migration and seed jobs pass."
  type        = bool
}
variable "public_hostname" {
  description = "Optional DNS name controlled by the operator. Null reserves the serving-stage edge IP while keeping the public edge MISSING."
  type        = string
  nullable    = true
}
variable "database_admin_secret_version" {
  description = "Pinned Secret Manager version containing the out-of-band PostgreSQL administrator URL."
  type        = string
  nullable    = true
  validation {
    condition     = var.database_admin_secret_version == null || can(regex("^[1-9][0-9]*\\z", var.database_admin_secret_version))
    error_message = "The secret version must be null or an exact positive integer string."
  }
}
variable "cursor_secret_version" {
  description = "Pinned Secret Manager version number inserted out of band."
  type        = string
  nullable    = true
  validation {
    condition     = var.cursor_secret_version == null || can(regex("^[1-9][0-9]*\\z", var.cursor_secret_version))
    error_message = "The secret version must be null or an exact positive integer string."
  }
}
variable "reference_auth_secret_version" {
  description = "Pinned Secret Manager version number inserted out of band."
  type        = string
  nullable    = true
  validation {
    condition     = var.reference_auth_secret_version == null || can(regex("^[1-9][0-9]*\\z", var.reference_auth_secret_version))
    error_message = "The secret version must be null or an exact positive integer string."
  }
}
variable "model_adapter_secret_version" {
  description = "Pinned Secret Manager version containing the OpenRouter credential inserted out of band."
  type        = string
  nullable    = true
  validation {
    condition     = var.model_adapter_secret_version == null || can(regex("^[1-9][0-9]*\\z", var.model_adapter_secret_version))
    error_message = "The secret version must be null or an exact positive integer string."
  }
}
variable "reference_thread_id" { type = string }
variable "execution_profile_ref" {
  description = "Immutable Oz profile deployed by both admission and AgentRun execution."
  type        = string
  validation {
    condition     = var.execution_profile_ref == "oz.openrouter.minimax.minimax-m3.chat-completions.v1"
    error_message = "The development Oz runtime must use the immutable OpenRouter MiniMax M3 profile."
  }
}
variable "operating_contract" {
  type = object({
    transport_request_concurrency          = number
    transport_max_instances                = number
    transport_admission_db_pool            = number
    transport_resume_db_pool               = number
    transport_max_stream_connections       = number
    relay_worker_count                     = number
    relay_publisher_count                  = number
    relay_publication_window               = number
    relay_db_pool_connections              = number
    relay_safety_drain_ms                  = number
    agentrun_worker_count                  = number
    agentrun_streams_per_worker            = number
    agentrun_execution_slots_per_worker    = number
    agentrun_db_pool_connections           = number
    agentrun_lease_duration_ms             = number
    agentrun_lease_renewal_interval_ms     = number
    agentrun_cancellation_poll_interval_ms = number
    agentrun_cancellation_grace_ms         = number
    agentrun_termination_deadline_ms       = number
  })
  validation {
    condition = (
      var.operating_contract.relay_worker_count == 1
      && var.operating_contract.relay_publisher_count == 4
      && var.operating_contract.relay_publication_window == 128
      && var.operating_contract.relay_safety_drain_ms == 1000
      && var.operating_contract.agentrun_worker_count == 6
      && var.operating_contract.agentrun_streams_per_worker == 4
      && var.operating_contract.agentrun_execution_slots_per_worker == 32
      && var.operating_contract.agentrun_db_pool_connections == 8
      && var.operating_contract.agentrun_lease_duration_ms == 30000
      && var.operating_contract.agentrun_lease_renewal_interval_ms == 10000
      && var.operating_contract.agentrun_cancellation_poll_interval_ms == 100
      && var.operating_contract.agentrun_cancellation_grace_ms == 100
      && var.operating_contract.agentrun_termination_deadline_ms == 1000
    )
    error_message = "The development demo must retain the reviewed fixed-one relay and unqualified six-worker candidate."
  }
}
