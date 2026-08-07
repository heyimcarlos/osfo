mock_provider "google" {}

variables {
  project_id                   = "osfo-development-318708913"
  region                       = "us-east4"
  name_prefix                  = "osfo-dev"
  platform_ready               = false
  serving_enabled              = false
  public_hostname              = null
  cursor_secret_version        = null
  model_adapter_secret_version = null
  execution_profile_ref        = "oz.openrouter.minimax.minimax-m3.chat-completions.v1"
  operating_contract = {
    transport_request_concurrency          = 80
    transport_max_instances                = 1
    transport_admission_db_pool            = 8
    transport_resume_db_pool               = 8
    transport_max_stream_connections       = 64
    relay_worker_count                     = 1
    relay_publisher_count                  = 4
    relay_publication_window               = 128
    relay_db_pool_connections              = 8
    relay_safety_drain_ms                  = 1000
    agentrun_worker_count                  = 6
    agentrun_streams_per_worker            = 4
    agentrun_execution_slots_per_worker    = 32
    agentrun_db_pool_connections           = 8
    agentrun_lease_duration_ms             = 30000
    agentrun_lease_renewal_interval_ms     = 10000
    agentrun_cancellation_poll_interval_ms = 100
    agentrun_cancellation_grace_ms         = 100
    agentrun_termination_deadline_ms       = 1000
  }
}

run "accept_null_versions" {
  command = plan
}

run "accept_positive_integer_versions" {
  command = plan
  variables {
    cursor_secret_version        = "1"
    model_adapter_secret_version = "1"
  }
}

run "reject_cursor_latest" {
  command = plan
  variables { cursor_secret_version = "latest" }
  expect_failures = [var.cursor_secret_version]
}

run "reject_cursor_zero" {
  command = plan
  variables { cursor_secret_version = "0" }
  expect_failures = [var.cursor_secret_version]
}

run "reject_cursor_whitespace" {
  command = plan
  variables { cursor_secret_version = "1 " }
  expect_failures = [var.cursor_secret_version]
}

run "reject_cursor_newline" {
  command = plan
  variables { cursor_secret_version = "1\n" }
  expect_failures = [var.cursor_secret_version]
}

run "reject_cursor_nonnumeric" {
  command = plan
  variables { cursor_secret_version = "one" }
  expect_failures = [var.cursor_secret_version]
}

run "reject_model_adapter_latest" {
  command = plan
  variables { model_adapter_secret_version = "latest" }
  expect_failures = [var.model_adapter_secret_version]
}

run "reject_model_adapter_zero" {
  command = plan
  variables { model_adapter_secret_version = "0" }
  expect_failures = [var.model_adapter_secret_version]
}

run "reject_model_adapter_whitespace" {
  command = plan
  variables { model_adapter_secret_version = "\t1" }
  expect_failures = [var.model_adapter_secret_version]
}

run "reject_model_adapter_newline" {
  command = plan
  variables { model_adapter_secret_version = "\n1" }
  expect_failures = [var.model_adapter_secret_version]
}

run "reject_model_adapter_nonnumeric" {
  command = plan
  variables { model_adapter_secret_version = "1.0" }
  expect_failures = [var.model_adapter_secret_version]
}
