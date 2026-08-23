---
title: Enforce driver-error redaction at the dependency boundary
category: security
tags: [driver-errors, redaction, drizzle, dependency-boundary, bootstrap, regression-testing]
severity: high
date: 2026-08-22
source: /lfg
applicable_to: project
---

## What Happened
Issue #332 replaced per-step driver-error reduction with a dynamic decorator in `createBootstrapDependencies` and centralized leak sentinels in the test fixtures.

## Root Cause
Manual opt-in inside individual bootstrap steps allowed a new or overlooked dependency method to leak SQL or parameters from Drizzle-wrapped driver failures.

## Solution
`packages/server/scripts/operations/bootstrap.ts` now structurally wraps every code-defined method on the completed dependency object while preserving ordinary errors and executor-authored diagnostics.

## Prevention
Use `wrappedDriverFailureFixture` to reproduce the production Drizzle wrapper, exercise `bootstrapDistrict`, assert every sentinel is absent, and keep a deliberately unwrapped method test that proves omission would leak.
