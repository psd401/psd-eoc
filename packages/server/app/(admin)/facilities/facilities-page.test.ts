import { describe, expect, test } from 'bun:test';

import { statusMessage } from './page';

describe('facilities administration page status', () => {
  test('accepts only own status-message keys', () => {
    expect(statusMessage('facility-created')).toBe('The facility was added.');
    expect(statusMessage(undefined)).toBeNull();
    expect(statusMessage('unknown-status')).toBeNull();
    expect(statusMessage('constructor')).toBeNull();
    expect(statusMessage('toString')).toBeNull();
    expect(statusMessage('__proto__')).toBeNull();
  });
});
