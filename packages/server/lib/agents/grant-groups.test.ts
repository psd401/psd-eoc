import { describe, expect, test } from 'bun:test';
import {
  CAPABILITY_CATALOG,
  HUMAN_ONLY_ACTION_IDS,
  isAgentGrantableCapabilityId,
} from '@psd-eoc/contracts';

import { AGENT_DEPLOYED_CAPABILITY_IDS } from './availability';
import {
  AGENT_GRANT_GROUPS,
  AGENT_GRANT_GROUP_BY_CAPABILITY,
  AGENT_GRANT_GROUP_IDS,
  groupAgentGrantOptions,
} from './grant-groups';

describe('agent grant groups', () => {
  test('classifies every deployed grantable capability into one known group', () => {
    for (const capabilityId of AGENT_DEPLOYED_CAPABILITY_IDS) {
      expect(isAgentGrantableCapabilityId(capabilityId)).toBe(true);
      expect(AGENT_GRANT_GROUP_IDS).toContain(
        AGENT_GRANT_GROUP_BY_CAPABILITY[capabilityId],
      );
    }
    expect(Object.keys(AGENT_GRANT_GROUP_BY_CAPABILITY).sort()).toEqual(
      [...AGENT_DEPLOYED_CAPABILITY_IDS].sort(),
    );
    expect(AGENT_GRANT_GROUPS.map((group) => group.id)).toEqual([
      ...AGENT_GRANT_GROUP_IDS,
    ]);
    for (const actionId of HUMAN_ONLY_ACTION_IDS) {
      expect(AGENT_GRANT_GROUP_BY_CAPABILITY).not.toHaveProperty(actionId);
    }
  });

  test('keeps reads-and-reports to query capabilities and lifecycle effects in the synthetic group', () => {
    for (const capabilityId of AGENT_DEPLOYED_CAPABILITY_IDS) {
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
      }
    }
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
      'needs an authenticated human',
    );
    expect(byId.get('synthetic-event-lifecycle')?.title).toBe(
      'Synthetic event lifecycle',
    );
    expect(byId.get('synthetic-event-lifecycle')?.description).toContain(
      'only for drills and tests on the synthetic roster',
    );
    expect(byId.get('synthetic-event-lifecycle')?.description).toContain(
      'reach any event within the facility scope',
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
