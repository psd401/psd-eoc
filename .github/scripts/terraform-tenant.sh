#!/usr/bin/env bash
# Writes the stateful root's backend and variables from repository secrets into
# a runner directory, and masks every value in them, one by one, before
# anything prints. GitHub masks a secret only as the whole string it was stored
# as; a plan prints the values inside it separately, and this repository's logs
# are public.
#
# Usage: BACKEND_HCL=... TFVARS=... terraform-tenant.sh <directory>
set -euo pipefail

directory="${1:?usage: terraform-tenant.sh <directory>}"
: "${BACKEND_HCL:?TERRAFORM_STATEFUL_BACKEND_HCL is not set for this repository}"
: "${TFVARS:?TERRAFORM_STATEFUL_TFVARS is not set for this repository}"

umask 077
printf '%s\n' "$BACKEND_HCL" > "$directory/backend.hcl"
printf '%s\n' "$TFVARS" > "$directory/stateful.tfvars"

# Every double-quoted string and every bare twelve-digit account id.
{
  grep -ohE '"[^"]+"' "$directory/backend.hcl" "$directory/stateful.tfvars" | sed -e 's/^"//' -e 's/"$//'
  grep -ohE '\b[0-9]{12}\b' "$directory/backend.hcl" "$directory/stateful.tfvars" || true
} | sort -u | while IFS= read -r value; do
  # A very short value would mask unrelated text all over the log.
  if [ "${#value}" -ge 4 ]; then
    echo "::add-mask::$value"
  fi
done

region="$(sed -nE 's/^[[:space:]]*region[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$directory/backend.hcl" | head -n 1)"
if [ -z "$region" ]; then
  echo "::error::TERRAFORM_STATEFUL_BACKEND_HCL has no region line." >&2
  exit 1
fi
echo "STATE_REGION=$region" >> "$GITHUB_ENV"
