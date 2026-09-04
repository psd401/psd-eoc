import type { TemplateMode } from '@psd-eoc/contracts';

/** What the responses admin is currently listing. */
export interface ResponseListFilters {
  /** Null lists both real and drill identities. */
  readonly templateMode: TemplateMode | null;
  /**
   * The `enabled` filter passed to `list-event-types`. Null lists everything,
   * including responses an administrator has retired.
   */
  readonly enabled: boolean | null;
  /** True when retired responses are included in the list. */
  readonly showRetired: boolean;
}

/**
 * Reads the responses admin filters from the query string.
 *
 * A retired response is never deleted, because events stay pinned to the exact
 * version they used, so the list would otherwise grow forever with entries an
 * administrator never wants to choose again. The default therefore shows only
 * what is available for new activations, and `show=all` brings the retired
 * ones back for someone who needs to read or re-enable one.
 */
export function parseResponseListFilters(
  parameters: Readonly<{ mode?: string; show?: string }>,
): ResponseListFilters {
  const templateMode =
    parameters.mode === 'real' || parameters.mode === 'drill'
      ? parameters.mode
      : null;
  const showRetired = parameters.show === 'all';
  return {
    templateMode,
    enabled: showRetired ? null : true,
    showRetired,
  };
}

/** Builds the canonical admin URL for one filter combination. */
export function responseListHref(
  filters: Readonly<{
    templateMode?: TemplateMode | null;
    showRetired: boolean;
  }>,
): string {
  const query = new URLSearchParams();
  if (filters.templateMode != null) query.append('mode', filters.templateMode);
  if (filters.showRetired) query.append('show', 'all');
  const suffix = query.toString();
  return suffix.length === 0
    ? '/event-types/manage'
    : `/event-types/manage?${suffix}`;
}
