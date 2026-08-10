import { describe, expect, test } from 'bun:test';

import { clearMarkerThenVault } from './storage-safety';

describe('secure session clearing order', () => {
  test('clears the marker before the bearer vault', async () => {
    const order: string[] = [];
    await clearMarkerThenVault(
      async () => {
        order.push('marker');
      },
      async () => {
        order.push('vault');
      },
    );
    expect(order).toEqual(['marker', 'vault']);
  });

  test('still attempts vault removal after marker deletion fails', async () => {
    let vaultAttempted = false;
    await expect(
      clearMarkerThenVault(
        async () => {
          throw new Error('marker failed');
        },
        async () => {
          vaultAttempted = true;
        },
      ),
    ).rejects.toThrow('marker failed');
    expect(vaultAttempted).toBe(true);
  });
});
