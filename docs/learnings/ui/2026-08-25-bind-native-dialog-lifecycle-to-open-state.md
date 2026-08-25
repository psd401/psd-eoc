---
title: Bind native dialog lifecycle to open state
category: ui
tags: [html-dialog, react-effects, playwright, accessibility, race-condition]
severity: medium
date: 2026-08-25
source: /lfg
applicable_to: project
---

## What Happened

Issue #344 passed local browser checks, but production Playwright hit `InvalidStateError` when axe temporarily closed an all-clear dialog while its asynchronous preview updated.

## Root Cause

The effect that called `showModal()` depended on the entire dialog payload. Preview content changes reran modal lifecycle work and could reopen the native dialog during a tooling- or browser-driven temporary closure.

## Solution

In `event-room-command-controller.ts`, make `showModal()` and `close()` depend only on `dialog !== null`. Use a separate payload-dependent effect for autofocus so async preview updates can move focus without reopening the modal.

## Prevention

Separate native dialog lifecycle from content and focus effects, and verify asynchronous dialog transitions under production Playwright timing; local development timing may not expose this race.
