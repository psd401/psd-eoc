import type { EventId, TemplateMode } from '@psd-eoc/contracts';

import { getEventTheme } from '../../theme/event-theme';
import { ClassifiedActionButton } from './classified-action-button';

export interface ActiveEventJoinActionProps {
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly eventId: EventId;
  readonly eventTypeName: string;
  readonly facilityName: string;
  readonly mode: TemplateMode;
  readonly onPress: () => void;
  readonly startedLabel: string;
  readonly testID?: string;
}

/** Explicit join choice; this action never implies a new activation or fan-out. */
export function ActiveEventJoinAction({
  busy = false,
  disabled = false,
  eventId,
  eventTypeName,
  facilityName,
  mode,
  onPress,
  startedLabel,
  testID,
}: ActiveEventJoinActionProps) {
  const theme = getEventTheme(mode);

  return (
    <ClassifiedActionButton
      accessibilityHint="Joins this active event. Joining does not create another event or notification intent."
      accessibilityLabel={`Join existing ${theme.classificationWord}: ${eventTypeName} at ${facilityName}. Started ${startedLabel}. Event ID ${eventId}`}
      busy={busy}
      detail={`${facilityName} · Started ${startedLabel} · Event ID ${eventId}`}
      disabled={disabled}
      mode={mode}
      onPress={onPress}
      title={busy ? `Joining ${eventTypeName} once…` : `Join ${eventTypeName}`}
      {...(testID === undefined ? {} : { testID })}
    />
  );
}
