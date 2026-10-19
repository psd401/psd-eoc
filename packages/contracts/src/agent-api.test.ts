import { describe, expect, test } from 'bun:test';

import { AgentApiKeySummarySchema, IssueAgentApiKeyInputSchema } from './index';

const MAX_EXPIRY_SECONDS = 366 * 24 * 60 * 60;

const IDS = Object.freeze({
  key: '00000000-0000-4000-8000-000000000801',
  agent: '00000000-0000-4000-8000-000000000802',
  issuer: '00000000-0000-4000-8000-000000000803',
});

function issueInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    agentId: null,
    displayName: 'Synthetic bounded-expiry agent',
    facilityScope: { kind: 'district' },
    capabilityIds: ['get-event'],
    expiresInSeconds: 7_776_000,
    ...overrides,
  };
}

describe('agent API-key issuance expiry', () => {
  test('requires a bounded lifetime', () => {
    expect(IssueAgentApiKeyInputSchema.safeParse(issueInput()).success).toBe(
      true,
    );
    expect(
      IssueAgentApiKeyInputSchema.safeParse(
        issueInput({ expiresInSeconds: MAX_EXPIRY_SECONDS }),
      ).success,
    ).toBe(true);
    expect(
      IssueAgentApiKeyInputSchema.safeParse(issueInput({ expiresInSeconds: 1 }))
        .success,
    ).toBe(true);
  });

  test('refuses a null, missing, zero, fractional, or over-long lifetime', () => {
    const withoutExpiry = Object.fromEntries(
      Object.entries(issueInput()).filter(
        ([key]) => key !== 'expiresInSeconds',
      ),
    );
    const rejected: readonly unknown[] = [
      issueInput({ expiresInSeconds: null }),
      issueInput({ expiresInSeconds: undefined }),
      withoutExpiry,
      issueInput({ expiresInSeconds: 0 }),
      issueInput({ expiresInSeconds: -1 }),
      issueInput({ expiresInSeconds: 1.5 }),
      issueInput({ expiresInSeconds: MAX_EXPIRY_SECONDS + 1 }),
      issueInput({ expiresInSeconds: '7776000' }),
    ];
    for (const input of rejected) {
      const result = IssueAgentApiKeyInputSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some(
            (issue) => issue.path[0] === 'expiresInSeconds',
          ),
        ).toBe(true);
      }
    }
  });

  test('keeps a retained key summary without an expiry readable', () => {
    expect(
      AgentApiKeySummarySchema.safeParse({
        id: IDS.key,
        agentId: IDS.agent,
        displayName: 'Key retained from before expiry became mandatory',
        facilityScope: { kind: 'district' },
        capabilityIds: ['get-event'],
        keyPrefix: 'abcdefghijkl',
        issuedByUserId: IDS.issuer,
        issuedAt: '2026-08-10T18:00:00.000Z',
        expiresAt: null,
        revokedAt: null,
      }).success,
    ).toBe(true);
  });
});
