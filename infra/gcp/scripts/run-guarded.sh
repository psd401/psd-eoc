#!/bin/sh -p

set -eu

PATH='/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
export PATH

fail() {
  printf '%s\n' "$1" >&2
  exit 64
}

if [ "${HOME-}" != '/Users/hagelk' ] ||
  { [ -n "${USER-}" ] && [ "$USER" != 'hagelk' ]; } ||
  { [ -n "${LOGNAME-}" ] && [ "$LOGNAME" != 'hagelk' ]; }; then
  fail 'Guarded cloud scripts require the fixed hagelk account and /Users/hagelk home directory.'
fi

startup_overrides=$(
  /usr/bin/env | LC_ALL=C /usr/bin/awk -F= '
    $1 == "BROWSER" ||
    $1 == "LD_AUDIT" ||
    $1 == "LD_LIBRARY_PATH" ||
    $1 == "LD_PRELOAD" ||
    $1 == "NODE_OPTIONS" ||
    $1 == "VIRTUAL_ENV" ||
    $1 ~ /^BUN_[A-Za-z0-9_]*$/ ||
    $1 ~ /^DYLD_[A-Za-z0-9_]*$/ ||
    $1 ~ /^PYTHON[A-Za-z0-9_]*$/ { print $1 }
  '
) || fail 'Could not inspect the guarded Bun startup environment.'

if [ -n "$startup_overrides" ]; then
  fail "Guarded cloud scripts reject startup hooks and executable overrides; unset: $startup_overrides"
fi

operator_action=''
case "${1-}" in
  apply)
    entrypoint='apply.ts'
    ;;
  authenticate | authorize-workspace-adc | restore-adc | show-groups-reader-client-id)
    entrypoint='operator-access.ts'
    operator_action=$1
    ;;
  configure-workspace-role)
    entrypoint='configure-workspace-role.ts'
    ;;
  provision-groups-credential)
    entrypoint='provision-groups-credential.ts'
    ;;
  revoke-groups-credential)
    entrypoint='revoke-groups-credential.ts'
    ;;
  store-oauth-client)
    entrypoint='store-oauth-client.ts'
    ;;
  verify-groups-readonly)
    entrypoint='verify-groups-readonly.ts'
    ;;
  *)
    fail 'Usage: ./scripts/run-guarded.sh {apply|authenticate|authorize-workspace-adc|configure-workspace-role|provision-groups-credential|restore-adc|revoke-groups-credential|show-groups-reader-client-id|store-oauth-client|verify-groups-readonly} [arguments]'
    ;;
esac
shift

script_directory=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P) ||
  fail 'Could not resolve the guarded launcher directory.'
gcp_root=$(CDPATH= cd -- "$script_directory/.." && pwd -P) ||
  fail 'Could not resolve the GCP Terraform root.'

cd -- "$gcp_root" || fail 'Could not enter the GCP Terraform root.'
umask 077
PSD_EOC_GUARDED_LAUNCHER=1
export PSD_EOC_GUARDED_LAUNCHER

if [ -n "$operator_action" ]; then
  set -- "$operator_action" "$@"
fi

exec /opt/homebrew/bin/bun \
  "--config=$gcp_root/bunfig.toml" \
  --no-env-file \
  --no-install \
  "$gcp_root/scripts/$entrypoint" \
  "$@"
