import type { TemplateMode } from '@psd-eoc/contracts';

import { ClassifiedActionButton } from './classified-action-button';

export interface StartModeActionProps {
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly facilityName: string;
  readonly mode: TemplateMode;
  readonly onPress: () => void;
  readonly testID?: string;
}

/** First tap in the one-site flow: site and immutable mode are chosen together. */
export function StartModeAction({
  busy = false,
  disabled = false,
  facilityName,
  mode,
  onPress,
  testID,
}: StartModeActionProps) {
  const real = mode === 'real';
  const title = real ? 'Start real incident' : 'Run practice drill';

  return (
    <ClassifiedActionButton
      accessibilityHint="Opens event type choices. This choice does not start an event or notify anyone."
      accessibilityLabel={`${real ? 'REAL INCIDENT' : 'DRILL — PRACTICE'}. ${title} at ${facilityName}`}
      busy={busy}
      detail={facilityName}
      disabled={disabled}
      emphasis="primary"
      mode={mode}
      onPress={onPress}
      title={title}
      {...(testID === undefined ? {} : { testID })}
    />
  );
}
