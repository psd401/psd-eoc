---
title: Serialize browser setup that extends a global audit chain
category: workflow
tags: [playwright, ci, synthetic-fixtures, sessions, audit-chain, concurrency]
severity: medium
date: 2026-08-22
source: /lfg
applicable_to: project
---

## What Happened

Issue #340 initially issued several synthetic browser identities in parallel, producing intermittent CI conflicts before the acceptance flow began.

## Root Cause

Initial session issuance is not an independent fixture insert: sign-in extends the global, append-only security audit chain. Parallel setup manufactured contention at that shared predecessor and tested the harness rather than product concurrency.

## Solution

Issue synthetic identities serially during Playwright setup while keeping the real acceptance actions and assertions unchanged. Preserve failure traces separately from committed visual evidence so routine CI runs remain diagnostic without modifying the worktree.

## Prevention

Before parallelizing fixture setup, identify writes that share an ordered journal, sequence, cursor, or singleton lock. Serialize those setup writes instead of weakening database isolation, audit ordering, or retry guarantees.
