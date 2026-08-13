import type { MobilePushReceivePayload } from '@psd-eoc/contracts';

import {
  parseMobilePushNotification,
  type PushNotificationContent,
} from './notification-content';

export const DEFAULT_NOTIFICATION_ACTION =
  'expo.modules.notifications.actions.DEFAULT' as const;

export interface PushNotificationResponseLike {
  readonly actionIdentifier: string;
  readonly notification: Readonly<{
    request: Readonly<{
      identifier: string;
      content: PushNotificationContent;
    }>;
  }>;
}

export type PushEventNavigator = (payload: MobilePushReceivePayload) => void;
export type PushRouteReadiness = () => boolean;

const MAX_SEEN_RESPONSES = 100;
const MAX_PENDING_RESPONSES = 100;

interface PendingPushRoute {
  readonly payload: MobilePushReceivePayload;
  readonly responseId: string;
}

/**
 * Owns notification-tap routing across foreground, background, and killed
 * launches. Valid taps are deduplicated and retained until the protected app
 * shell is available after device authentication.
 */
export class PushResponseController {
  private routeReady = false;
  private readonly pending: PendingPushRoute[] = [];
  private readonly seenResponseIds = new Set<string>();
  private pendingOverflowed = false;
  private routedNativeEvidencePending = false;

  public constructor(
    private readonly navigate: PushEventNavigator,
    private readonly onPendingRoutesDrained: () => void = () => undefined,
    private readonly isProtectedShellReady: PushRouteReadiness = () => true,
  ) {}

  public setRouteReady(ready: boolean): void {
    this.routeReady = ready;
    if (ready) this.flush();
  }

  private canNavigateNow(): boolean {
    if (!this.routeReady) return false;
    try {
      return this.isProtectedShellReady();
    } catch {
      return false;
    }
  }

  public receive(response: PushNotificationResponseLike): boolean {
    const responseId = response.notification.request.identifier;
    if (
      response.actionIdentifier !== DEFAULT_NOTIFICATION_ACTION ||
      responseId.length === 0 ||
      responseId.length > 500 ||
      this.seenResponseIds.has(responseId)
    ) {
      return false;
    }
    const payload = parseMobilePushNotification(
      response.notification.request.content,
    );
    if (payload === null) return false;
    if (this.pending.length >= MAX_PENDING_RESPONSES) {
      // Leave the native last-response record intact so a fresh process can
      // recover the most recent tap instead of silently discarding it.
      this.pendingOverflowed = true;
      return false;
    }

    this.remember(responseId);
    this.pending.push(Object.freeze({ payload, responseId }));
    if (this.routeReady) this.flush();
    return true;
  }

  public hasPendingRoute(): boolean {
    return this.pending.length > 0;
  }

  private remember(responseId: string): void {
    this.seenResponseIds.add(responseId);
    if (this.seenResponseIds.size <= MAX_SEEN_RESPONSES) return;
    const oldest = this.seenResponseIds.values().next().value as
      | string
      | undefined;
    if (oldest !== undefined) this.seenResponseIds.delete(oldest);
  }

  private flush(): void {
    if (!this.canNavigateNow()) return;
    while (this.canNavigateNow()) {
      const pending = this.pending[0];
      if (pending === undefined) break;
      // Router acceptance alone is not stable consumption. Auth or AppState can
      // synchronously close the protected stack during router.push; that stack
      // then discards the route. Retain the exact target unless readiness still
      // holds after navigation so unlock can replay it. The response ID remains
      // remembered throughout, preventing duplicate native deliveries from
      // adding another pending route.
      try {
        this.navigate(pending.payload);
      } catch {
        break;
      }
      if (!this.canNavigateNow()) break;
      this.pending.shift();
      this.routedNativeEvidencePending = true;
    }
    if (
      this.routedNativeEvidencePending &&
      this.pending.length === 0 &&
      !this.pendingOverflowed &&
      this.canNavigateNow()
    ) {
      try {
        this.onPendingRoutesDrained();
        this.routedNativeEvidencePending = false;
      } catch {
        // Navigation already succeeded. A native-evidence cleanup failure is
        // intentionally non-fatal so the response can replay after restart.
      }
    }
  }
}
