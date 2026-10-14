import {
  EventTypeIdSchema,
  FacilityIdSchema,
  PaginationCursorSchema,
  type Facility,
} from '@psd-eoc/contracts';

import { addCalendarDays, parsePacificDateRange } from './date-range';

/**
 * The site-filter value that stands for every site the viewer is authorized
 * for. It is a reserved query value, never a facility identifier, because
 * facility identifiers are UUIDs.
 */
export const ALL_AUTHORIZED_SITES = 'all';

export interface RecordsFilters {
  /** One authorized site, or null for every site in the viewer's scope. */
  readonly facilityId: string | null;
  readonly from: string;
  readonly through: string;
  readonly eventTypeId: string | null;
  readonly cursor: string | null;
}

export type RawSearchParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export class RecordsFilterError extends Error {
  public constructor(message = 'Check the selected records filters.') {
    super(message);
    this.name = 'RecordsFilterError';
  }
}

function optionalSingle(
  parameters: RawSearchParams,
  name: string,
  allowEmpty = false,
): string | null {
  const value = parameters[name];
  if (Array.isArray(value)) {
    throw new RecordsFilterError();
  }
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || (value.length === 0 && !allowEmpty)) {
    throw new RecordsFilterError();
  }
  return value.length === 0 ? null : value;
}

/**
 * Which site the viewer lands on before they choose one.
 *
 * Every site they are authorized for, whenever their scope holds more than
 * one: district staff and anyone placed at several schools arrive at their
 * whole authorized history rather than at whichever site happens to sort
 * first. One authorized site defaults straight to it.
 */
export function defaultRecordsFacilityId(
  facilities: readonly Facility[],
): string | null {
  return facilities.length === 1 ? (facilities[0]?.id ?? null) : null;
}

/**
 * Whether every returned record belongs to a site this page may show.
 *
 * One selected site admits that site alone; every authorized site admits
 * exactly the sites this viewer's scope listed. Either way a row from
 * anywhere else is a leak, and the page refuses to render it.
 */
export function recordsStayInAdmittedSites(
  records: readonly Readonly<{ facilityId: string }>[],
  selectedFacilityId: string | null,
  authorizedFacilities: readonly Facility[],
): boolean {
  const admitted = new Set(
    selectedFacilityId === null
      ? authorizedFacilities.map((facility) => facility.id)
      : [selectedFacilityId],
  );
  return records.every((record) => admitted.has(record.facilityId));
}

/** The dates, site, and response the viewer asked for, bounded and parsed. */
export function parseRecordsFilters(
  parameters: RawSearchParams,
  defaultFacilityId: string | null,
  today: string,
): Readonly<{
  filters: RecordsFilters;
  range: ReturnType<typeof parsePacificDateRange>;
}> {
  const allowed = new Set([
    'facilityId',
    'from',
    'through',
    'eventTypeId',
    'cursor',
  ]);
  if (Object.keys(parameters).some((name) => !allowed.has(name))) {
    throw new RecordsFilterError();
  }

  // An absent site and the explicit `all` both mean the scope's default:
  // every authorized site (null, "no site filter", which the records query
  // answers inside the authenticated facility scope) when more than one is
  // authorized, and the one site itself otherwise, so a single-site viewer
  // following an `all` link sees their site selected rather than an option
  // their menu never offers.
  const facilityValue = optionalSingle(parameters, 'facilityId');
  const facilityId =
    facilityValue === null || facilityValue === ALL_AUTHORIZED_SITES
      ? defaultFacilityId
      : FacilityIdSchema.parse(facilityValue);
  const from =
    optionalSingle(parameters, 'from') ?? addCalendarDays(today, -30);
  const through = optionalSingle(parameters, 'through') ?? today;
  const eventTypeValue = optionalSingle(parameters, 'eventTypeId', true);
  const eventTypeId =
    eventTypeValue === null ? null : EventTypeIdSchema.parse(eventTypeValue);
  const cursorValue = optionalSingle(parameters, 'cursor');
  const cursor =
    cursorValue === null ? null : PaginationCursorSchema.parse(cursorValue);
  const range = parsePacificDateRange(from, through);
  if (through > today) {
    throw new RecordsFilterError('The through date cannot be in the future.');
  }

  return Object.freeze({
    filters: Object.freeze({
      facilityId,
      from,
      through,
      eventTypeId,
      cursor,
    }),
    range,
  });
}
