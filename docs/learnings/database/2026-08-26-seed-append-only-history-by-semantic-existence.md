---
title: Seed append-only history by semantic existence
category: database
tags: [postgres, bootstrap, seed, append-only, advisory-locks]
severity: high
date: 2026-08-26
source: /lfg
applicable_to: project
---

## What Happened

A production bootstrap failed after migrations because its deterministic
reference seed tried to add an old integration-status baseline to a database
that already held newer live observations under different IDs.

## Root Cause

`ON CONFLICT DO NOTHING` handled only a repeated seed ID. It did not make the
seed idempotent against append-only temporal history, whose monotonic-time
trigger correctly rejected the older observation.

## Solution

Acquire the same per-integration advisory locks used by live writers before
reading history. Create a fixed baseline only when an integration has no
history, and bind a missing disabled channel configuration to the latest
retained observation without rewriting existing truth.

## Prevention

Test every append-only seed twice against both a fresh database and a migrated,
production-shaped database containing newer history. Include a concurrent
writer test whenever the seed makes a read-before-insert decision.
