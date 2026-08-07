#!/usr/bin/env bash

set -euo pipefail

if (($# != 3)); then
  printf 'usage: %s <saved-plan-bucket> <root-name> <binding-sha256>\n' "$0" >&2
  exit 64
fi

saved_plan_bucket=$1
root_name=$2
binding_sha256=$3
gcloud_bin=${GCLOUD_BIN:-gcloud}

if [[ ! "$root_name" =~ ^(foundation|development/(platform|runtime)|production/(platform|runtime))$ ]] \
  || [[ ! "$binding_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'saved plan storage identity is invalid\n' >&2
  exit 1
fi

destination_directory=".plans/$root_name"
destination_file="$destination_directory/$binding_sha256.tfplan"
object_prefix="gs://$saved_plan_bucket/roots/$root_name/$binding_sha256"
mkdir -p "$destination_directory"

"$gcloud_bin" storage cp --no-user-output-enabled \
  "$object_prefix.tfplan" "$destination_file"
"$gcloud_bin" storage cp --no-user-output-enabled \
  "$object_prefix.tfplan.manifest.json" "$destination_file.manifest.json"

downloaded_root_name=$(jq -r '.root_name' "$destination_file.manifest.json")
downloaded_binding_sha256=$(jq -r '.binding_sha256' "$destination_file.manifest.json")
if [[ "$downloaded_root_name" != "$root_name" \
  || "$downloaded_binding_sha256" != "$binding_sha256" ]]; then
  printf 'stored plan manifest does not match the approved lookup identity\n' >&2
  exit 1
fi

printf '%s\n' "$destination_file"
