---
title: Treat runtime pause as quiescence, not queued-work suppression
category: security
tags: [emergency-stop, queues, retention, reconciliation, fail-closed]
severity: high
date: 2026-08-25
source: /lfg
applicable_to: project
---

## What Happened

Issue #34 replaced obsolete control-epoch runbook claims with an operational stop that pauses serving, routing, and provider-capable consumers.

## Root Cause

Pausing a runtime prevents new consumption but does not suppress outbox rows or queue messages, stop retention clocks, or resolve in-flight provider outcomes.

## Solution

Pause provider consumers before routing and admission, establish a read-only quiescence fence, and reconcile every retained or unknown item before its retention deadline and before resumption.

## Prevention

For every asynchronous emergency stop, test admission, routing, provider I/O, in-flight outcomes, and queued-work retention separately; never describe paused work as disabled or terminally suppressed.
