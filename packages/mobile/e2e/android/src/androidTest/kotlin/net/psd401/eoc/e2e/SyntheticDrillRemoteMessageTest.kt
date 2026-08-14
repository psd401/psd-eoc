package net.psd401.eoc.e2e

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.os.SystemClock
import android.service.notification.StatusBarNotification
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.delegates.FirebaseMessagingDelegate
import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Provider-free notification presentation proof for issue #32.
 *
 * The test runs inside the installed PSD EOC application process and invokes
 * Expo Notifications' actual FirebaseMessagingDelegate with an in-memory
 * RemoteMessage. It never obtains a token, opens a socket, or contacts FCM,
 * Expo, or another provider.
 */
@RunWith(AndroidJUnit4::class)
class SyntheticDrillRemoteMessageTest {
  @Test
  fun presentsCanonicalSyntheticDrillThroughInstalledExpoDelegate() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val targetContext = instrumentation.targetContext.applicationContext
    val arguments = InstrumentationRegistry.getArguments()

    assertEquals(TARGET_APPLICATION_ID, targetContext.packageName)
    assertEquals(
      "Instrumentation must execute in the target PSD EOC process.",
      TARGET_APPLICATION_ID,
      currentProcessName(),
    )

    val runId = requiredArgument(arguments.getString(ARG_RUN_ID), ARG_RUN_ID)
    require(RUN_ID.matches(runId)) {
      "$ARG_RUN_ID must be exactly 32 lowercase hexadecimal characters."
    }
    val responseId =
      requiredArgument(arguments.getString(ARG_RESPONSE_ID), ARG_RESPONSE_ID)
    require(responseId == "issue-32-$runId") {
      "$ARG_RESPONSE_ID must be issue-32- followed by the exact $ARG_RUN_ID."
    }
    val unlockResponseId = "$responseId-unlock"
    val routeResponseId = "$responseId-route"
    assertFalse(unlockResponseId == routeResponseId)

    val eventId = requiredUuidArgument(arguments.getString(ARG_EVENT_ID), ARG_EVENT_ID)
    val facilityId =
      requiredUuidArgument(arguments.getString(ARG_FACILITY_ID), ARG_FACILITY_ID)
    val eventTypeVersionId =
      requiredUuidArgument(
        arguments.getString(ARG_EVENT_TYPE_VERSION_ID),
        ARG_EVENT_TYPE_VERSION_ID,
      )
    requireExactArgument(arguments.getString(ARG_EVENT_KIND), ARG_EVENT_KIND, EVENT_KIND)
    requireExactArgument(
      arguments.getString(ARG_TEMPLATE_MODE),
      ARG_TEMPLATE_MODE,
      TEMPLATE_MODE,
    )
    requireExactArgument(arguments.getString(ARG_PURPOSE), ARG_PURPOSE, PURPOSE)

    assertTrue(VISIBLE_TITLE.startsWith(DRILL_MARKER))
    assertTrue(VISIBLE_BODY.startsWith(DRILL_MARKER))
    assertTrue(UNLOCK_TITLE.startsWith(DRILL_MARKER))
    assertTrue(UNLOCK_BODY.startsWith(DRILL_MARKER))
    assertFalse(VISIBLE_TITLE.contains(INCIDENT_MARKER))
    assertFalse(VISIBLE_BODY.contains(INCIDENT_MARKER))
    assertFalse(UNLOCK_TITLE.contains(INCIDENT_MARKER))
    assertFalse(UNLOCK_BODY.contains(INCIDENT_MARKER))

    val systemNotificationManager =
      targetContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    assertTrue(
      "PSD EOC notification permission must be granted before injection.",
      systemNotificationManager.areNotificationsEnabled(),
    )
    val configuredChannel =
      requireNotNull(systemNotificationManager.getNotificationChannel(ALERT_CHANNEL_ID)) {
        "PSD EOC must create $ALERT_CHANNEL_ID before injection."
      }
    assertEquals(ALERT_CHANNEL_ID, configuredChannel.id)
    assertTrue(
      "$ALERT_CHANNEL_ID must remain a high-importance alert channel.",
      configuredChannel.importance >= NotificationManager.IMPORTANCE_HIGH,
    )

    assertTrue(
      "Use a fresh issue #32 runId; the unlock-check notification already exists.",
      notificationsWithTag(systemNotificationManager, unlockResponseId).isEmpty(),
    )
    assertTrue(
      "Use a fresh issue #32 runId; the route notification already exists.",
      notificationsWithTag(systemNotificationManager, routeResponseId).isEmpty(),
    )

    val canonicalData =
      JSONObject()
        .put("version", PAYLOAD_VERSION)
        .put("eventId", eventId)
        .put("eventKind", EVENT_KIND)
        .put("templateMode", TEMPLATE_MODE)
        .put("facilityId", facilityId)
        .put("eventTypeVersionId", eventTypeVersionId)
        .put("purpose", PURPOSE)

    val installedDelegate = FirebaseMessagingDelegate(targetContext)
    presentNotification(
      installedDelegate,
      routeResponseId,
      VISIBLE_TITLE,
      VISIBLE_BODY,
      canonicalData,
    )
    presentNotification(
      installedDelegate,
      unlockResponseId,
      UNLOCK_TITLE,
      UNLOCK_BODY,
      null,
    )

    val presentedUnlock =
      awaitExactNotification(systemNotificationManager, unlockResponseId)
    assertPresentedNotification(
      targetContext,
      presentedUnlock,
      unlockResponseId,
      UNLOCK_TITLE,
      UNLOCK_BODY,
      null,
    )
    val presentedRoute =
      awaitExactNotification(systemNotificationManager, routeResponseId)
    assertPresentedNotification(
      targetContext,
      presentedRoute,
      routeResponseId,
      VISIBLE_TITLE,
      VISIBLE_BODY,
      canonicalData,
    )

    val activeAppTags =
      systemNotificationManager.activeNotifications
        .filter { notification -> notification.packageName == TARGET_APPLICATION_ID }
        .mapNotNull { notification -> notification.tag }
        .toSet()
    assertTrue(activeAppTags.contains(unlockResponseId))
    assertTrue(activeAppTags.contains(routeResponseId))
  }

  private fun presentNotification(
    delegate: FirebaseMessagingDelegate,
    responseId: String,
    title: String,
    message: String,
    canonicalData: JSONObject?,
  ) {
    val remoteMessageBuilder =
      RemoteMessage.Builder(LOCAL_ONLY_DESTINATION)
        .setMessageId(responseId)
        .setTtl(LOCAL_TTL_SECONDS)
        .addData("title", title)
        .addData("message", message)
        .addData("channelId", ALERT_CHANNEL_ID)
        .addData("categoryId", DRILL_CATEGORY_ID)
        .addData("tag", responseId)
        .addData("sound", "default")
        .addData("vibrate", "true")
    if (canonicalData != null) {
      remoteMessageBuilder.addData("body", canonicalData.toString())
    }
    val remoteMessage = remoteMessageBuilder.build()

    // This is the installed Expo native receive path. No FirebaseMessaging
    // client, Expo API, token, provider credential, or network transport exists
    // in this harness.
    delegate.onMessageReceived(remoteMessage)
  }

  private fun assertPresentedNotification(
    context: Context,
    presented: StatusBarNotification,
    expectedTag: String,
    expectedTitle: String,
    expectedBody: String,
    expectedData: JSONObject?,
  ) {
    assertEquals(TARGET_APPLICATION_ID, presented.packageName)
    assertEquals(TARGET_APPLICATION_ID, presented.opPkg)
    assertEquals(expectedTag, presented.tag)
    assertEquals(EXPO_FOREIGN_NOTIFICATION_ID, presented.id)

    val notification = presented.notification
    assertEquals(ALERT_CHANNEL_ID, notification.channelId)
    assertEquals(
      expectedTitle,
      notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString(),
    )
    assertEquals(
      expectedBody,
      notification.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString(),
    )
    val embeddedData = notification.extras.getString(EXPO_DATA_BODY_EXTRA)
    if (expectedData == null) {
      assertFalse(
        "The unlock-only notification must not carry a canonical route envelope.",
        notification.extras.containsKey(EXPO_DATA_BODY_EXTRA),
      )
      assertEquals(null, embeddedData)
    } else {
      requireNotNull(embeddedData) {
        "Expo must preserve the canonical push data JSON in notification extras."
      }
      val actualData = JSONObject(embeddedData)
      assertEquals(expectedData.length(), actualData.length())
      expectedData.keys().forEach { key ->
        assertEquals("Canonical data mismatch at $key.", expectedData.get(key), actualData.get(key))
      }
    }

    val contentIntent =
      requireNotNull(notification.contentIntent) {
        "Presented notification must have an app-owned tap intent."
      }
    assertEquals(TARGET_APPLICATION_ID, contentIntent.creatorPackage)
    assertEquals(context.applicationInfo.uid, contentIntent.creatorUid)
    assertTrue("The notification tap intent must launch an app activity.", contentIntent.isActivity)
  }

  private fun awaitExactNotification(
    manager: NotificationManager,
    expectedTag: String,
  ): StatusBarNotification {
    val deadline = SystemClock.elapsedRealtime() + PRESENTATION_TIMEOUT_MILLIS
    while (SystemClock.elapsedRealtime() < deadline) {
      val matches = notificationsWithTag(manager, expectedTag)
      if (matches.size > 1) {
        fail("Expo presented more than one notification with tag $expectedTag.")
      }
      matches.singleOrNull()?.let { return it }
      SystemClock.sleep(POLL_INTERVAL_MILLIS)
    }
    fail(
      "Expo did not present the exact synthetic drill notification within ${PRESENTATION_TIMEOUT_MILLIS}ms.",
    )
    throw AssertionError("unreachable")
  }

  private fun notificationsWithTag(
    manager: NotificationManager,
    tag: String,
  ): List<StatusBarNotification> =
    manager.activeNotifications.filter { notification -> notification.tag == tag }

  private fun currentProcessName(): String {
    val bytes = File("/proc/self/cmdline").readBytes()
    val terminator = bytes.indexOf(0)
    val end = if (terminator >= 0) terminator else bytes.size
    return bytes.copyOfRange(0, end).toString(Charsets.UTF_8)
  }

  private fun requiredArgument(value: String?, name: String): String {
    require(!value.isNullOrBlank()) { "$name is required." }
    return value
  }

  private fun requiredUuidArgument(value: String?, name: String): String {
    val required = requiredArgument(value, name)
    require(LOWERCASE_UUID.matches(required)) {
      "$name must be a canonical lowercase UUID."
    }
    require(required != NIL_UUID) { "$name cannot be the nil UUID." }
    return required
  }

  private fun requireExactArgument(value: String?, name: String, expected: String) {
    require(value == expected) { "$name must be exactly $expected." }
  }

  private companion object {
    const val TARGET_APPLICATION_ID = "net.psd401.eoc"
    const val ALERT_CHANNEL_ID = "eoc-alerts"
    const val DRILL_CATEGORY_ID = "PSD_EOC_DRILL"
    const val EXPO_DATA_BODY_EXTRA = "body"
    const val EXPO_FOREIGN_NOTIFICATION_ID = 0
    const val PAYLOAD_VERSION = 1
    const val EVENT_KIND = "drill"
    const val TEMPLATE_MODE = "drill"
    const val PURPOSE = "activation"
    const val DRILL_MARKER = "[DRILL]"
    const val INCIDENT_MARKER = "[INCIDENT]"
    const val UNLOCK_TITLE = "[DRILL] Unlock PSD EOC for synthetic drill"
    const val UNLOCK_BODY =
      "[DRILL] Synthetic exercise only. Unlock the app before opening the retained drill route."
    const val VISIBLE_TITLE = "[DRILL] Synthetic lockdown drill"
    const val VISIBLE_BODY =
      "[DRILL] Synthetic exercise only. Open the synthetic event room."
    const val LOCAL_ONLY_DESTINATION = "issue-32-local@synthetic.invalid"
    const val LOCAL_TTL_SECONDS = 60
    const val PRESENTATION_TIMEOUT_MILLIS = 15_000L
    const val POLL_INTERVAL_MILLIS = 100L
    const val NIL_UUID = "00000000-0000-0000-0000-000000000000"

    const val ARG_RUN_ID = "runId"
    const val ARG_RESPONSE_ID = "responseId"
    const val ARG_EVENT_ID = "eventId"
    const val ARG_EVENT_KIND = "eventKind"
    const val ARG_TEMPLATE_MODE = "templateMode"
    const val ARG_FACILITY_ID = "facilityId"
    const val ARG_EVENT_TYPE_VERSION_ID = "eventTypeVersionId"
    const val ARG_PURPOSE = "purpose"

    val RUN_ID = Regex("^[0-9a-f]{32}$")
    val LOWERCASE_UUID =
      Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
  }
}
