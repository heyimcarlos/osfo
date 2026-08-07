variable "enabled" { type = bool }
variable "project_id" { type = string }
variable "region" { type = string }
variable "name_prefix" { type = string }
variable "labels" { type = map(string) }
variable "network_cidr" { type = string }
variable "private_service_cidr_prefix" { type = number }
variable "temporal_service_attachment_uri" {
  type     = string
  nullable = true
}
variable "temporal_dns_name" { type = string }
