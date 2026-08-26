---
title: Move release orchestration into the deployment graph
category: workflow
tags: [deployment, cdk, cloudformation, ecr, bootstrap, rollback]
severity: high
date: 2026-08-26
source: /lfg
applicable_to: project
---

## What Happened

Removing the repository deployment workflow exposed hidden build, publish, bootstrap, promotion, and rollback steps that a direct `cdk deploy` did not yet own.

## Root Cause

The deployment transport also acted as the release orchestrator, so deleting it left correctness dependent on undocumented manual sequencing.

## Solution

Make one direct CDK command own a secret-excluding image asset from clean Git HEAD, resolve its immutable digest, wait on a bounded CloudFormation bootstrap resource, and make every promoted runtime depend on that barrier. Keep rollback application selection separate, immutable, and provenance-validated while bootstrap remains on current source.

## Prevention

When replacing deployment transport, enumerate every lifecycle guarantee it supplied and encode each one in the infrastructure dependency graph. Reject any design that still requires separate build, push, migration, or promotion commands.
