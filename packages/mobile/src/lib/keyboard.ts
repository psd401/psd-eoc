import { useEffect, useState } from 'react';
import {
  Dimensions,
  Keyboard,
  Platform,
  type KeyboardEvent,
} from 'react-native';

/**
 * How far the on-screen keyboard reaches up from the bottom of the window.
 *
 * `KeyboardAvoidingView` measures its own frame relative to its parent and
 * relies on a hand-tuned `keyboardVerticalOffset` for everything above that
 * parent. The event room sits under a native header whose height differs by
 * device, and below whichever banners the app shell is showing, so a fixed
 * offset left the composer under the keyboard. A screen that extends to the
 * bottom of the window only needs the keyboard's own top edge, which the
 * platform reports in window coordinates, so this measures nothing on our
 * side.
 *
 * Android draws edge to edge, so its window no longer shrinks for the
 * keyboard either; both platforms take the same path. iOS reports the
 * keyboard before it animates in, Android only once it is shown.
 */
export function useKeyboardOverlap(): number {
  const [overlap, setOverlap] = useState(0);

  useEffect(() => {
    const update = (event: KeyboardEvent) => {
      const windowHeight = Dimensions.get('window').height;
      setOverlap(Math.max(0, windowHeight - event.endCoordinates.screenY));
    };
    const hide = () => setOverlap(0);
    const subscriptions =
      Platform.OS === 'ios'
        ? [
            Keyboard.addListener('keyboardWillShow', update),
            Keyboard.addListener('keyboardWillChangeFrame', update),
            Keyboard.addListener('keyboardWillHide', hide),
          ]
        : [
            Keyboard.addListener('keyboardDidShow', update),
            Keyboard.addListener('keyboardDidHide', hide),
          ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, []);

  return overlap;
}
