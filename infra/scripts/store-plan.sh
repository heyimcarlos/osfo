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

if [[ ! -f "$plan_file" || ! -f "$manifest_file" ]]; then
  printf 'saved plan and bound manifest must both exist\n' >&2
  exit 1
fi

root_name=$(jq -r '.root_name' "$manifest_file")
binding_sha256=$(jq -r '.binding_sha256' "$manifest_file")
if [[ ! "$root_name" =~ ^(foundation|development/(platform|runtime)|production/(platform|runtime))$ ]] \
  || [[ ! "$binding_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'saved plan manifest has an invalid storage identity\n' >&2
  exit 1
fi

object_prefix="gs://$saved_plan_bucket/roots/$root_name/$binding_sha256"
"$gcloud_bin" storage cp --no-user-output-enabled --if-generation-match=0 \
  "$plan_file" "$object_prefix.tfplan"
"$gcloud_bin" storage cp --no-user-output-enabled --if-generation-match=0 \
  "$manifest_file" "$object_prefix.tfplan.manifest.json"

printf '%s.tfplan\n' "$object_prefix"
