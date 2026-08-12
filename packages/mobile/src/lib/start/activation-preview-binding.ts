import type {
  ActivationPreview,
  EventTypeListItem,
  FacilityId,
  TemplateMode,
} from '@psd-eoc/contracts';

export type ActivationPreviewBinding = Readonly<{
  facilityId: FacilityId | null;
  mode: TemplateMode | null;
  preview: ActivationPreview | null;
  selectedType: EventTypeListItem | null;
}>;

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
  const { facilityId, mode, preview, selectedType } = binding;
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
    preview.eventTypeVersion.templateMode !== mode
  ) {
    return null;
  }

  return preview;
}
