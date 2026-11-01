---
title: Give every rate-limited test its own address and caller
category: test-failures
tags: [bun-test, rate-limiting, sharding, partner-sign-in, process-state]
severity: medium
date: 2026-11-01
source: /lfg
applicable_to: project
---

## What Happened

Three native partner passkey route tests passed on a development machine and
failed in CI, answering `429` where they expected `401`. The tests were
correct; the shard they landed in was not the shard they had been run in.

## Root Cause

`getPartnerOtpLimiter()` is a process-local map, and its budgets are keyed by
address and by caller. The new test file used the same literal address as the
browser passkey route's tests and named no caller, so a shard that ran both
files had each of them spending the other's budget. Which files share a shard
depends on file size and core count, so the collision appears and disappears
between machines.

## Solution

Every test names an address only it uses, through a per-file counter, and
every request names a caller only it uses. The native emailed-code route's
tests already did this and said why; the new file now follows them.

## Prevention

Any suite that reaches a limiter, a cache or any other module-level state
shared across a shard must key its own fixtures uniquely. Running the suites
that share such state in one `bun test` invocation reproduces a sharded run
locally and is the cheap check before pushing.
