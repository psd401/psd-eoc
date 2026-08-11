import { describe, expect, test } from 'bun:test';

import { integrationsAdminStatusMessage } from './page-state';

describe('integrations administration page query state', () => {
  test('maps only one own allowlisted status key', () => {
    expect(integrationsAdminStatusMessage('channel-updated')).toBe(
      'The notification channel configuration was updated.',
    );
    expect(integrationsAdminStatusMessage('unknown')).toBeNull();
    expect(integrationsAdminStatusMessage(undefined)).toBeNull();
  });

  test('keeps prototype names and repeated status parameters inert', () => {
    expect(integrationsAdminStatusMessage('__proto__')).toBeNull();
    expect(integrationsAdminStatusMessage('constructor')).toBeNull();
    expect(integrationsAdminStatusMessage('toString')).toBeNull();
    expect(
      integrationsAdminStatusMessage(['channel-updated', '__proto__']),
    ).toBeNull();
  });
});
