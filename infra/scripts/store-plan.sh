#!/usr/bin/env bash

set -euo pipefail

if (($# != 2)); then
  printf 'usage: %s <saved-plan-bucket> <plan-file>\n' "$0" >&2
  exit 64
fi

saved_plan_bucket=$1
plan_file=$(realpath "$2")
manifest_file="$plan_file.manifest.json"
gcloud_bin=${GCLOUD_BIN:-gcloud}
curl_bin=${CURL_BIN:-curl}

if [[ ! -f "$plan_file" || ! -f "$manifest_file" ]]; then
  printf 'saved plan and bound manifest must both exist\n' >&2
  exit 1
fi

root_name=$(jq -r '.root_name' "$manifest_file")
binding_sha256=$(jq -r '.binding_sha256' "$manifest_file")
if [[ ! "$root_name" =~ ^(foundation|development/(platform|runtime)|production/(platform|runtime))$ ]] \
  || [[ ! "$binding_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || [[ ! "$saved_plan_bucket" =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]]; then
  printf 'saved plan manifest has an invalid storage identity\n' >&2
  exit 1
fi

object_name="roots/$root_name/$binding_sha256.tfplan"
access_token=$("$gcloud_bin" auth print-access-token)

upload_object() {
  local source_file=$1
  local destination_name=$2
  local encoded_destination

  encoded_destination=$(jq -rn --arg value "$destination_name" '$value | @uri')
  "$curl_bin" --fail-with-body --silent --show-error --output /dev/null \
    --request POST \
    --header "Authorization: Bearer $access_token" \
    --header 'Content-Type: application/octet-stream' \
    --data-binary "@$source_file" \
    "https://storage.googleapis.com/upload/storage/v1/b/$saved_plan_bucket/o?uploadType=media&name=$encoded_destination&ifGenerationMatch=0"
}

upload_object "$plan_file" "$object_name"
upload_object "$manifest_file" "$object_name.manifest.json"

printf 'gs://%s/%s\n' "$saved_plan_bucket" "$object_name"
