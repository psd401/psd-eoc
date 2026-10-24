#!/usr/bin/env bash
# Prints a Markdown summary of a saved plan: each changed resource's address
# and actions, and nothing of its values, because this repository is public.
#
# Usage: terraform-plan-summary.sh <plan.json> <run url>
set -euo pipefail

plan="${1:?usage: terraform-plan-summary.sh <plan.json> <run url>}"
run_url="${2:?usage: terraform-plan-summary.sh <plan.json> <run url>}"

changes="$(jq -r '
  [.resource_changes[]? | select(.change.actions != ["no-op"] and .change.actions != ["read"])]
  | map("| `\(.change.actions | join(", "))` | `\(.address)` |")
  | .[]' "$plan")"
replaced="$(jq '[.resource_changes[]? | select(.change.actions | index("delete"))] | length' "$plan")"

echo '### Terraform plan: `infra/terraform/stateful`'
echo
if [ -z "$changes" ]; then
  echo 'No changes.'
else
  echo '| Action | Resource |'
  echo '| --- | --- |'
  echo "$changes"
  echo
  if [ "$replaced" -gt 0 ]; then
    echo "**$replaced resource(s) would be deleted or replaced.** A stateful replacement needs explicit human approval (psd-dev-standards 08); do not approve this apply without it."
    echo
  fi
fi
echo "Values are omitted because this repository is public. The full plan, with tenant values masked, is in [the run's log]($run_url)."
