#!/usr/bin/env bash

set -euo pipefail

if (($# != 1)); then
  printf 'usage: %s <infra-directory>\n' "$0" >&2
  exit 64
fi

infra_directory=$1

if [[ ! -d "$infra_directory" ]]; then
  printf 'infrastructure directory does not exist: %s\n' "$infra_directory" >&2
  exit 1
fi

failures=0

report_matches() {
  local description=$1
  local pattern=$2
  shift 2

  local matches
  matches=$(rg --line-number --glob '*.tf' "$pattern" "$@" 2>/dev/null || true)
  if [[ -n "$matches" ]]; then
    printf '%s:\n%s\n' "$description" "$matches" >&2
    failures=$((failures + 1))
  fi
}

report_matches 'terraform_remote_state is prohibited' \
  'terraform_remote_state' "$infra_directory"
report_matches 'Terraform workspaces are prohibited' \
  'terraform\.workspace|workspace_key_prefix' "$infra_directory"
report_matches 'service-account keys are prohibited' \
  'google_service_account_key' "$infra_directory"
report_matches 'secret payload versions are prohibited' \
  'google_secret_manager_secret_version' "$infra_directory"
report_matches 'Terraform roots cannot be consumed as modules' \
  'source\s*=\s*"[^\"]*roots/' "$infra_directory"

while IFS= read -r root_directory; do
  versions_file="$root_directory/versions.tf"
  if [[ ! -f "$versions_file" ]]; then
    printf 'Terraform root lacks versions.tf: %s\n' "$root_directory" >&2
    failures=$((failures + 1))
    continue
  fi

  if ! rg --quiet 'required_version\s*=\s*"=\s*[0-9]+\.[0-9]+\.[0-9]+"' "$versions_file"; then
    printf 'Terraform root must use an exact required_version: %s\n' "$versions_file" >&2
    failures=$((failures + 1))
  fi
done < <(
  find "$infra_directory/roots" -mindepth 1 -type f -name '*.tf' -exec dirname {} \; 2>/dev/null \
    | sort -u
)

while IFS=: read -r file line_number source; do
  [[ -n "$file" ]] || continue

  case "$source" in
    ./* | ../*) continue ;;
    git::* | http://* | https://*)
      if [[ ! "$source" =~ \?ref=[0-9a-fA-F]{40}($|&) ]]; then
        printf 'Git module source must use an immutable 40-character commit SHA: %s:%s\n' "$file" "$line_number" >&2
        failures=$((failures + 1))
      fi
      ;;
    *)
      block=$(sed -n "${line_number},$((line_number + 8))p" "$file")
      if ! grep -Eq 'version[[:space:]]*=[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"' <<<"$block"; then
        printf 'registry module source must use an exact version: %s:%s\n' "$file" "$line_number" >&2
        failures=$((failures + 1))
      fi
      ;;
  esac
done < <(
  rg --line-number --no-heading --glob '*.tf' \
    'source\s*=\s*"[^\"]+"' "$infra_directory" 2>/dev/null \
    | sed -E 's/^([^:]+):([0-9]+):.*source[[:space:]]*=[[:space:]]*"([^\"]+)".*/\1:\2:\3/'
)

if ((failures > 0)); then
  exit 1
fi
