resource "google_compute_network" "platform" {
  count = var.enabled ? 1 : 0

  project                 = var.project_id
  name                    = "${var.name_prefix}-vpc"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "platform" {
  count = var.enabled ? 1 : 0

  project                  = var.project_id
  name                     = "${var.name_prefix}-us-east4"
  region                   = var.region
  network                  = google_compute_network.platform[0].id
  ip_cidr_range            = var.network_cidr
  private_ip_google_access = true
}

resource "google_compute_router" "platform" {
  count = var.enabled ? 1 : 0

  project = var.project_id
  name    = "${var.name_prefix}-router"
  region  = var.region
  network = google_compute_network.platform[0].id
}

resource "google_compute_address" "egress" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  name         = "${var.name_prefix}-egress"
  region       = var.region
  address_type = "EXTERNAL"
  network_tier = "PREMIUM"
  labels       = var.labels
}

resource "google_compute_router_nat" "platform" {
  count = var.enabled ? 1 : 0

  project                            = var.project_id
  name                               = "${var.name_prefix}-nat"
  region                             = var.region
  router                             = google_compute_router.platform[0].name
  nat_ip_allocate_option             = "MANUAL_ONLY"
  nat_ips                            = [google_compute_address.egress[0].self_link]
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"
  min_ports_per_vm                   = 64

  subnetwork {
    name                    = google_compute_subnetwork.platform[0].id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

resource "google_compute_global_address" "private_services" {
  count = var.enabled ? 1 : 0

  project       = var.project_id
  name          = "${var.name_prefix}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = var.private_service_cidr_prefix
  network       = google_compute_network.platform[0].id
  labels        = var.labels
}

resource "google_service_networking_connection" "private_services" {
  count = var.enabled ? 1 : 0

  network                 = google_compute_network.platform[0].id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services[0].name]
}

resource "google_compute_address" "temporal" {
  count = var.enabled && var.temporal_service_attachment_uri != null ? 1 : 0

  project      = var.project_id
  name         = "${var.name_prefix}-temporal-psc"
  region       = var.region
  address_type = "INTERNAL"
  subnetwork   = google_compute_subnetwork.platform[0].id
  labels       = var.labels
}

resource "google_compute_forwarding_rule" "temporal" {
  count = var.enabled && var.temporal_service_attachment_uri != null ? 1 : 0

  project               = var.project_id
  name                  = "${var.name_prefix}-temporal-psc"
  region                = var.region
  network               = google_compute_network.platform[0].id
  subnetwork            = google_compute_subnetwork.platform[0].id
  ip_address            = google_compute_address.temporal[0].id
  target                = var.temporal_service_attachment_uri
  load_balancing_scheme = ""
}

resource "google_dns_managed_zone" "private" {
  count = var.enabled ? 1 : 0

  project     = var.project_id
  name        = "${var.name_prefix}-private"
  dns_name    = var.temporal_dns_name
  description = "Private Osfo development service names."
  visibility  = "private"
  labels      = var.labels

  private_visibility_config {
    networks { network_url = google_compute_network.platform[0].id }
  }
}

resource "google_dns_record_set" "temporal" {
  count = var.enabled && var.temporal_service_attachment_uri != null ? 1 : 0

  project      = var.project_id
  managed_zone = google_dns_managed_zone.private[0].name
  name         = "api.${var.temporal_dns_name}"
  type         = "A"
  ttl          = 30
  rrdatas      = [google_compute_address.temporal[0].address]
}

resource "google_compute_firewall" "deny_ingress" {
  count = var.enabled ? 1 : 0

  project       = var.project_id
  name          = "${var.name_prefix}-deny-ingress"
  network       = google_compute_network.platform[0].name
  direction     = "INGRESS"
  priority      = 65534
  source_ranges = ["0.0.0.0/0"]
  deny { protocol = "all" }
  log_config { metadata = "INCLUDE_ALL_METADATA" }
}

resource "google_compute_firewall" "allow_egress" {
  count = var.enabled ? 1 : 0

  project            = var.project_id
  name               = "${var.name_prefix}-allow-egress"
  network            = google_compute_network.platform[0].name
  direction          = "EGRESS"
  priority           = 1000
  destination_ranges = ["0.0.0.0/0"]
  allow { protocol = "all" }
  log_config { metadata = "INCLUDE_ALL_METADATA" }
}

output "network_id" { value = try(google_compute_network.platform[0].id, null) }
output "subnetwork_id" { value = try(google_compute_subnetwork.platform[0].id, null) }
output "static_egress_ip" { value = try(google_compute_address.egress[0].address, null) }
output "temporal_endpoint_ip" { value = try(google_compute_address.temporal[0].address, null) }
output "private_service_connection" { value = try(google_service_networking_connection.private_services[0].id, null) }
output "private_dns_managed_zone_id" { value = try(google_dns_managed_zone.private[0].managed_zone_id, null) }
output "private_dns_managed_zone_name" { value = try(google_dns_managed_zone.private[0].name, null) }
