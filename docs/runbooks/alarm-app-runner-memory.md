# Alarm runbook: App Runner memory

**Source-defined CloudWatch alarm name:** `psd-eoc-apprunner-memory-high`.

Current deployment and alarm read-back state lives only in the
[operational readiness register](../INTEGRATIONS.md). A source-defined alarm
name is not deployment evidence.

## Meaning

The `psd-eoc` App Runner service reported `MemoryUtilization` (maximum across
instances) at or above 75% for three consecutive minutes. Missing data is
non-breaching.

An instance at its memory limit is killed and replaced. Requests in flight on
it fail, and the channel workers that call the application's internal routes
fail with it. Memory that stays high after traffic has fallen is the warning:
the next burst ends in that kill.

## Safety posture

- Do not retry a real activation for a user. First establish whether an event
  and delivery intent committed.
- Do not change capacity, image, or configuration outside a reviewed
  deployment, except the redeploy of the current image below.
- If an activation is in progress, prefer letting it finish over replacing
  instances, unless memory is still climbing.

## Respond

1. Record the alarm transition time and the App Runner service name in the
   operations record.
2. In CloudWatch, graph `AWS/AppRunner` `MemoryUtilization` (Maximum),
   `Requests`, and `ActiveInstances` for the last 24 hours. Record whether
   memory rose with a request burst and stayed up after it.
3. In the App Runner service log group, search for `Container exit code` and in
   the application log group for `SIGKILL` to see whether an instance has
   already been killed.
4. If memory is above 85% and no activation is in progress, start a deployment
   of the current image from the App Runner console (**Deploy**). App Runner
   brings up fresh instances before it drains the old ones, so this resets
   memory without an outage.
5. Open an issue with the graphs and the request mix around the rise. Memory
   that rises per request and never falls is a leak to reproduce with a burst
   load test, not a capacity setting to raise.
