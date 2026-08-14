import { describe, expect, test } from 'bun:test';

const directory = new URL('.', import.meta.url);

async function source(name: string): Promise<string> {
  return Bun.file(new URL(name, directory)).text();
}

describe('issue #32 Android provider-free notification injector', () => {
  test('pins generated Expo native versions and attaches only androidTest source', async () => {
    const initScript = await source('issue-32.init.gradle');

    expect(initScript).toContain("expo: '57.0.12'");
    expect(initScript).toContain("notifications: '57.0.10'");
    expect(initScript).toContain("reactNative: '0.86.2'");
    expect(initScript).toContain(
      "new File(mobileRoot, 'e2e/android/src/androidTest/kotlin')",
    );
    expect(initScript).toContain("project.path != ':app'");
    expect(initScript).not.toContain('implementation(');
  });

  test('rejects unsafe classification before invoking the installed delegate', async () => {
    const kotlin = await source(
      'src/androidTest/kotlin/net/psd401/eoc/e2e/SyntheticDrillRemoteMessageTest.kt',
    );
    const delegateInvocation = kotlin.indexOf(
      'delegate.onMessageReceived(remoteMessage)',
    );

    expect(delegateInvocation).toBeGreaterThan(0);
    for (const guard of [
      'RUN_ID.matches(runId)',
      'responseId == "issue-32-$runId"',
      'requiredUuidArgument(arguments.getString(ARG_EVENT_ID)',
      'ARG_EVENT_KIND, EVENT_KIND',
      'ARG_TEMPLATE_MODE,',
      'ARG_PURPOSE, PURPOSE',
      'VISIBLE_TITLE.contains(INCIDENT_MARKER)',
      'VISIBLE_BODY.contains(INCIDENT_MARKER)',
      'UNLOCK_TITLE.contains(INCIDENT_MARKER)',
      'UNLOCK_BODY.contains(INCIDENT_MARKER)',
    ]) {
      expect(kotlin.indexOf(guard)).toBeGreaterThanOrEqual(0);
      expect(kotlin.indexOf(guard)).toBeLessThan(delegateInvocation);
    }
  });

  test('uses no live provider client and proves the app-owned notification', async () => {
    const kotlin = await source(
      'src/androidTest/kotlin/net/psd401/eoc/e2e/SyntheticDrillRemoteMessageTest.kt',
    );

    for (const forbidden of [
      'FirebaseMessaging.getInstance',
      'getExpoPushToken',
      'ExponentPushToken',
      'https://',
      'http://',
      'Socket(',
      'URL(',
    ]) {
      expect(kotlin).not.toContain(forbidden);
    }
    for (const proof of [
      'const val UNLOCK_TITLE = "[DRILL] Unlock PSD EOC for synthetic drill"',
      'const val VISIBLE_TITLE = "[DRILL] Synthetic lockdown drill"',
      'assertEquals(TARGET_APPLICATION_ID, presented.packageName)',
      'assertEquals(ALERT_CHANNEL_ID, notification.channelId)',
      'assertEquals(expectedTag, presented.tag)',
      'assertEquals(TARGET_APPLICATION_ID, contentIntent.creatorPackage)',
      'assertEquals(context.applicationInfo.uid, contentIntent.creatorUid)',
      'contentIntent.isActivity',
    ]) {
      expect(kotlin).toContain(proof);
    }
  });

  test('presents distinct unlock and route notifications with identical canonical drill data', async () => {
    const kotlin = await source(
      'src/androidTest/kotlin/net/psd401/eoc/e2e/SyntheticDrillRemoteMessageTest.kt',
    );

    for (const proof of [
      'val unlockResponseId = "$responseId-unlock"',
      'val routeResponseId = "$responseId-route"',
      'assertFalse(unlockResponseId == routeResponseId)',
      'unlockResponseId,\n      UNLOCK_TITLE,\n      UNLOCK_BODY,\n      canonicalData,',
      'routeResponseId,\n      VISIBLE_TITLE,\n      VISIBLE_BODY,\n      canonicalData,',
      '.setMessageId(responseId)',
      '.addData("tag", responseId)',
      'activeAppTags.contains(unlockResponseId)',
      'activeAppTags.contains(routeResponseId)',
    ]) {
      expect(kotlin).toContain(proof);
    }

    expect(kotlin.match(/presentNotification\(/gu)).toHaveLength(3);
    expect(kotlin.match(/assertPresentedNotification\(/gu)).toHaveLength(3);
  });

  test('drives unlock and retained route through separate exact notification taps', async () => {
    const [preAuth, postAuth] = await Promise.all([
      source('../flows/notification-event-room-android-pre-auth.yaml'),
      source('../flows/notification-event-room-android-post-auth.yaml'),
    ]);

    expect(preAuth).toContain(
      "tapOn: '\\[DRILL\\] Unlock PSD EOC for synthetic drill'",
    );
    expect(preAuth).toContain(
      "assertVisible: '\\[DRILL\\] Synthetic lockdown drill'",
    );
    expect(postAuth).toContain("tapOn: '\\[DRILL\\] Synthetic lockdown drill'");
    expect(postAuth).toContain('file: shared/assert-active-drill-room.yaml');
    expect(preAuth).not.toContain(
      "tapOn: '\\[DRILL\\] Synthetic lockdown drill'",
    );
  });
});
