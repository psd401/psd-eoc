import { describe, expect, test } from 'bun:test';

import * as schema from './schema';
import * as audit from './schema/audit';
import * as configuration from './schema/configuration';
import * as delivery from './schema/delivery';
import * as enums from './schema/enums';
import * as eventTypes from './schema/event-types';
import * as events from './schema/events';
import * as identity from './schema/identity';
import * as roster from './schema/roster';

const domainModules = [
  enums,
  configuration,
  identity,
  roster,
  eventTypes,
  events,
  delivery,
  audit,
] as const;

describe('database schema aggregate exports', () => {
  test('keeps every domain declaration available through the stable schema module', () => {
    const aggregate = schema as Readonly<Record<string, unknown>>;
    const directEntries = domainModules.flatMap((module) =>
      Object.entries(module),
    );

    for (const [name, declaration] of directEntries) {
      expect(aggregate[name], name).toBe(declaration);
    }
    expect(Object.keys(aggregate).sort()).toEqual(
      [...new Set(directEntries.map(([name]) => name))].sort(),
    );
  });

  test('keeps internal column helpers out of the public aggregate', () => {
    expect('auditCode' in schema).toBe(false);
    expect('digest' in schema).toBe(false);
    expect('occurredAt' in schema).toBe(false);
  });
});
