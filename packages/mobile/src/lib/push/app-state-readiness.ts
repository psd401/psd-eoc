export interface PushAppStateReadinessDecision {
  /** Tracks a real background transition until AuthProvider completes unlock. */
  readonly backgrounded: boolean;
  /** Null means leave the already-closed route gate closed. */
  readonly routeReady: boolean | null;
}

/**
 * Only a true background transition fences token work. iOS uses `inactive`
 * while its own notification permission sheet is visible, and cancelling on
 * that transient state would strand fresh-install registration.
 */
export function shouldFencePushRegistration(nextState: string): boolean {
  return nextState === 'background';
}

/** Auth publishes before React renders; every change closes until layout commits. */
export function authChangeRouteReadiness(): false {
  return false;
}

/** Reopens only from a committed protected-shell render in the active app. */
export function committedAuthRouteReadiness(
  hasCachedShell: boolean,
  appState: string,
): boolean {
  return hasCachedShell && appState === 'active';
}

/**
 * Converts native AppState transitions into fail-closed push-route decisions.
 * A background return never reopens from a stale pre-background auth render;
 * the protected-shell layout effect must observe the fresh unlocked state.
 */
export function decidePushAppStateReadiness(
  wasBackgrounded: boolean,
  nextState: string,
  protectedShellReady: boolean,
): PushAppStateReadinessDecision {
  if (nextState !== 'active') {
    return Object.freeze({
      backgrounded: wasBackgrounded || nextState === 'background',
      routeReady: false,
    });
  }
  return Object.freeze({
    backgrounded: false,
    routeReady: wasBackgrounded ? null : protectedShellReady,
  });
}
