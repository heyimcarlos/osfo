resource "google_pubsub_topic" "agentruns" {
  count   = var.enabled ? 1 : 0
  project = var.project_id
  name    = "${var.name_prefix}-agentruns"
  labels  = var.labels
}

resource "google_pubsub_subscription" "agentruns" {
  count                      = var.enabled ? 1 : 0
  project                    = var.project_id
  name                       = "${var.name_prefix}-agentruns"
  topic                      = google_pubsub_topic.agentruns[0].id
  labels                     = var.labels
  enable_message_ordering    = true
  message_retention_duration = var.message_retention_duration
  retain_acked_messages      = false
  expiration_policy { ttl = "" }
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

output "topic_id" { value = try(google_pubsub_topic.agentruns[0].id, null) }
output "subscription_id" { value = try(google_pubsub_subscription.agentruns[0].id, null) }
