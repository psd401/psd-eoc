#!/usr/bin/env bash

set -Eeuo pipefail

readonly system_image='system-images;android-36;google_apis;x86_64'
readonly emulator_port='5554'
readonly emulator_serial="emulator-${emulator_port}"
readonly avd_profile='pixel_7'
readonly suite_timeout='120m'
readonly expected_android_completion=$'issue=32\nplatform=android\nclassification=drill\nroster=synthetic\nproviders=mocked\nstatus=passed'
readonly expected_android_provisional_completion=$'issue=32\nplatform=android\nclassification=drill\nroster=synthetic\nproviders=mocked\nstatus=suite-passed-awaiting-emulator-cleanup'

fail() {
  printf 'Issue #32 Android CI: %s\n' "$1" >&2
  exit 1
}

test "${GITHUB_ACTIONS:-}" = 'true' || fail 'GitHub Actions is required.'
test "${RUNNER_OS:-}" = 'Linux' || fail 'a Linux hosted runner is required.'
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] || fail 'GITHUB_RUN_ID must be numeric.'
[[ "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] || fail 'GITHUB_RUN_ATTEMPT must be numeric.'
[[ "${RUNNER_TEMP:-}" = /* && "${RUNNER_TEMP}" != '/' ]] || fail 'RUNNER_TEMP must be an absolute non-root path.'
[[ "${ANDROID_HOME:-}" = /* && -d "${ANDROID_HOME}" ]] || fail 'ANDROID_HOME must identify the hosted Android SDK.'

artifact_dir="${PSD_EOC_MOBILE_E2E_ARTIFACT_DIR:-}"
[[ "$artifact_dir" = "${RUNNER_TEMP}/"* ]] || fail 'the artifact directory must be inside RUNNER_TEMP.'
[[ -d "$artifact_dir" && ! -L "$artifact_dir" ]] || fail 'the artifact directory must be a regular directory.'

sdkmanager_bin="${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager"
avdmanager_bin="${ANDROID_HOME}/cmdline-tools/latest/bin/avdmanager"
adb_bin="${ANDROID_HOME}/platform-tools/adb"
timeout_bin="$(command -v timeout || true)"
setsid_bin="$(command -v setsid || true)"
bun_bin="$(command -v bun || true)"
for required_bin in \
  "$sdkmanager_bin" \
  "$avdmanager_bin" \
  "$adb_bin" \
  "$timeout_bin" \
  "$setsid_bin" \
  "$bun_bin"; do
  [[ "$required_bin" = /* && -x "$required_bin" ]] || fail 'a required hosted-runner tool is unavailable.'
done

if "$adb_bin" -s "$emulator_serial" get-state >/dev/null 2>&1; then
  fail "refusing to adopt a pre-existing ${emulator_serial} device."
fi

avd_name="psd-eoc-issue32-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
android_user_home="${RUNNER_TEMP}/psd-eoc-android-user-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
android_emulator_home="${RUNNER_TEMP}/psd-eoc-android-emulator-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
avd_home="${android_emulator_home}/avd"
for android_state_root in "$android_user_home" "$android_emulator_home"; do
  test ! -e "$android_state_root" || fail 'an issue-owned Android state directory already exists.'
done
install -d -m 0700 "$android_user_home" "$android_emulator_home" "$avd_home"
export ANDROID_USER_HOME="$android_user_home"
export ANDROID_EMULATOR_HOME="$android_emulator_home"
export ANDROID_AVD_HOME="$avd_home"

licenses_log="$artifact_dir/android-sdk-licenses.log"
sdk_log="$artifact_dir/android-sdk-install.log"
avd_log="$artifact_dir/android-avd-create.log"
emulator_log="$artifact_dir/android-emulator.log"
cleanup_log="$artifact_dir/android-emulator-cleanup.log"
android_artifact_dir="$artifact_dir/issue-32/android"
provisional_completion_marker="$android_artifact_dir/suite-complete-awaiting-emulator-cleanup.txt"
final_completion_marker="$android_artifact_dir/complete.txt"
final_completion_temp="$android_artifact_dir/.complete-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.tmp"

# The hosted image already carries accepted SDK licenses. Reconfirm them for
# the newly installed system image without letting `yes` SIGPIPE hide the
# sdkmanager exit status.
set +e
set +o pipefail
yes | "$timeout_bin" --signal=TERM --kill-after=10s 5m \
  "$sdkmanager_bin" --licenses >"$licenses_log" 2>&1
license_status="${PIPESTATUS[1]}"
set -o pipefail
set -e
test "$license_status" -eq 0 || fail 'Android SDK license confirmation failed.'

"$timeout_bin" --signal=TERM --kill-after=30s 25m \
  "$sdkmanager_bin" --install \
  'build-tools;37.0.0' \
  platform-tools \
  'platforms;android-36' \
  emulator \
  "$system_image" \
  --channel=0 >"$sdk_log" 2>&1

emulator_bin="${ANDROID_HOME}/emulator/emulator"
[[ -x "$emulator_bin" ]] || fail 'sdkmanager did not install the Android emulator.'
"$timeout_bin" --signal=TERM --kill-after=5s 30s \
  "$emulator_bin" -accel-check \
  >"$artifact_dir/android-acceleration.txt" 2>&1

printf 'no\n' | "$timeout_bin" --signal=TERM --kill-after=10s 2m \
  "$avdmanager_bin" create avd \
  --force \
  --name "$avd_name" \
  --package "$system_image" \
  --device "$avd_profile" >"$avd_log" 2>&1

avd_config="${ANDROID_AVD_HOME}/${avd_name}.avd/config.ini"
[[ -f "$avd_config" && ! -L "$avd_config" ]] || fail 'avdmanager did not create the exact issue-owned AVD.'
printf '%s\n' \
  'hw.cpu.ncore=1' \
  'hw.keyboard=yes' \
  >>"$avd_config"

emulator_pid=''
emulator_pgid=''

emulator_process_running() {
  local process_state
  test -n "$emulator_pid" || return 1
  kill -0 "$emulator_pid" 2>/dev/null || return 1
  process_state="$(ps -o stat= -p "$emulator_pid" 2>/dev/null)" || return 1
  process_state="${process_state//[[:space:]]/}"
  [[ "$process_state" != Z* ]]
}

emulator_process_is_owned() {
  local command_line
  [[ -n "$emulator_pid" && -r "/proc/${emulator_pid}/cmdline" ]] || return 1
  command_line="$(tr '\0' ' ' <"/proc/${emulator_pid}/cmdline")" || return 1
  [[ " $command_line " = *" -avd ${avd_name} "* ]] || return 1
  [[ " $command_line " = *" -port ${emulator_port} "* ]]
}

emulator_process_group_running() {
  local candidate_pgid member_state process_table
  test -n "$emulator_pgid" || return 1
  # Losing the ability to enumerate the group is not proof that it retired.
  # Treat an observation failure as still running so cleanup fails closed.
  process_table="$(ps -eo pgid=,stat=)" || return 0
  while read -r candidate_pgid member_state; do
    member_state="${member_state//[[:space:]]/}"
    if test "$candidate_pgid" = "$emulator_pgid" && [[ "$member_state" != Z* ]]; then
      return 0
    fi
  done <<<"$process_table"
  return 1
}

emulator_process_group_is_owned() {
  local member_pid candidate_pgid command_line process_table
  local found_member='false'
  local found_exact_owner='false'
  test -n "$emulator_pgid" || return 1
  process_table="$(ps -eo pid=,pgid=)" || return 1
  while read -r member_pid candidate_pgid; do
    test "$candidate_pgid" = "$emulator_pgid" || continue
    found_member='true'
    [[ "$member_pid" =~ ^[1-9][0-9]*$ && -r "/proc/${member_pid}/cmdline" ]] || continue
    command_line="$(tr '\0' ' ' <"/proc/${member_pid}/cmdline")" || continue
    if [[ " $command_line " = *" -avd ${avd_name} "* ]] &&
      [[ " $command_line " = *" -port ${emulator_port} "* ]]; then
      found_exact_owner='true'
    fi
  done <<<"$process_table"
  test "$found_member" = 'true' && test "$found_exact_owner" = 'true'
}

signal_owned_emulator_group() {
  local signal="$1"
  emulator_process_group_running || return 0
  emulator_process_group_is_owned || return 1
  if kill "-$signal" -- "-${emulator_pgid}"; then
    return 0
  fi
  # A normal shutdown can retire the group between the proof and signal.
  emulator_process_group_running || return 0
  return 1
}

emulator_device_is_present_or_unknown() {
  local device_snapshot listed_serial listed_state
  # Only a successful complete device-list observation can prove absence.
  # A timeout or adb failure stays conservatively active and blocks success.
  device_snapshot="$(
    "$timeout_bin" --signal=TERM --kill-after=1s 2s \
      "$adb_bin" devices 2>/dev/null
  )" || return 0
  while read -r listed_serial listed_state; do
    if test "$listed_serial" = "$emulator_serial"; then
      return 0
    fi
  done <<<"$device_snapshot"
  return 1
}

capture_failure_diagnostics() {
  "$timeout_bin" --signal=TERM --kill-after=5s 15s \
    "$adb_bin" -s "$emulator_serial" shell getprop \
    >"$artifact_dir/android-emulator-getprop.txt" 2>&1 || true
  "$timeout_bin" --signal=TERM --kill-after=5s 15s \
    "$adb_bin" -s "$emulator_serial" logcat -d \
    >"$artifact_dir/android-emulator-logcat.txt" 2>&1 || true
}

cleanup_emulator() {
  local cleanup_status=0

  {
    if test -z "$emulator_pid"; then
      printf '%s\n' 'No issue-owned Android emulator process was started.'
      return 0
    fi

    "$timeout_bin" --signal=TERM --kill-after=5s 10s \
      "$adb_bin" -s "$emulator_serial" emu kill || true
    for _ in {1..20}; do
      emulator_process_group_running || break
      sleep 1
    done

    if emulator_process_group_running; then
      if ! signal_owned_emulator_group TERM; then
        printf '%s\n' 'Refusing TERM because exact Android process-group ownership cannot be proven.'
        cleanup_status=1
      fi
      for _ in {1..10}; do
        emulator_process_group_running || break
        sleep 1
      done
    fi

    if emulator_process_group_running; then
      if ! signal_owned_emulator_group KILL; then
        printf '%s\n' 'Refusing KILL because exact Android process-group ownership cannot be proven.'
        cleanup_status=1
      fi
      for _ in {1..5}; do
        emulator_process_group_running || break
        sleep 1
      done
    fi

    for _ in {1..10}; do
      emulator_device_is_present_or_unknown || break
      sleep 1
    done
    if emulator_process_group_running || emulator_process_running || emulator_device_is_present_or_unknown; then
      printf '%s\n' 'The issue-owned Android emulator remained active after bounded cleanup.'
      cleanup_status=1
    fi
    return "$cleanup_status"
  } >>"$cleanup_log" 2>&1
}

promote_completion_marker() {
  local completion_text
  [[ -d "$android_artifact_dir" && ! -L "$android_artifact_dir" ]] || return 1
  [[ -f "$provisional_completion_marker" && ! -L "$provisional_completion_marker" ]] || return 1
  test ! -e "$final_completion_marker" || return 1
  test ! -e "$final_completion_temp" || return 1
  completion_text="$(<"$provisional_completion_marker")" || return 1
  test "$completion_text" = "$expected_android_provisional_completion" || return 1
  (
    umask 077
    set -o noclobber
    printf '%s\n' "$expected_android_completion" >"$final_completion_temp"
  ) || return 1
  rm -- "$provisional_completion_marker" || {
    rm -- "$final_completion_temp" || true
    return 1
  }
  mv -- "$final_completion_temp" "$final_completion_marker"
}

on_exit() {
  local suite_status=$?
  local cleanup_status=0
  trap - EXIT INT TERM
  if test "$suite_status" -ne 0; then
    capture_failure_diagnostics
  fi
  if cleanup_emulator; then
    cleanup_status=0
  else
    cleanup_status=$?
  fi
  if test "$suite_status" -ne 0; then
    exit "$suite_status"
  fi
  if test "$cleanup_status" -ne 0; then
    exit "$cleanup_status"
  fi
  promote_completion_marker || fail 'the final completion marker could not be published after emulator cleanup.'
  exit 0
}

on_signal() {
  local signal_status="$1"
  trap - EXIT INT TERM
  capture_failure_diagnostics
  cleanup_emulator || true
  exit "$signal_status"
}

trap on_exit EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

"$setsid_bin" "$emulator_bin" \
  -port "$emulator_port" \
  -avd "$avd_name" \
  -cores 1 \
  -accel on \
  -no-snapshot-save \
  -no-window \
  -gpu swiftshader_indirect \
  -noaudio \
  -no-boot-anim \
  -camera-back none \
  >"$emulator_log" 2>&1 &
emulator_pid=$!
emulator_pgid="$emulator_pid"
printf 'pid=%s\navd=%s\nserial=%s\n' \
  "$emulator_pid" \
  "$avd_name" \
  "$emulator_serial" \
  >"$artifact_dir/android-emulator-owner.txt"
sleep 1
emulator_process_running || fail 'the issue-owned Android emulator exited during launch.'
emulator_process_is_owned || fail 'the launched Android process does not match the exact issue-owned AVD.'
initial_process_group_id="$(ps -o pgid= -p "$emulator_pid" | tr -d '[:space:]')"
test "$initial_process_group_id" = "$emulator_pgid" || fail 'the Android emulator did not enter its issue-owned setsid group.'
emulator_process_group_is_owned || fail 'the Android emulator process group does not retain exact AVD ownership.'

boot_deadline=$((SECONDS + 900))
booted='false'
while test "$SECONDS" -lt "$boot_deadline"; do
  emulator_process_running || fail 'the issue-owned Android emulator exited before boot completed.'
  if boot_state="$("$adb_bin" -s "$emulator_serial" shell getprop sys.boot_completed 2>/dev/null)"; then
    boot_state="${boot_state//$'\r'/}"
    if test "$boot_state" = '1'; then
      booted='true'
      break
    fi
  fi
  sleep 2
done
test "$booted" = 'true' || fail 'the issue-owned Android emulator did not boot within 900 seconds.'

qemu_state="$("$adb_bin" -s "$emulator_serial" shell getprop ro.kernel.qemu)"
api_level="$("$adb_bin" -s "$emulator_serial" shell getprop ro.build.version.sdk)"
qemu_state="${qemu_state//$'\r'/}"
api_level="${api_level//$'\r'/}"
test "$qemu_state" = '1' || fail 'the booted Android device is not an emulator.'
test "$api_level" = '36' || fail 'the booted Android emulator is not API 36.'

"$adb_bin" -s "$emulator_serial" shell input keyevent 82
"$adb_bin" -s "$emulator_serial" shell settings put global window_animation_scale 0.0
"$adb_bin" -s "$emulator_serial" shell settings put global transition_animation_scale 0.0
"$adb_bin" -s "$emulator_serial" shell settings put global animator_duration_scale 0.0
"$adb_bin" -s "$emulator_serial" shell settings put secure show_ime_with_hard_keyboard 0

"$timeout_bin" --signal=TERM --kill-after=30s "$suite_timeout" \
  env ANDROID_SERIAL="$emulator_serial" \
  PSD_EOC_ANDROID_EMULATOR_COMPLETION_DEFERRED='true' \
  "$bun_bin" packages/mobile/e2e/run-ci.ts android
