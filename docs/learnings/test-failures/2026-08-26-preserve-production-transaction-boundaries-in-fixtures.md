---
title: Preserve production transaction boundaries in database fixtures
category: test-failures
tags:
  [postgres, integration-tests, transactions, immutable-fixtures, diagnostics]
severity: medium
date: 2026-08-26
source: /lfg
applicable_to: project
---

## What Happened

A journal test intermittently returned `PERSISTENCE_CONFLICT` only under six-way shard load. Retaining the unknown failure as an internal `Error.cause` exposed invalid publication ordering; the corrected test passed 20 of 20 stress runs instead of 0 of 20.

## Root Cause

A 1,200-line rollback-only outer transaction turned production store transactions into nested savepoints and accidentally kept a complete roster snapshot with its immutable children in one transaction, hiding that the fixture otherwise published them separately. The engine also discarded the raw exception while producing its safe public error.

## Solution

In `journal.database.test.ts`, let production stores own top-level transactions, create the snapshot and children atomically in one small fixture transaction, and restore shared channel configuration from the start of mutation. In `engine.ts`, retain the raw value as non-enumerable `Error.cause` while keeping public serialization bounded.

## Prevention

Make integration fixtures match production transaction and immutable-publication boundaries. Avoid giant rollback wrappers, and preserve non-serialized internal causes when mapping unknown failures to safe public errors.
