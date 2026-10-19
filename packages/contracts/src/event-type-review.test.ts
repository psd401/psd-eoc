import { describe, expect, test } from 'bun:test';

import { AgentCapabilityGrantSchema } from './agent-api';
import {
  AGENT_GRANTABLE_CAPABILITY_IDS,
  defineCapability,
  getCapabilityInvocationPolicy,
} from './capability-catalog';
import {
  DiscardEventTypeDraftInputSchema,
  EventTypeDraftAuthorSchema,
  EventTypeDraftDiscardSchema,
  EventTypeDraftListItemSchema,
  EventTypeDraftPageSchema,
  ListEventTypeDraftsInputSchema,
} from './event-type';

const ids = Object.freeze({
  draft: '00000000-0000-4000-8000-0000000000d1',
  eventType: '00000000-0000-4000-8000-0000000000e1',
  version: '00000000-0000-4000-8000-0000000000f1',
  agent: '00000000-0000-4000-8000-0000000000a1',
  apiKey: '00000000-0000-4000-8000-0000000000a2',
  user: '00000000-0000-4000-8000-0000000000b1',
  session: '00000000-0000-4000-8000-0000000000b2',
});

const revision = 'a'.repeat(64);

const agentActor = Object.freeze({
  kind: 'agent' as const,
  agentId: ids.agent,
  apiKeyId: ids.apiKey,
});

const humanActor = Object.freeze({
  kind: 'human' as const,
  userId: ids.user,
  sessionId: ids.session,
});

const agentItem = Object.freeze({
  id: ids.draft,
  eventTypeId: ids.eventType,
  name: 'Secure',
  templateMode: 'real' as const,
  baseVersionId: ids.version,
  baseVersionNumber: 3,
  draftedBy: agentActor,
  author: {
    kind: 'agent' as const,
    agentDisplayName: 'Wording Assistant',
    key: { displayName: 'Night shift drafting', keyPrefix: 'psd_eoc_ak_12ab' },
  },
  draftRevision: revision,
  createdAt: '2026-10-18T17:00:00.000Z',
});

describe('draft review contracts', () => {
  test('lists an agent draft with the key label a reviewer reads, never the UUID alone', () => {
    expect(EventTypeDraftListItemSchema.parse(agentItem)).toEqual(agentItem);
    expect(
      EventTypeDraftAuthorSchema.parse({
        kind: 'agent',
        agentDisplayName: null,
        key: null,
      }),
    ).toEqual({ kind: 'agent', agentDisplayName: null, key: null });
    // A key prefix is public but still bounded to the key-summary shape.
    expect(
      EventTypeDraftAuthorSchema.safeParse({
        kind: 'agent',
        agentDisplayName: 'Wording Assistant',
        key: { displayName: 'Night shift drafting', keyPrefix: 'short' },
      }).success,
    ).toBe(false);
    expect(
      EventTypeDraftAuthorSchema.safeParse({
        kind: 'agent',
        agentDisplayName: 'Wording Assistant',
        key: { displayName: 'Night shift drafting' },
      }).success,
    ).toBe(false);
  });

  test('keeps the author projection bound to the drafting actor', () => {
    expect(
      EventTypeDraftListItemSchema.safeParse({
        ...agentItem,
        author: { kind: 'human', displayName: 'Someone Else' },
      }).success,
    ).toBe(false);
    expect(
      EventTypeDraftListItemSchema.safeParse({
        ...agentItem,
        draftedBy: humanActor,
        author: { kind: 'human', displayName: 'Synthetic Reviewer' },
      }).success,
    ).toBe(true);
    expect(
      EventTypeDraftListItemSchema.safeParse({
        ...agentItem,
        draftedBy: { kind: 'system', serviceId: 'database-seed' },
      }).success,
    ).toBe(false);
  });

  test('describes the base version completely or not at all', () => {
    expect(
      EventTypeDraftListItemSchema.safeParse({
        ...agentItem,
        baseVersionId: null,
        baseVersionNumber: null,
      }).success,
    ).toBe(true);
    expect(
      EventTypeDraftListItemSchema.safeParse({
        ...agentItem,
        baseVersionNumber: null,
      }).success,
    ).toBe(false);
    expect(
      EventTypeDraftListItemSchema.safeParse({
        ...agentItem,
        baseVersionId: null,
      }).success,
    ).toBe(false);
    expect(
      EventTypeDraftListItemSchema.safeParse({
        ...agentItem,
        templates: {},
      }).success,
    ).toBe(false);
  });

  test('bounds the review list and pages it like every other list', () => {
    expect(
      ListEventTypeDraftsInputSchema.parse({ cursor: null, limit: 200 }),
    ).toEqual({ cursor: null, limit: 200 });
    expect(
      ListEventTypeDraftsInputSchema.safeParse({ cursor: null, limit: 201 })
        .success,
    ).toBe(false);
    expect(
      ListEventTypeDraftsInputSchema.safeParse({ cursor: null, limit: 0 })
        .success,
    ).toBe(false);
    expect(
      ListEventTypeDraftsInputSchema.safeParse({
        cursor: null,
        limit: 10,
        templateMode: 'real',
      }).success,
    ).toBe(false);
    expect(
      EventTypeDraftPageSchema.parse({
        items: [agentItem],
        pageInfo: { hasMore: false, nextCursor: null },
      }).items,
    ).toHaveLength(1);
  });

  test('discards one exact reviewed revision and records a human reviewer', () => {
    expect(
      DiscardEventTypeDraftInputSchema.parse({
        draftId: ids.draft,
        expectedDraftRevision: revision,
      }),
    ).toEqual({ draftId: ids.draft, expectedDraftRevision: revision });
    expect(
      DiscardEventTypeDraftInputSchema.safeParse({ draftId: ids.draft })
        .success,
    ).toBe(false);
    const discard = {
      draftId: ids.draft,
      eventTypeId: ids.eventType,
      draftRevision: revision,
      discardedBy: humanActor,
      discardedAt: '2026-10-18T17:05:00.000Z',
    };
    expect(EventTypeDraftDiscardSchema.parse(discard)).toEqual(discard);
    expect(
      EventTypeDraftDiscardSchema.safeParse({
        ...discard,
        discardedBy: agentActor,
      }).success,
    ).toBe(false);
    expect(
      EventTypeDraftDiscardSchema.safeParse({
        ...discard,
        discardedBy: { kind: 'system', serviceId: 'scheduled-cleanup' },
      }).success,
    ).toBe(false);
  });

  test('keeps draft review human-only on web and mobile, off every agent surface', () => {
    for (const id of [
      'list-event-type-drafts',
      'discard-event-type-draft',
    ] as const) {
      expect(getCapabilityInvocationPolicy(id)).toEqual({
        principalKinds: ['human'],
        sources: ['web', 'mobile'],
        agentGrantable: false,
      });
      expect(AgentCapabilityGrantSchema.safeParse(id).success).toBe(false);
      expect(AGENT_GRANTABLE_CAPABILITY_IDS as readonly string[]).not.toContain(
        id,
      );
      expect(defineCapability(id).humanActionPolicy).toEqual({ kind: 'none' });
    }
    expect(defineCapability('list-event-type-drafts').operation).toBe('query');
    expect(defineCapability('discard-event-type-draft').operation).toBe(
      'mutation',
    );
    // The agent half of the flow is unchanged: it may still read and draft.
    expect(getCapabilityInvocationPolicy('get-event-type-draft')).toMatchObject(
      { agentGrantable: true },
    );
  });
});
