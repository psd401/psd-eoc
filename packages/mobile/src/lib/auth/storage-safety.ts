/**
 * Removes the enrollment marker first, but still attempts vault removal when
 * either native deletion fails. This prevents a recoverable partial clear from
 * making the next launch treat a retained bearer as enrolled.
 */
export async function clearMarkerThenVault(
  deleteMarker: () => Promise<void>,
  deleteVault: () => Promise<void>,
): Promise<void> {
  let deletionError: unknown;
  try {
    await deleteMarker();
  } catch (error) {
    deletionError = error;
  }
  try {
    await deleteVault();
  } catch (error) {
    deletionError ??= error;
  }
  if (deletionError !== undefined) {
    throw deletionError;
  }
}
