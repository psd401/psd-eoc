import type { TemplateMode } from '@psd-eoc/contracts';

import { getEventTheme } from '../../theme/event-theme';
import { ClassifiedActionButton } from './classified-action-button';

export interface EventTypeChoiceProps {
  readonly description?: string | null;
  readonly disabled?: boolean;
  readonly mode: TemplateMode;
  readonly name: string;
  readonly onPress: () => void;
  readonly testID?: string;
}

/** Second tap in the short path; choosing a type remains non-mutating. */
export function EventTypeChoice({
  description,
  disabled = false,
  mode,
  name,
  onPress,
  testID,
}: EventTypeChoiceProps) {
  const theme = getEventTheme(mode);

  return (
    <ClassifiedActionButton
      accessibilityHint="Opens a current consequence preview. No event is started and nothing is queued by this choice."
      accessibilityLabel={`${theme.classificationWord}. Choose ${name}`}
      disabled={disabled}
      mode={mode}
      onPress={onPress}
      title={name}
      {...(description == null ? {} : { detail: description })}
      {...(testID === undefined ? {} : { testID })}
    />
  );
}
