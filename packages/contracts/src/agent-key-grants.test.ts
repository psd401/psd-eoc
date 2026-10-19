import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  AgentApiKeySchema,
  AgentCapabilityGrantSchema,
  IssueAgentApiKeyInputSchema,
} from './agent-api';
import {
  AGENT_KEY_GRANTABLE_CAPABILITY_IDS,
  AgentKeyGrantableCapabilityIdSchema,
  isAgentKeyGrantableCapabilityId,
} from './agent-key-grants';
import {
  AGENT_GRANTABLE_CAPABILITY_IDS,
  CAPABILITY_CATALOG,
  isAgentGrantableCapabilityId,
} from './capability-catalog';
import { HUMAN_ONLY_ACTION_IDS } from './human-only';

/** The written allowlist, repeated here so a silent edit cannot pass. */
const EXPECTED_ALLOWLIST = [
  'prepare-activation',
  'start-event',
  'all-clear-event',
  'close-event',
  'create-event-type-draft',
  'update-event-type-draft',
  'create-activation-preview',
  'create-lifecycle-consequence-preview',
  'get-prepared-activation',
  'get-stale-roster-report',
  'list-active-events',
  'get-event',
  'list-journal-entries',
  'search-journal-entries',
  'list-event-types',
  'get-event-type-version',
  'get-event-type-draft',
  'preview-event-type-rendering',
  'list-facilities',
  'list-threats',
  'get-facility',
  'list-agent-api-keys',
  'list-drill-records',
  'export-drill-records',
  'export-event-summary',
  'query-security-audit',
  'verify-security-audit-chain',
] as const;

/**
 * Deployed capabilities the catalog admits for an agent principal but no key
 * may be granted: publication, live-journal writes, and lifecycle re-entry.
 */
const WITHHELD_DEPLOYED_IDS = [
  'publish-event-type-version',
  'append-journal-entry',
  'correct-journal-entry',
  'redact-journal-entry',
  'reopen-as-correction',
  'join-event',
  'reactivate-event',
] as const;

/** Catalog agent capabilities that never had a deployed agent handler. */
const WITHHELD_UNDEPLOYED_IDS = [
  'set-manual-roster-members',
  'set-channel-enabled',
  'set-user-facility-scope',
  'create-facility',
  'update-facility',
  'create-group-source',
  'update-group-source',
  'create-neighborhood-version',
  'sync-roster',
  'list-users',
  'get-media-read-grant',
  'get-roster-snapshot',
  'get-notification-status',
  'run-delivery-report',
  'get-integration-health',
  'list-group-sources',
  'get-roster-health',
  'create-media-upload-intent',
  'complete-media-upload',
  'list-neighborhoods',
  'list-neighborhood-versions',
  'get-neighborhood-version',
] as const;

const IDS = Object.freeze({
  key: '00000000-0000-4000-8000-000000000701',
  agent: '00000000-0000-4000-8000-000000000702',
  issuer: '00000000-0000-4000-8000-000000000703',
});

function issueInput(capabilityIds: readonly string[]) {
  return {
    agentId: null,
    displayName: 'Synthetic allowlist agent',
    facilityScope: { kind: 'district' },
    capabilityIds,
    expiresInSeconds: 7_776_000,
  };
}

describe('agent-key grant allowlist', () => {
  test('is exactly the written 27 IDs', () => {
    expect([...AGENT_KEY_GRANTABLE_CAPABILITY_IDS]).toEqual([
      ...EXPECTED_ALLOWLIST,
    ]);
    expect(new Set(AGENT_KEY_GRANTABLE_CAPABILITY_IDS).size).toBe(27);
    expect(AgentKeyGrantableCapabilityIdSchema).toBe(
      AgentCapabilityGrantSchema,
    );
  });

  test('stays inside the catalog agent vocabulary and off every human-only action', () => {
    for (const capabilityId of AGENT_KEY_GRANTABLE_CAPABILITY_IDS) {
      expect(isAgentGrantableCapabilityId(capabilityId)).toBe(true);
      expect(
        CAPABILITY_CATALOG[capabilityId].invocationPolicy.agentGrantable,
      ).toBe(true);
    }
    for (const actionId of HUMAN_ONLY_ACTION_IDS) {
      expect(isAgentKeyGrantableCapabilityId(actionId)).toBe(false);
    }
  });

  test('partitions the catalog agent vocabulary with no ID left undecided', () => {
    expect([...AGENT_GRANTABLE_CAPABILITY_IDS].sort()).toEqual(
      [
        ...AGENT_KEY_GRANTABLE_CAPABILITY_IDS,
        ...WITHHELD_DEPLOYED_IDS,
        ...WITHHELD_UNDEPLOYED_IDS,
      ].sort(),
    );
  });

  test('issues a key carrying every allowlisted grant', () => {
    const parsed = IssueAgentApiKeyInputSchema.parse(
      issueInput(AGENT_KEY_GRANTABLE_CAPABILITY_IDS),
    );
    expect(parsed.capabilityIds).toEqual([
      ...AGENT_KEY_GRANTABLE_CAPABILITY_IDS,
    ]);
  });

  test('refuses each withheld deployed ID at issuance although the catalog admits agents', () => {
    for (const capabilityId of WITHHELD_DEPLOYED_IDS) {
      // The catalog still admits the ID, so the allowlist is what refuses it.
      expect(isAgentGrantableCapabilityId(capabilityId)).toBe(true);
      expect(isAgentKeyGrantableCapabilityId(capabilityId)).toBe(false);
      expect(AgentCapabilityGrantSchema.safeParse(capabilityId).success).toBe(
        false,
      );
      expect(
        IssueAgentApiKeyInputSchema.safeParse(
          issueInput(['get-event', capabilityId]),
        ).success,
      ).toBe(false);
    }
  });

  test('refuses every undeployed catalog ID at issuance', () => {
    for (const capabilityId of WITHHELD_UNDEPLOYED_IDS) {
      expect(isAgentGrantableCapabilityId(capabilityId)).toBe(true);
      expect(isAgentKeyGrantableCapabilityId(capabilityId)).toBe(false);
      expect(
        IssueAgentApiKeyInputSchema.safeParse(
          issueInput(['get-event', capabilityId]),
        ).success,
      ).toBe(false);
    }
  });

  test('keeps a retained key row carrying a withheld grant parseable so authentication can fail closed per grant', () => {
    const stored = {
      id: IDS.key,
      agentId: IDS.agent,
      displayName: 'Key issued before the allowlist tightened',
      facilityScope: { kind: 'district' },
      capabilityIds: ['get-event', 'publish-event-type-version'],
      keyPrefix: 'abcdefghijkl',
      credentialDigest: 'a'.repeat(64),
      issuedByUserId: IDS.issuer,
      issuedAt: '2026-08-10T18:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
    };

    expect(AgentApiKeySchema.safeParse(stored).success).toBe(true);
    expect(
      IssueAgentApiKeyInputSchema.safeParse(issueInput(stored.capabilityIds))
        .success,
    ).toBe(false);
  });

  test('publishes the allowlist as the grant JSON Schema', () => {
    expect(z.toJSONSchema(AgentCapabilityGrantSchema)).toMatchObject({
      type: 'string',
      enum: [...AGENT_KEY_GRANTABLE_CAPABILITY_IDS],
    });
  });
});
