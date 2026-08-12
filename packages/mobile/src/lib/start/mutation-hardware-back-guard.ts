import { useEffect } from 'react';
import { BackHandler } from 'react-native';

import {
  subscribeToStartMutationHardwareBack,
  type IsStartMutationPending,
  type StartMutationAnnounce,
} from './mutation-navigation-guard';

/** Consumes Android Back at the root screen while a result is pending. */
export function useStartMutationHardwareBackGuard(
  isPending: IsStartMutationPending,
  announce: StartMutationAnnounce,
): void {
  useEffect(
    () =>
      subscribeToStartMutationHardwareBack(
        isPending,
        announce,
        (eventName, handler) =>
          BackHandler.addEventListener(eventName, handler),
      ),
    [announce, isPending],
  );
}
