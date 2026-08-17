import { createHash } from 'node:crypto';

import { TimestampSchema } from '@psd-eoc/contracts';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';

import type { GoogleCloudIdentityRosterConfiguration } from '../roster/groups-sync';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_CLOUD_IDENTITY_ENDPOINT =
  'https://cloudidentity.googleapis.com/v1';
const GOOGLE_GROUPS_READONLY_SCOPE =
  'https://www.googleapis.com/auth/cloud-identity.groups.readonly';
const MAX_GOOGLE_RESPONSE_BYTES = 512 * 1024;
const MAX_GROUP_PAGES = 100;
const MAX_EVALUATED_MEMBERS = 1_200;
const PAGE_SIZE = 200;

export const DESIGNATED_ACCESS_GROUP_EMAIL =
  'tsd-engineering@psd401.net' as const;

const GoogleTokenResponseSchema = z
  .object({
    access_token: z.string().trim().min(16).max(8_192),
    expires_in: z.number().int().min(60).max(3_600),
    token_type: z.literal('Bearer'),
    scope: z.literal(GOOGLE_GROUPS_READONLY_SCOPE).optional(),
  })
  .strict()
  .readonly();

const GroupLookupResponseSchema = z
  .object({
    name: z.string().regex(/^groups\/[A-Za-z0-9_-]+$/u),
    groupKey: z
      .object({
        id: z.string().trim().email().max(320),
      })
      .strict()
      .readonly(),
    labels: z.record(z.string(), z.string()),
    dynamicGroupMetadata: z.unknown().optional(),
  })
  .strict()
  .readonly();

const MembershipRoleSchema = z
  .object({
    name: z.enum(['OWNER', 'MANAGER', 'MEMBER']),
    expiryDetail: z
      .object({ expireTime: TimestampSchema })
      .strict()
      .readonly()
      .optional(),
  })
  .strict()
  .readonly();

const DirectMembershipSchema = z
  .object({
    name: z
      .string()
      .regex(/^groups\/[A-Za-z0-9_-]+\/memberships\/[A-Za-z0-9_-]+$/u),
    preferredMemberKey: z
      .object({
        id: z.string().trim().email().max(320),
        namespace: z.string().trim().min(1).max(255).optional(),
      })
      .strict()
      .readonly(),
    roles: z.array(MembershipRoleSchema).min(1).max(3).readonly(),
    type: z.string().trim().min(1).max(64),
  })
  .strict()
  .superRefine((membership, context) => {
    const roles = membership.roles.map(({ name }) => name);
    if (new Set(roles).size !== roles.length) {
      context.addIssue({
        code: 'custom',
        message: 'Cloud Identity membership roles must be unique.',
        path: ['roles'],
      });
    }
  })
  .readonly();

const MembershipPageSchema = z
  .object({
    memberships: z
      .array(DirectMembershipSchema)
      .max(MAX_EVALUATED_MEMBERS)
      .optional(),
    nextPageToken: z.string().trim().min(1).max(2_048).optional(),
  })
  .strict()
  .readonly();

/** Sanitized, non-PII provider/publication failure. */
export class AccessMembershipEvaluationError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'AccessMembershipEvaluationError';
    this.code = z
      .string()
      .regex(/^[A-Z0-9_]+$/u)
      .max(100)
      .parse(code);
  }
}

/** Complete direct-user evaluation of the one product-owner-selected group. */
export interface EvaluatedAccessMembershipSet {
  readonly groupEmail: typeof DESIGNATED_ACCESS_GROUP_EMAIL;
  readonly googleGroupId: string;
  readonly memberEmails: readonly string[];
  readonly membershipDigest: string;
  readonly providerGroupIdDigest: string;
  readonly syncStartedAt: string;
  readonly capturedAt: string;
}

export interface GoogleAccessMembershipEvaluator {
  evaluate(): Promise<EvaluatedAccessMembershipSet>;
}

function stableDigest(parts: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(parts), 'utf8')
    .digest('hex');
}

function trustedTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AccessMembershipEvaluationError(
      'EVALUATION_CLOCK_INVALID',
      'The access-membership evaluation clock is invalid.',
    );
  }
  return TimestampSchema.parse(value.toISOString());
}

async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_GOOGLE_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new AccessMembershipEvaluationError(
      'GOOGLE_RESPONSE_TOO_LARGE',
      'Google returned an oversized access-membership response.',
    );
  }
  if (response.body === null) {
    throw new AccessMembershipEvaluationError(
      'GOOGLE_RESPONSE_INVALID',
      'Google returned an empty access-membership response.',
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () =>
      reject(
        new AccessMembershipEvaluationError(
          'GOOGLE_UNAVAILABLE',
          'Google access-membership evaluation timed out.',
        ),
      );
    signal.addEventListener('abort', abortListener, { once: true });
    if (signal.aborted) abortListener();
  });

  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_GOOGLE_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AccessMembershipEvaluationError(
          'GOOGLE_RESPONSE_TOO_LARGE',
          'Google returned an oversized access-membership response.',
        );
      }
      chunks.push(value);
    }
  } finally {
    if (abortListener !== undefined) {
      signal.removeEventListener('abort', abortListener);
    }
    if (signal.aborted) void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // An aborted read may still hold the lock; cancellation remains closed.
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new AccessMembershipEvaluationError(
      'GOOGLE_RESPONSE_INVALID',
      'Google returned malformed access-membership data.',
    );
  }
}

/**
 * Creates the one exact, non-delegated, read-only access-group evaluator.
 *
 * The evaluator deliberately rejects every non-user direct edge. Therefore a
 * successful first publication has no nested topology for which direct versus
 * transitive product semantics could differ.
 */
export function createGoogleAccessMembershipEvaluator(
  configuration: GoogleCloudIdentityRosterConfiguration,
  options: Readonly<{
    fetch?: typeof fetch;
    now?: () => Date;
  }> = {},
): GoogleAccessMembershipEvaluator {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  async function providerRequest<Result>(
    input: URL | string,
    init: RequestInit,
    operation: string,
    parse: (value: unknown) => Result | null,
  ): Promise<Result> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      configuration.timeoutMilliseconds,
    );
    try {
      const response = await fetchImplementation(input, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new AccessMembershipEvaluationError(
          'GOOGLE_REQUEST_REJECTED',
          `${operation} was rejected by Google.`,
        );
      }
      const result = parse(await boundedJson(response, controller.signal));
      if (result === null) {
        throw new AccessMembershipEvaluationError(
          'GOOGLE_RESPONSE_INVALID',
          `${operation} returned an invalid response.`,
        );
      }
      return result;
    } catch (error) {
      if (error instanceof AccessMembershipEvaluationError) throw error;
      throw new AccessMembershipEvaluationError(
        'GOOGLE_UNAVAILABLE',
        `${operation} was unavailable.`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async function accessToken(): Promise<string> {
    let key: CryptoKey;
    try {
      key = await importPKCS8(configuration.privateKey, 'RS256');
    } catch {
      throw new AccessMembershipEvaluationError(
        'GOOGLE_CONFIGURATION_INVALID',
        'The Google access-membership signing key is invalid.',
      );
    }
    const issuedAt = Math.floor(Date.parse(trustedTimestamp(now)) / 1_000);
    const assertion = await new SignJWT({
      scope: GOOGLE_GROUPS_READONLY_SCOPE,
    })
      .setProtectedHeader({
        alg: 'RS256',
        kid: configuration.privateKeyId,
        typ: 'JWT',
      })
      .setIssuer(configuration.serviceAccountEmail)
      .setAudience(GOOGLE_TOKEN_ENDPOINT)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 300)
      .sign(key);
    return providerRequest(
      GOOGLE_TOKEN_ENDPOINT,
      {
        body: new URLSearchParams({
          assertion,
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      },
      'Google access-token exchange',
      (value) => {
        const parsed = GoogleTokenResponseSchema.safeParse(value);
        return parsed.success ? parsed.data.access_token : null;
      },
    );
  }

  return Object.freeze({
    async evaluate(): Promise<EvaluatedAccessMembershipSet> {
      const syncStartedAt = trustedTimestamp(now);
      const token = await accessToken();
      const authorization = {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      };
      const lookupUrl = new URL(
        `${GOOGLE_CLOUD_IDENTITY_ENDPOINT}/groups:lookup`,
      );
      lookupUrl.searchParams.set(
        'groupKey.id',
        DESIGNATED_ACCESS_GROUP_EMAIL,
      );
      lookupUrl.searchParams.set(
        'fields',
        'name,groupKey(id),labels,dynamicGroupMetadata',
      );
      const group = await providerRequest(
        lookupUrl,
        { headers: authorization, method: 'GET' },
        'Exact Google access-group lookup',
        (value) => {
          const parsed = GroupLookupResponseSchema.safeParse(value);
          return parsed.success ? parsed.data : null;
        },
      );
      const normalizedGroupEmail = group.groupKey.id.toLowerCase();
      if (
        normalizedGroupEmail !== DESIGNATED_ACCESS_GROUP_EMAIL ||
        group.groupKey.id !== group.groupKey.id.trim() ||
        group.dynamicGroupMetadata !== undefined ||
        !Object.hasOwn(
          group.labels,
          'cloudidentity.googleapis.com/groups.discussion_forum',
        )
      ) {
        throw new AccessMembershipEvaluationError(
          'DESIGNATED_GROUP_IDENTITY_INVALID',
          'Google did not resolve the exact static designated access group.',
        );
      }
      const googleGroupId = group.name.slice('groups/'.length);
      const memberEmails = new Set<string>();
      const seenMembershipNames = new Set<string>();
      const seenPageTokens = new Set<string>();
      let pageToken: string | undefined;

      for (let page = 0; page < MAX_GROUP_PAGES; page += 1) {
        const membershipsUrl = new URL(
          `${GOOGLE_CLOUD_IDENTITY_ENDPOINT}/${group.name}/memberships`,
        );
        membershipsUrl.searchParams.set('pageSize', String(PAGE_SIZE));
        membershipsUrl.searchParams.set('view', 'FULL');
        membershipsUrl.searchParams.set(
          'fields',
          'memberships(name,preferredMemberKey(id,namespace),roles(name,expiryDetail(expireTime)),type),nextPageToken',
        );
        if (pageToken !== undefined) {
          membershipsUrl.searchParams.set('pageToken', pageToken);
        }
        const response = await providerRequest(
          membershipsUrl,
          { headers: authorization, method: 'GET' },
          'Direct Google access-membership list',
          (value) => {
            const parsed = MembershipPageSchema.safeParse(value);
            return parsed.success ? parsed.data : null;
          },
        );
        const evaluationTime = Date.parse(trustedTimestamp(now));
        for (const membership of response.memberships ?? []) {
          if (
            membership.type !== 'USER' ||
            membership.preferredMemberKey.namespace !== undefined
          ) {
            throw new AccessMembershipEvaluationError(
              'NESTED_OR_NON_USER_MEMBERSHIP',
              'The designated access group contains a non-user direct edge; membership semantics require product-owner review.',
            );
          }
          if (seenMembershipNames.has(membership.name)) {
            throw new AccessMembershipEvaluationError(
              'DUPLICATE_PROVIDER_MEMBERSHIP',
              'Google repeated one direct access-membership resource.',
            );
          }
          seenMembershipNames.add(membership.name);
          const hasCurrentRole = membership.roles.some(
            ({ expiryDetail }) =>
              expiryDetail === undefined ||
              Date.parse(expiryDetail.expireTime) > evaluationTime,
          );
          if (!hasCurrentRole) continue;
          const email = membership.preferredMemberKey.id.toLowerCase();
          if (memberEmails.has(email)) {
            throw new AccessMembershipEvaluationError(
              'DUPLICATE_EVALUATED_EMAIL',
              'Google returned duplicate normalized access-member identity.',
            );
          }
          memberEmails.add(email);
          if (memberEmails.size > MAX_EVALUATED_MEMBERS) {
            throw new AccessMembershipEvaluationError(
              'GROUP_MEMBER_LIMIT_EXCEEDED',
              'The designated access group exceeds the supported member limit.',
            );
          }
        }

        const nextPageToken = response.nextPageToken;
        if (nextPageToken === undefined) {
          const capturedAt = trustedTimestamp(now);
          const members = Object.freeze([...memberEmails].sort());
          if (members.length === 0) {
            throw new AccessMembershipEvaluationError(
              'DESIGNATED_GROUP_EMPTY',
              'The designated access group has no current direct user members.',
            );
          }
          return Object.freeze({
            groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
            googleGroupId,
            memberEmails: members,
            membershipDigest: stableDigest([
              DESIGNATED_ACCESS_GROUP_EMAIL,
              googleGroupId,
              ...members,
            ]),
            providerGroupIdDigest: stableDigest([googleGroupId]),
            syncStartedAt,
            capturedAt,
          });
        }
        if (
          seenPageTokens.has(nextPageToken) ||
          nextPageToken === pageToken
        ) {
          throw new AccessMembershipEvaluationError(
            'GROUP_PAGINATION_LOOP',
            'Google repeated an access-membership page token.',
          );
        }
        seenPageTokens.add(nextPageToken);
        pageToken = nextPageToken;
      }
      throw new AccessMembershipEvaluationError(
        'GROUP_PAGE_LIMIT_EXCEEDED',
        'The designated access group exceeds the supported page limit.',
      );
    },
  });
}
