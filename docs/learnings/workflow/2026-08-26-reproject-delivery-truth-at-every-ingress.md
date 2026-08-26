---
title: Reproject delivery truth at every evidence ingress
category: workflow
tags: [delivery-tests, provider-callbacks, projections, database-invariants]
severity: high
date: 2026-08-26
source: /lfg
applicable_to: project
---

## What Happened

Worker writeback finalized delivery-test reports after recording provider evidence, but SES callbacks appended later delivery and bounce evidence without rebuilding the report. Controlled email targets were also accepted by the capability layer while older database and report guards recognized only the SMS singleton case.

## Root Cause

The same domain transition was implemented independently at multiple evidence-ingress and persistence boundaries. Their accepted target shapes and projection side effects drifted apart.

## Solution

Use one terminal-evidence predicate and one evidence-correlated report invocation for worker writeback and provider callbacks. Keep target, outbox, and report singleton rules aligned in one forward migration, with a fresh-database regression that persists each controlled channel from target through provider-accepted report truth.

## Prevention

When adding an evidence source or controlled target mode, enumerate every ingress and database guard that consumes the domain fact. A provider-evidence test is incomplete unless it proves both the append-only evidence row and the resulting report projection.
