import { describe, expect, test } from 'bun:test';
import {
  AGENT_KEY_GRANTABLE_CAPABILITY_IDS,
  CAPABILITY_CATALOG,
  HUMAN_ONLY_ACTION_IDS,
} from '@psd-eoc/contracts';

import {
  AGENT_GRANT_GROUPS,
  AGENT_GRANT_GROUP_BY_CAPABILITY,
  AGENT_GRANT_GROUP_IDS,
  groupAgentGrantOptions,
} from './grant-groups';

describe('agent grant groups', () => {
  test('classifies every allowlisted grant into one known group and nothing else', () => {
    for (const capabilityId of AGENT_KEY_GRANTABLE_CAPABILITY_IDS) {
      expect(AGENT_GRANT_GROUP_IDS).toContain(
        AGENT_GRANT_GROUP_BY_CAPABILITY[capabilityId],
      );
    }
    expect(Object.keys(AGENT_GRANT_GROUP_BY_CAPABILITY).sort()).toEqual(
      [...AGENT_KEY_GRANTABLE_CAPABILITY_IDS].sort(),
    );
    expect(AGENT_GRANT_GROUPS.map((group) => group.id)).toEqual([
      ...AGENT_GRANT_GROUP_IDS,
    ]);
    for (const withheld of [
      ...HUMAN_ONLY_ACTION_IDS,
      'publish-event-type-version',
      'append-journal-entry',
      'join-event',
      'reactivate-event',
      'reopen-as-correction',
    ]) {
      expect(AGENT_GRANT_GROUP_BY_CAPABILITY).not.toHaveProperty(withheld);
    }
  });

  test('keeps reads-and-reports to query capabilities and lifecycle effects in the synthetic group', () => {
    const lifecycle: string[] = [];
    for (const capabilityId of AGENT_KEY_GRANTABLE_CAPABILITY_IDS) {
      const definition = CAPABILITY_CATALOG[capabilityId];
      const group = AGENT_GRANT_GROUP_BY_CAPABILITY[capabilityId];
      if (group === 'reads-and-reports') {
        expect(definition.operation).toBe('query');
      }
      if (
        definition.operation === 'mutation' &&
        definition.safetyEffect !== 'none'
      ) {
        expect(group).toBe('synthetic-event-lifecycle');
        lifecycle.push(capabilityId);
      }
      if (group === 'synthetic-event-lifecycle') {
        expect(definition.operation).toBe('mutation');
        expect(definition.safetyEffect).not.toBe('none');
      }
    }
    expect(lifecycle.sort()).toEqual([
      'all-clear-event',
      'close-event',
      'start-event',
    ]);
  });

  test('describes each group once in words an administrator can act on', () => {
    const byId = new Map(
      AGENT_GRANT_GROUPS.map((group) => [group.id, group] as const),
    );
    expect(byId.get('reads-and-reports')?.title).toBe('Reads and reports');
    expect(byId.get('reads-and-reports')?.description).toContain(
      'Nothing in this group changes an event',
    );
    expect(byId.get('drafts')?.title).toBe('Drafts');
    expect(byId.get('drafts')?.description).toContain(
      'need an authenticated human',
    );
    expect(byId.get('drafts')?.description).not.toContain('publish a');
    expect(byId.get('synthetic-event-lifecycle')?.title).toBe(
      'Synthetic event lifecycle',
    );
    expect(byId.get('synthetic-event-lifecycle')?.description).toContain(
      'only for drills and tests on the synthetic roster',
    );
    for (const group of AGENT_GRANT_GROUPS) {
      expect(group.description).not.toContain(
        'The server applies the selected facility scope',
      );
    }
  });

  test('arranges offered capabilities into display groups in catalog order', () => {
    const grouped = groupAgentGrantOptions(
      ['prepare-activation', 'get-event', 'start-event', 'list-facilities'],
      (capabilityId) => capabilityId.toUpperCase(),
    );

    expect(grouped.map((group) => group.id)).toEqual([
      'reads-and-reports',
      'drafts',
      'synthetic-event-lifecycle',
    ]);
    expect(grouped[0]?.options).toEqual([
      { id: 'get-event', label: 'GET-EVENT' },
      { id: 'list-facilities', label: 'LIST-FACILITIES' },
    ]);
    expect(grouped[1]?.options).toEqual([
      { id: 'prepare-activation', label: 'PREPARE-ACTIVATION' },
    ]);
    expect(grouped[2]?.options).toEqual([
      { id: 'start-event', label: 'START-EVENT' },
    ]);
    expect(groupAgentGrantOptions([], () => '').map((g) => g.options)).toEqual([
      [],
      [],
      [],
    ]);
  });
});
