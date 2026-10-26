import {
  EmailEndpointSchema,
  PushEndpointSchema,
  SmsEndpointSchema,
  type DispatchBatch,
  type EmailEndpoint,
  type EndpointStatus,
  type NotificationChannel,
  type PushEndpoint,
  type PushProviderCutover,
  type SmsEndpoint,
} from '@psd-eoc/contracts';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';

import { databaseExecuteRows, type DatabaseQuery } from '../../db/client';
import {
  deviceEnrollments,
  devicePushTokenRegistrations,
  devicePushTokenUnregistrations,
  endpointStatusRecords,
  partnerAdmissionEndings,
  partnerAdmissions,
  partnerEndpoints,
  staffSmsConsents,
  users,
} from '../../db/schema';
import { fannedOutPushEndpoints } from '../capabilities/devices';
import { loadSmsPhoneOptOuts } from '../notify/sms-policy';
import {
  PUSH_PROVIDER_CUTOVER_ENV,
  parsePushProviderCutover,
} from '../push-provider-cutover';
import { loadEventPartnerAudience } from './audience';

/**
 * Send-time delivery to the partners a live incident pinned (#597).
 *
 * A partner slice's batches name no roster recipient. Their audience is the
 * admission set the event's activation preview pinned, read through
 * `loadEventPartnerAudience`, so an all-clear or reactivation reaches exactly
 * who the activation reached. Where each partner is reached is resolved here,
 * when the batch is sent: the admission's own address, the partner's own live
 * push registrations, and the partner's own live SMS consent. Each becomes a
 * `partner_endpoints` row the first time it is used, and attempts bind to it
 * (migration 0063).
 *
 * Every resolution returns two lists, like the roster path. `candidates` is
 * the stable order a worker pages through: the pinned admissions, and for push
 * and SMS the registrations and consents that existed when the batch was
 * created. `endpoints` is who may be sent to now: an admission ended or
 * expired since activation, a registration unregistered or a device handed to
 * another account (#498), a withdrawn consent, a disabled account, a
 * suppressed address, an opted-out number, or an invalidated endpoint each
 * drop out here without moving any later candidate.
 */

export type PartnerDeliveryErrorCode =
  | 'PARTNER_BATCH_INVALID'
  | 'PARTNER_AUDIENCE_MISMATCH'
  | 'PARTNER_ENDPOINT_UNAVAILABLE';

/** Terminal: retrying cannot change a pinned audience or a batch's plan. */
export class PartnerDeliveryError extends Error {
  public constructor(public readonly code: PartnerDeliveryErrorCode) {
    super('Partner delivery could not be resolved safely.');
    this.name = 'PartnerDeliveryError';
  }
}

/** One stable paging position: a partner and the endpoint that reaches it. */
export interface PartnerCandidate {
  readonly recipientId: string;
  readonly endpointId: string;
}

export interface PartnerResolution<
  Item extends EmailEndpoint | PushEndpoint | SmsEndpoint,
> {
  readonly candidates: readonly PartnerCandidate[];
  readonly endpoints: readonly Readonly<{
    recipientId: string;
    endpoint: Item;
  }>[];
}

interface PinnedPartner {
  readonly admissionId: string;
  readonly email: string;
  /** Still admitted at the moment of sending: not ended, not expired. */
  readonly admitted: boolean;
}

/** The database clock, so liveness is judged by the clock expiry uses. */
export async function readDatabaseClock(
  database: DatabaseQuery,
): Promise<Date> {
  const [row] = databaseExecuteRows<{ value: Date | string }>(
    await database.execute(sql`select clock_timestamp() as value`),
  );
  const value = row === undefined ? null : new Date(row.value);
  if (value === null || !Number.isFinite(value.getTime())) {
    // Transient, unlike every PartnerDeliveryError: the next try may read it.
    throw new Error('The database clock is unavailable.');
  }
  return value;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function candidateKey(value: PartnerCandidate): string {
  return `${value.recipientId}:${value.endpointId}`;
}

function assertPartnerBatch(
  batch: DispatchBatch,
  channel: NotificationChannel,
): void {
  if (
    batch.rosterPopulation !== 'partner' ||
    batch.channel !== channel ||
    batch.eventKind !== 'incident' ||
    batch.templateMode !== 'real'
  ) {
    throw new PartnerDeliveryError('PARTNER_BATCH_INVALID');
  }
}

/** The event's pinned partners, in admission order, with current liveness. */
async function loadPinnedPartners(
  database: DatabaseQuery,
  batch: DispatchBatch,
  now: Date,
): Promise<readonly PinnedPartner[]> {
  const admissionIds = await loadEventPartnerAudience(database, batch.eventId);
  if (admissionIds.length === 0) return [];
  const rows = await database
    .select({
      admissionId: partnerAdmissions.id,
      email: partnerAdmissions.email,
      expiresAt: partnerAdmissions.expiresAt,
      endingId: partnerAdmissionEndings.id,
    })
    .from(partnerAdmissions)
    .leftJoin(
      partnerAdmissionEndings,
      eq(partnerAdmissionEndings.partnerAdmissionId, partnerAdmissions.id),
    )
    .where(inArray(partnerAdmissions.id, [...admissionIds]))
    .orderBy(asc(partnerAdmissions.id));
  if (rows.length !== admissionIds.length) {
    throw new PartnerDeliveryError('PARTNER_AUDIENCE_MISMATCH');
  }
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        admissionId: row.admissionId,
        email: row.email,
        admitted:
          row.endingId === null &&
          new Date(row.expiresAt).getTime() > now.getTime(),
      }),
    ),
  );
}

/** Latest lifecycle fact per partner endpoint; absent means never recorded. */
async function latestPartnerEndpointStatuses(
  database: DatabaseQuery,
  channel: NotificationChannel,
  endpointIds: readonly string[],
): Promise<ReadonlyMap<string, EndpointStatus>> {
  if (endpointIds.length === 0) return new Map();
  const rows = await database
    .selectDistinctOn([endpointStatusRecords.endpointId], {
      endpointId: endpointStatusRecords.endpointId,
      status: endpointStatusRecords.status,
    })
    .from(endpointStatusRecords)
    .where(
      and(
        eq(endpointStatusRecords.population, 'partner'),
        eq(endpointStatusRecords.channel, channel),
        inArray(endpointStatusRecords.partnerEndpointId, [...endpointIds]),
      ),
    )
    .orderBy(
      endpointStatusRecords.endpointId,
      desc(endpointStatusRecords.recordedAt),
      desc(endpointStatusRecords.sequence),
    );
  return new Map(rows.map((row) => [row.endpointId, row.status]));
}

type PartnerEndpointRow = Readonly<{
  id: string;
  partnerAdmissionId: string;
  sourceId: string | null;
  createdAt: Date;
}>;

/**
 * Records where each partner is reached, once, and returns those rows keyed
 * by admission and source. A row is a fact about reachability and is never
 * changed (append-only trigger), so a concurrent first send simply finds the
 * row the other one wrote. The owner trigger refuses a registration or
 * consent that is not the admitted person's own.
 */
async function ensurePartnerEndpoints(
  database: DatabaseQuery,
  channel: NotificationChannel,
  bindings: readonly Readonly<{
    admissionId: string;
    sourceId: string | null;
  }>[],
): Promise<ReadonlyMap<string, PartnerEndpointRow>> {
  if (bindings.length === 0) return new Map();
  await database
    .insert(partnerEndpoints)
    .values(
      bindings.map((binding) => ({
        partnerAdmissionId: binding.admissionId,
        channel,
        pushRegistrationId: channel === 'push' ? binding.sourceId : null,
        smsConsentId: channel === 'sms' ? binding.sourceId : null,
      })),
    )
    .onConflictDoNothing();
  const admissionIds = [
    ...new Set(bindings.map((binding) => binding.admissionId)),
  ];
  const sourceColumn =
    channel === 'push'
      ? partnerEndpoints.pushRegistrationId
      : partnerEndpoints.smsConsentId;
  const rows = await database
    .select({
      id: partnerEndpoints.id,
      partnerAdmissionId: partnerEndpoints.partnerAdmissionId,
      sourceId: channel === 'email' ? sql<null>`null` : sourceColumn,
      createdAt: partnerEndpoints.createdAt,
    })
    .from(partnerEndpoints)
    .where(
      and(
        eq(partnerEndpoints.channel, channel),
        inArray(partnerEndpoints.partnerAdmissionId, admissionIds),
      ),
    );
  const byBinding = new Map(
    rows.map((row) => [`${row.partnerAdmissionId}:${row.sourceId}`, row]),
  );
  const resolved = new Map<string, PartnerEndpointRow>();
  for (const binding of bindings) {
    const key = `${binding.admissionId}:${binding.sourceId}`;
    const row = byBinding.get(key);
    if (row === undefined) {
      throw new PartnerDeliveryError('PARTNER_ENDPOINT_UNAVAILABLE');
    }
    resolved.set(key, row);
  }
  return resolved;
}

/**
 * Email to each pinned partner at the address it was admitted under.
 *
 * The batch planned one email per pinned partner, so the candidates must be
 * exactly that many. Suppression is keyed by address, as for staff, and reads
 * only partner facts: a bounce or complaint on partner mail never touches a
 * staff address, and the staff query reads only roster endpoints.
 */
export async function resolvePartnerEmailEndpoints(
  database: DatabaseQuery,
  batch: DispatchBatch,
  now: Date,
): Promise<PartnerResolution<EmailEndpoint>> {
  assertPartnerBatch(batch, 'email');
  const partners = await loadPinnedPartners(database, batch, now);
  if (partners.length !== batch.endpointCount) {
    throw new PartnerDeliveryError('PARTNER_AUDIENCE_MISMATCH');
  }
  if (partners.length === 0) {
    return Object.freeze({ candidates: [], endpoints: [] });
  }
  const rows = await ensurePartnerEndpoints(
    database,
    'email',
    partners.map((partner) => ({
      admissionId: partner.admissionId,
      sourceId: null,
    })),
  );
  const suppressedRows = await database
    .selectDistinct({ email: partnerAdmissions.email })
    .from(endpointStatusRecords)
    .innerJoin(
      partnerEndpoints,
      eq(partnerEndpoints.id, endpointStatusRecords.partnerEndpointId),
    )
    .innerJoin(
      partnerAdmissions,
      eq(partnerAdmissions.id, partnerEndpoints.partnerAdmissionId),
    )
    .where(
      and(
        eq(endpointStatusRecords.population, 'partner'),
        eq(endpointStatusRecords.channel, 'email'),
        inArray(endpointStatusRecords.status, ['invalid', 'disabled']),
        inArray(
          partnerAdmissions.email,
          partners.map((partner) => partner.email),
        ),
      ),
    );
  const suppressed = new Set(suppressedRows.map((row) => row.email));
  const candidates: PartnerCandidate[] = [];
  const endpoints: { recipientId: string; endpoint: EmailEndpoint }[] = [];
  for (const partner of partners) {
    const row = rows.get(`${partner.admissionId}:null`);
    if (row === undefined) {
      throw new PartnerDeliveryError('PARTNER_ENDPOINT_UNAVAILABLE');
    }
    const candidate = Object.freeze({
      recipientId: partner.admissionId,
      endpointId: row.id,
    });
    candidates.push(candidate);
    if (!partner.admitted || suppressed.has(partner.email)) continue;
    endpoints.push(
      Object.freeze({
        recipientId: partner.admissionId,
        endpoint: EmailEndpointSchema.parse({
          id: row.id,
          status: 'active',
          capturedAt: iso(row.createdAt),
          channel: 'email',
          email: partner.email,
        }),
      }),
    );
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    endpoints: Object.freeze(endpoints),
  });
}

/**
 * Push to each pinned partner's own devices: one endpoint per device, chosen
 * by the same rule that fans staff out to devices the roster never saw.
 *
 * Candidates are the partner's registrations as of the batch's creation, so
 * every page of one batch sees the same list. A device is reachable now only
 * while the admission is live, the account is not disabled, the enrollment is
 * not revoked, the registration is not unregistered, and nothing has
 * invalidated the endpoint. Shared-device re-enrollment (#498) unregisters the
 * previous account's registrations, so a handed-on phone drops out here.
 */
export async function resolvePartnerPushEndpoints(
  database: DatabaseQuery,
  batch: DispatchBatch,
  now: Date,
  cutover: PushProviderCutover | null = parsePushProviderCutover(
    process.env[PUSH_PROVIDER_CUTOVER_ENV],
  ),
): Promise<PartnerResolution<PushEndpoint>> {
  assertPartnerBatch(batch, 'push');
  const partners = await loadPinnedPartners(database, batch, now);
  if (partners.length === 0) {
    return Object.freeze({ candidates: [], endpoints: [] });
  }
  const asOf = new Date(batch.createdAt);
  const registrationRows = await database
    .select({
      admissionId: partnerAdmissions.id,
      id: devicePushTokenRegistrations.id,
      deviceEnrollmentId: devicePushTokenRegistrations.deviceEnrollmentId,
      platform: devicePushTokenRegistrations.platform,
      provider: devicePushTokenRegistrations.provider,
      serviceEnvironment: devicePushTokenRegistrations.serviceEnvironment,
      token: devicePushTokenRegistrations.token,
      unregisteredAt: devicePushTokenUnregistrations.unregisteredAt,
    })
    .from(partnerAdmissions)
    // A partner account is the admitted address under a non-Google issuer;
    // the owner trigger on partner_endpoints applies the same rule.
    .innerJoin(
      users,
      and(
        eq(users.email, partnerAdmissions.email),
        isNull(users.googleSubject),
      ),
    )
    .innerJoin(deviceEnrollments, eq(deviceEnrollments.userId, users.id))
    .innerJoin(
      devicePushTokenRegistrations,
      eq(devicePushTokenRegistrations.deviceEnrollmentId, deviceEnrollments.id),
    )
    .leftJoin(
      devicePushTokenUnregistrations,
      and(
        eq(
          devicePushTokenUnregistrations.registrationId,
          devicePushTokenRegistrations.id,
        ),
        eq(
          devicePushTokenUnregistrations.deviceEnrollmentId,
          devicePushTokenRegistrations.deviceEnrollmentId,
        ),
      ),
    )
    .where(
      and(
        inArray(
          partnerAdmissions.id,
          partners.map((partner) => partner.admissionId),
        ),
        isNull(users.disabledAt),
        isNull(deviceEnrollments.revokedAt),
        lte(devicePushTokenRegistrations.registeredAt, asOf),
        or(
          isNull(devicePushTokenUnregistrations.id),
          gt(devicePushTokenUnregistrations.unregisteredAt, asOf),
        ),
        isNotNull(devicePushTokenRegistrations.applicationId),
        isNotNull(devicePushTokenRegistrations.applicationVersion),
        isNotNull(devicePushTokenRegistrations.nativeBuildVersion),
        isNotNull(devicePushTokenRegistrations.expoProjectId),
        eq(devicePushTokenRegistrations.updateMode, 'embedded-only'),
      ),
    )
    // Newest first, so the device's newest install on the selected provider
    // is the one chosen.
    .orderBy(
      asc(partnerAdmissions.id),
      desc(devicePushTokenRegistrations.registeredAt),
      desc(devicePushTokenRegistrations.id),
    );
  const unregisteredAt = new Map(
    registrationRows.map((row) => [row.id, row.unregisteredAt]),
  );
  const selected = partners.flatMap((partner) =>
    fannedOutPushEndpoints(
      [],
      registrationRows.filter((row) => row.admissionId === partner.admissionId),
      new Map(),
      batch.createdAt,
      cutover,
    ).map((endpoint) => Object.freeze({ partner, endpoint })),
  );
  const rows = await ensurePartnerEndpoints(
    database,
    'push',
    selected.map(({ partner, endpoint }) => ({
      admissionId: partner.admissionId,
      sourceId: endpoint.id,
    })),
  );
  const statuses = await latestPartnerEndpointStatuses(
    database,
    'push',
    [...rows.values()].map((row) => row.id),
  );
  const candidates: PartnerCandidate[] = [];
  const endpoints: { recipientId: string; endpoint: PushEndpoint }[] = [];
  for (const { partner, endpoint } of selected) {
    const row = rows.get(`${partner.admissionId}:${endpoint.id}`);
    if (row === undefined) {
      throw new PartnerDeliveryError('PARTNER_ENDPOINT_UNAVAILABLE');
    }
    candidates.push(
      Object.freeze({ recipientId: partner.admissionId, endpointId: row.id }),
    );
    const unregistered = unregisteredAt.get(endpoint.id) ?? null;
    if (
      !partner.admitted ||
      (unregistered !== null &&
        new Date(unregistered).getTime() <= now.getTime()) ||
      (statuses.get(row.id) ?? 'active') !== 'active'
    ) {
      continue;
    }
    endpoints.push(
      Object.freeze({
        recipientId: partner.admissionId,
        endpoint: PushEndpointSchema.parse({
          ...endpoint,
          id: row.id,
          capturedAt: iso(row.createdAt),
        }),
      }),
    );
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    endpoints: Object.freeze(endpoints),
  });
}

/**
 * Text to each pinned partner's own consented number.
 *
 * Candidates are the consents live when the batch was created; a consent
 * withdrawn since, a number opted out with the provider, an ended or expired
 * admission, or a disabled account is not sent to.
 */
export async function resolvePartnerSmsEndpoints(
  database: DatabaseQuery,
  batch: DispatchBatch,
  now: Date,
): Promise<PartnerResolution<SmsEndpoint>> {
  assertPartnerBatch(batch, 'sms');
  const partners = await loadPinnedPartners(database, batch, now);
  if (partners.length === 0) {
    return Object.freeze({ candidates: [], endpoints: [] });
  }
  const asOf = new Date(batch.createdAt);
  const consentRows = await database
    .select({
      admissionId: partnerAdmissions.id,
      id: staffSmsConsents.id,
      phoneNumber: staffSmsConsents.phoneNumber,
      withdrawnAt: staffSmsConsents.withdrawnAt,
    })
    .from(partnerAdmissions)
    .innerJoin(
      users,
      and(
        eq(users.email, partnerAdmissions.email),
        isNull(users.googleSubject),
      ),
    )
    .innerJoin(staffSmsConsents, eq(staffSmsConsents.userId, users.id))
    .where(
      and(
        inArray(
          partnerAdmissions.id,
          partners.map((partner) => partner.admissionId),
        ),
        isNull(users.disabledAt),
        lte(staffSmsConsents.consentedAt, asOf),
        or(
          isNull(staffSmsConsents.withdrawnAt),
          gt(staffSmsConsents.withdrawnAt, asOf),
        ),
      ),
    )
    .orderBy(
      asc(partnerAdmissions.id),
      desc(staffSmsConsents.consentedAt),
      desc(staffSmsConsents.id),
    );
  const rows = await ensurePartnerEndpoints(
    database,
    'sms',
    consentRows.map((consent) => ({
      admissionId: consent.admissionId,
      sourceId: consent.id,
    })),
  );
  const statuses = await latestPartnerEndpointStatuses(
    database,
    'sms',
    [...rows.values()].map((row) => row.id),
  );
  const optedOut = await loadSmsPhoneOptOuts(database, [
    ...new Set(consentRows.map((consent) => consent.phoneNumber)),
  ]);
  const admitted = new Map(
    partners.map((partner) => [partner.admissionId, partner.admitted]),
  );
  const candidates: PartnerCandidate[] = [];
  const endpoints: { recipientId: string; endpoint: SmsEndpoint }[] = [];
  for (const consent of consentRows) {
    const row = rows.get(`${consent.admissionId}:${consent.id}`);
    if (row === undefined) {
      throw new PartnerDeliveryError('PARTNER_ENDPOINT_UNAVAILABLE');
    }
    candidates.push(
      Object.freeze({ recipientId: consent.admissionId, endpointId: row.id }),
    );
    if (
      admitted.get(consent.admissionId) !== true ||
      (consent.withdrawnAt !== null &&
        new Date(consent.withdrawnAt).getTime() <= now.getTime()) ||
      optedOut.get(consent.phoneNumber) === true ||
      (statuses.get(row.id) ?? 'active') !== 'active'
    ) {
      continue;
    }
    endpoints.push(
      Object.freeze({
        recipientId: consent.admissionId,
        endpoint: SmsEndpointSchema.parse({
          id: row.id,
          status: 'active',
          capturedAt: iso(row.createdAt),
          channel: 'sms',
          phoneNumber: consent.phoneNumber,
        }),
      }),
    );
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    endpoints: Object.freeze(endpoints),
  });
}

/** The eligible endpoints of one page of candidates, in candidate order. */
export function partnerPage<
  Item extends EmailEndpoint | PushEndpoint | SmsEndpoint,
>(
  resolution: PartnerResolution<Item>,
  cursor: number,
  limit: number,
): Readonly<{
  page: readonly PartnerCandidate[];
  endpoints: PartnerResolution<Item>['endpoints'];
  nextCursor: number | null;
}> {
  if (cursor > resolution.candidates.length) {
    throw new PartnerDeliveryError('PARTNER_BATCH_INVALID');
  }
  const page = resolution.candidates.slice(cursor, cursor + limit);
  const eligible = new Map(
    resolution.endpoints.map((item) => [
      candidateKey({
        recipientId: item.recipientId,
        endpointId: item.endpoint.id,
      }),
      item,
    ]),
  );
  return Object.freeze({
    page,
    endpoints: Object.freeze(
      page.flatMap((candidate) => {
        const item = eligible.get(candidateKey(candidate));
        return item === undefined ? [] : [item];
      }),
    ),
    nextCursor:
      cursor + page.length < resolution.candidates.length
        ? cursor + page.length
        : null,
  });
}
