#!/usr/bin/env bash

set -euo pipefail

script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_directory/../.." && pwd)
docker_bin=${DOCKER_BIN:-docker}
terraform_image=$(jq -r '.ci_image' "$repo_root/infra/toolchain.json")
container_environment=()

while IFS= read -r variable_name; do
  case "$variable_name" in
    TF_CLI_ARGS | TF_CLI_ARGS_* | TF_LOG | TF_LOG_PATH | TF_VAR_* | TF_WORKSPACE)
      printf 'prohibited ambient Terraform variable: %s\n' "$variable_name" >&2
      exit 1
      ;;
    GOOGLE_APPLICATION_CREDENTIALS | GOOGLE_CLOUD_PROJECT | GOOGLE_GHA_CREDS_PATH \
      | TF_IN_AUTOMATION | TF_INPUT)
      container_environment+=(-e "$variable_name")
      ;;
  esac
done < <(compgen -e)

exec "$docker_bin" run --rm \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  "${container_environment[@]}" \
  -v "$repo_root:$repo_root" \
  -w "$PWD" \
  "$terraform_image" \
  "$@"
