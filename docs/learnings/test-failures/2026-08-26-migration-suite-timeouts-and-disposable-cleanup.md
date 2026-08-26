---
title: Budget migration suites and make database cleanup independent
category: test-failures
tags: [bun-test, postgres, database-cleanup, timeouts, parallel-tests]
severity: medium
date: 2026-08-26
source: /lfg
applicable_to: project
---

## What Happened

The full Bun gate timed out two migration-heavy bootstrap suites at the default five-second hook limit, although they passed together in isolation in 4.72 seconds. One suite also leaked its disposable database, and sequential cleanup could skip the drop after a failed close.

## Root Cause

Full-shard migration load consumed the narrow default hook budget, while teardown treated connection close and database drop as one dependent sequence.

## Solution

Match adjacent database suites with `setDefaultTimeout(30_000)`. Use `closeAndDropDisposableDatabase` from `packages/server/lib/testing/database.ts` so both cleanup operations run and one or aggregate errors remain visible.

## Prevention

Give migration suites the repository-standard lifecycle timeout, use `createDisposableDatabase`, and test teardown failure paths so a rejected close cannot prevent the owned database from being dropped.
