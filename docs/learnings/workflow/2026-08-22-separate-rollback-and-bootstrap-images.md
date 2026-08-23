---
title: Separate rollback application images from bootstrap migration images
category: workflow
tags: [deployment, rollback, migrations, ecs, cloudformation, secrets]
severity: high
date: 2026-08-22
source: /lfg
applicable_to: project
---

## What Happened
Issue #339 initially reused the requested rollback application digest for ECS migration and bootstrap work, which could run stale contracts against a forward-only database and break otherwise valid rollbacks.

## Root Cause
The deployment coupled application rollback selection to the database executable, while `NoEcho` was also treated as sufficient protection after copying a sensitive value into a plaintext task environment.

## Solution
Resolve the rollback image separately, run bootstrap with the current reviewed commit image, and validate its bounded result against that image's source SHA before cutting the application over. Parse optional initial-group configuration with one value-redacting validator before build and database connection, and pass the administrator email through a least-privilege Secrets Manager secret.

## Prevention
Keep rollback and migration image contracts independent, never expose `NoEcho` values through plaintext ECS task configuration or logs, and test that inactive existing groups remain unchanged.
