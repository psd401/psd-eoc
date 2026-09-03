import type { TemplateMode } from '@psd-eoc/contracts';

import { getEventTheme } from '../../theme/event-theme';
import { ClassifiedActionButton } from './classified-action-button';

export interface ThreatChoiceProps {
  readonly disabled?: boolean;
  readonly mode: TemplateMode;
  readonly name: string;
  readonly onPress: () => void;
  /** True when the operator must describe the threat before continuing. */
  readonly requiresDetail: boolean;
  readonly testID?: string;
}

/** Second tap in the short path; choosing a threat is non-mutating. */
export function ThreatChoice({
  disabled = false,
  mode,
  name,
  onPress,
  requiresDetail,
  testID,
}: ThreatChoiceProps) {
  const theme = getEventTheme(mode);

  return (
    <ClassifiedActionButton
      accessibilityHint={
        requiresDetail
          ? 'Asks you to describe the threat, then shows the responses. No event is started by this choice.'
          : 'Shows the responses for this threat. No event is started and nothing is sent by this choice.'
      }
      accessibilityLabel={`${theme.classificationWord}. Threat ${name}`}
      disabled={disabled}
      mode={mode}
      onPress={onPress}
      title={name}
      {...(requiresDetail ? { detail: 'You will describe it next.' } : {})}
      {...(testID === undefined ? {} : { testID })}
    />
  );
}
