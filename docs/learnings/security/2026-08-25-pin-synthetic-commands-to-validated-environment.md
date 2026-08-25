---
title: Pin synthetic commands to a validated environment
category: security
tags: [database, environment, synthetic-fixtures, command-wrappers, fail-closed]
severity: high
date: 2026-08-25
source: /lfg
applicable_to: project
---

## What Happened

Issue #345 initially documented direct migrate, seed, and web commands after generating synthetic `.env.local` files, but inherited `DATABASE_*` variables could still take precedence and redirect those commands to another database.

## Root Cause

Environment-file generation and command execution were separate contracts. Owning a safe file did not prove that the child process would use it.

## Solution

Route the documented commands through one repository wrapper that validates identical generated files and their reserved loopback target, removes the inherited database namespace, and injects only the validated synthetic values. Refuse conflicting ambient configuration before starting Docker and roll back the container when startup finalization fails.

## Prevention

For any documented command that can mutate a database or provider, validate ownership and target constraints at execution time, scrub competing environment variables, and make CI exercise the same wrapper users run.
