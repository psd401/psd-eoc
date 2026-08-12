import type {
  ActivationPreview,
  Event,
  EventTypeListItem,
  FacilityId,
  TemplateMode,
} from '@psd-eoc/contracts';

export type ActivationPreviewBinding = Readonly<{
  activeEvents: readonly Event[];
  facilityId: FacilityId | null;
  mode: TemplateMode | null;
  preview: ActivationPreview | null;
  selectedType: EventTypeListItem | null;
}>;

function activeEventIdsMatchFacility(
  preview: ActivationPreview,
  activeEvents: readonly Event[],
): boolean {
  const previewIds = new Set(preview.activeEventIds);
  const facilityEvents = activeEvents.filter(
    (event) => event.facilityId === preview.facilityId,
  );
  const facilityEventIds = new Set(facilityEvents.map((event) => event.id));

  return (
    previewIds.size === preview.activeEventIds.length &&
    facilityEventIds.size === facilityEvents.length &&
    facilityEvents.every((event) => event.status === 'active') &&
    facilityEvents.length === preview.activeEventIds.length &&
    preview.activeEventIds.every(
      (eventId) =>
        facilityEventIds.has(eventId) &&
        activeEvents.filter((event) => event.id === eventId).length === 1,
    )
  );
}

/**
 * Returns a preview only while it is bound to the selection visible now.
 *
 * Route parameters and React state can change before an effect clears an old
 * preview. Every caller must therefore derive confirmation UI and submission
 * from this synchronous result instead of trusting the stored preview alone.
 */
export function getBoundActivationPreview(
  binding: ActivationPreviewBinding,
): ActivationPreview | null {
  const { activeEvents, facilityId, mode, preview, selectedType } = binding;
  if (
    facilityId === null ||
    mode === null ||
    preview === null ||
    selectedType === null
  ) {
    return null;
  }

  const { eventType, latestVersion } = selectedType;
  if (
    eventType.templateMode !== mode ||
    latestVersion.eventTypeId !== eventType.id ||
    latestVersion.templateMode !== mode ||
    preview.facilityId !== facilityId ||
    preview.templateMode !== mode ||
    preview.eventTypeVersion.id !== latestVersion.id ||
    preview.eventTypeVersion.templateMode !== mode ||
    !activeEventIdsMatchFacility(preview, activeEvents)
  ) {
    return null;
  }

  return preview;
}
