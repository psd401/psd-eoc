import { usePreventRemove } from 'expo-router/react-navigation';

export const PENDING_START_MUTATION_MESSAGE =
  'PSD EOC is waiting for the server outcome. Stay on this screen. Nothing will retry automatically.';

export type StartMutationAnnounce = (message: string) => void;
export type IsStartMutationPending = () => boolean;
type HardwareBackSubscription = (
  eventName: 'hardwareBackPress',
  handler: () => boolean,
) => { readonly remove: () => void };

function announcePendingMutation(announce: StartMutationAnnounce): void {
  try {
    announce(PENDING_START_MUTATION_MESSAGE);
  } catch {
    // Accessibility feedback must never weaken the navigation guard.
  }
}

export function isStartMutationPending(pendingAction: string | null): boolean {
  return pendingAction !== null;
}

export function subscribeToStartMutationHardwareBack(
  isPending: IsStartMutationPending,
  announce: StartMutationAnnounce,
  subscribe: HardwareBackSubscription,
): () => void {
  const subscription = subscribe('hardwareBackPress', () => {
    if (!isPending()) return false;
    announcePendingMutation(announce);
    return true;
  });
  return () => {
    subscription.remove();
  };
}

/**
 * Prevents native stack removal while an activation or join outcome is
 * pending. The prevented action is deliberately never redispatched.
 */
export function useStartMutationNavigationGuard(
  pending: boolean,
  announce: StartMutationAnnounce,
): void {
  usePreventRemove(pending, () => {
    announcePendingMutation(announce);
  });
}

/** Same-tick guard for explicit navigation before React rerenders. */
export function requestStartRouteNavigation(
  pending: boolean,
  navigate: () => void,
  announce: StartMutationAnnounce,
): boolean {
  if (pending) {
    announcePendingMutation(announce);
    return false;
  }
  navigate();
  return true;
}
