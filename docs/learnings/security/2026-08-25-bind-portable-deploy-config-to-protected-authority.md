---
title: Bind portable deployment configuration to an independent production authority
category: security
tags: [deployment, configuration, ci, cloud, fail-closed, multi-tenant]
severity: high
date: 2026-08-25
source: /lfg
applicable_to: project
---

## What Happened

Making the infrastructure configuration portable briefly turned a fixed production deployment boundary into a comparison between values read from the same repository configuration.

## Root Cause

The requested deployment target and the supposed approved target shared one trust source. Comparing them proved internal consistency, not authorization to change production.

## Solution

Keep clone and synthesis inputs portable, but allow production writes only from a direct, locally authenticated `cdk deploy`. Before synthesis or mutation, compare the selected account, region, application origin, and provider identity with the locally supplied deployment target and fail closed on a mismatch. Never add an automatic production entrypoint.

## Prevention

Test that every protected-identity mismatch fails closed, keep alternate-tenant synthesis outside deployment mode, and never describe a self-comparison as a production authorization boundary.
