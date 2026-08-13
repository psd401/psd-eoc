import {
  MobilePushReceivePayloadSchema,
  type MobilePushReceivePayload,
} from '@psd-eoc/contracts';

export interface PushNotificationContent {
  readonly body: string | null;
  readonly data: unknown;
  readonly title: string | null;
}

export interface PushForegroundBehavior {
  readonly shouldPlaySound: boolean;
  readonly shouldSetBadge: boolean;
  readonly shouldShowBanner: boolean;
  readonly shouldShowList: boolean;
}

const DISPLAY_FOREGROUND_NOTIFICATION: PushForegroundBehavior = Object.freeze({
  shouldPlaySound: true,
  shouldSetBadge: false,
  shouldShowBanner: true,
  shouldShowList: true,
});

const SUPPRESS_FOREGROUND_NOTIFICATION: PushForegroundBehavior = Object.freeze({
  shouldPlaySound: false,
  shouldSetBadge: false,
  shouldShowBanner: false,
  shouldShowList: false,
});

/**
 * Parses the canonical data envelope and independently checks the visible
 * classification marker. Notification copy is never used to derive routing,
 * but a mismatched title must fail closed rather than confuse real and drill.
 */
export function parseMobilePushNotification(
  content: PushNotificationContent,
): MobilePushReceivePayload | null {
  const parsed = MobilePushReceivePayloadSchema.safeParse(content.data);
  if (
    !parsed.success ||
    typeof content.title !== 'string' ||
    typeof content.body !== 'string'
  ) {
    return null;
  }
  const expectedMarker =
    parsed.data.templateMode === 'real' ? '[INCIDENT]' : '[DRILL]';
  const oppositeMarker =
    parsed.data.templateMode === 'real' ? '[DRILL]' : '[INCIDENT]';
  if (
    !content.title.startsWith(expectedMarker) ||
    !content.body.startsWith(expectedMarker) ||
    content.title.includes(oppositeMarker) ||
    content.body.includes(oppositeMarker)
  ) {
    return null;
  }
  return parsed.data;
}

/** Foreground delivery is visible only for exact, classification-safe data. */
export function foregroundBehaviorFor(
  content: PushNotificationContent,
): PushForegroundBehavior {
  return parseMobilePushNotification(content) === null
    ? SUPPRESS_FOREGROUND_NOTIFICATION
    : DISPLAY_FOREGROUND_NOTIFICATION;
}
