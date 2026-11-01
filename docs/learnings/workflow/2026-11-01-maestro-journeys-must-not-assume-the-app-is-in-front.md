---
title: A Maestro journey must not assume the app is still in front
category: workflow
tags: [maestro, mobile-e2e, ios-simulator, android-emulator, flakiness]
severity: medium
date: 2026-11-01
source: /lfg
applicable_to: project
---

## What Happened

Two of seven iOS runs of the native partner journey failed a flow at its
first assertion, with the simulator showing its home screen. The harness's
own screenshot between the two flows showed the home screen too, which is
what identified it: the app had not crashed, it had been left in the
background.

## Root Cause

Each flow in a journey is a separate `maestro test` invocation, and ending a
session can return the device to its home screen. Any flow that continues
from the screen the previous one left — and the passkey offer is held in the
app's memory, so it must — reads the springboard instead.

## Solution

Each flow after the sign-in brings the app forward with `launchApp` and
`stopApp: false`, guarded by `runFlow: when: notVisible:` on something the
previous flow left on screen. The guard is the part that matters: Android
kept the app in front, and relaunching it there ended the device session, so
an unconditional launch failed the other platform for the opposite reason.

## Prevention

A journey split across flows should state at the top of each flow what it
expects to be looking at, and bring the app forward only when it is not. On
the iOS simulator and the Android emulator the same construct has to behave
differently, so run both before calling a flow stable, and run each twice.

Two host facts found alongside this: Maestro 2.8.0's XCUITest driver does not
start against an iOS 27 simulator on this machine and does against iOS 26.5
(pin one with `PSD_EOC_IOS_UDID`), and the Android emulator needs
`-no-metrics -no-window` to start headless, because its crash-consent dialog
otherwise blocks the boot.
