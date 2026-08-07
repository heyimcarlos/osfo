#!/usr/bin/env bash

set -euo pipefail

if (($# != 2)); then
  printf 'usage: %s <foundation|development|production> <plan-json>\n' "$0" >&2
  exit 64
fi

environment=$1
plan_json=$2

case "$environment" in
  foundation | development | production) ;;
  *)
    printf 'unsupported Terraform environment: %s\n' "$environment" >&2
    exit 64
    ;;
esac

if ! jq -e '
  type == "object"
  and ((.resource_changes // []) | type == "array")
  and all(
    (.resource_changes // [])[];
    (.address | type == "string")
    and (.address | length > 0)
    and (.change | type == "object")
    and (.change.actions | type == "array")
    and (.change.actions | length > 0)
    and all(.change.actions[]; type == "string")
  )
' "$plan_json" >/dev/null; then
  printf 'invalid Terraform plan JSON: %s\n' "$plan_json" >&2
  exit 1
fi

if [[ "$environment" != production ]]; then
  exit 0
fi

if ! delete_count=$(
  jq -er '[
    (.resource_changes // [])[]
    | select(.change.actions | index("delete"))
  ] | length' "$plan_json"
); then
  printf 'unable to evaluate production deletion policy\n' >&2
  exit 1
fi

if ((delete_count > 0)); then
  if ! destructive_addresses=$(
    jq -r '
        (.resource_changes // [])[]
        | select(.change.actions | index("delete"))
        | .address
      ' "$plan_json"
  ); then
    printf 'unable to report prohibited production deletions\n' >&2
    exit 1
  fi
  printf 'production plan contains prohibited delete or replacement actions:\n' >&2
  printf '%s\n' "$destructive_addresses" | sed 's/^/  /' >&2
  exit 1
fi
