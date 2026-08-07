#!/usr/bin/env bash

set -euo pipefail

if (($# < 2)); then
  printf 'usage: %s <foundation|development|production> <terraform-command> [args...]\n' "$0" >&2
  exit 64
fi

environment=$1
command=$2
shift 2

case "$environment" in
  foundation | development | production) ;;
  *)
    printf 'unsupported Terraform environment: %s\n' "$environment" >&2
    exit 64
    ;;
esac

case "$command" in
  force-unlock | console)
    printf '%s is restricted to the audited breakglass procedure\n' "$command" >&2
    exit 1
    ;;
  state)
    case "${1:-}" in
      list | show | pull) ;;
      *)
        printf 'terraform state %s is restricted to the audited breakglass procedure\n' "${1:-}" >&2
        exit 1
        ;;
    esac
    ;;
  destroy)
    printf 'direct %s destroy is prohibited; use a reviewed saved destroy plan\n' "$environment" >&2
    exit 1
    ;;
esac

for argument in "$@"; do
  case "$argument" in
    -target | -target=* | --target | --target=* \
      | -refresh | -refresh=* | --refresh | --refresh=* \
      | -lock | -lock=* | --lock | --lock=* \
      | -state | -state=* | --state | --state=* \
      | -state-out | -state-out=* | --state-out | --state-out=* \
      | -backup | -backup=* | --backup | --backup=*)
      printf 'prohibited routine Terraform argument: %s\n' "$argument" >&2
      exit 1
      ;;
  esac
done

if [[ "$command" == plan ]]; then
  has_output=false
  for argument in "$@"; do
    case "$argument" in
      -out=*) has_output=true ;;
    esac
  done
  if [[ "$has_output" != true ]]; then
    printf 'terraform plan must write a saved plan with -out=<path>\n' >&2
    exit 1
  fi
fi

if [[ "$command" == apply ]]; then
  saved_plan=
  for argument in "$@"; do
    case "$argument" in
      -*) ;;
      *) saved_plan=$argument ;;
    esac
  done
  if [[ -z "$saved_plan" || "$saved_plan" != *.tfplan ]]; then
    printf 'terraform apply accepts only an exact saved .tfplan file\n' >&2
    exit 1
  fi
fi
