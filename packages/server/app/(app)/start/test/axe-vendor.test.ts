import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'bun:test';

const VENDOR_DIRECTORY = new URL('./vendor/axe-core-4.12.1/', import.meta.url);

const EXPECTED_HASHES = Object.freeze({
  'axe.min.js.txt':
    '66a8aaa95a8b044a7fd74a5435873bf04ff65a1ca75567c921b7509742085a14',
  LICENSE: 'af175b9d96ee93c21a036152e1b905b0b95304d4ae8c2c921c7609100ba8df7e',
  'LICENSE-3RD-PARTY.txt':
    '4f8563870d0fca38bbc3e00b6f670cb7fa9f380ba9f26a7f7d1184a6b18b1653',
} as const);

type VendorFileName = keyof typeof EXPECTED_HASHES;

function vendorFile(fileName: string): URL {
  return new URL(fileName, VENDOR_DIRECTORY);
}

async function sha256(fileName: VendorFileName): Promise<string> {
  const contents = await readFile(vendorFile(fileName));
  return createHash('sha256').update(contents).digest('hex');
}

describe('vendored axe-core browser engine', () => {
  test('matches the exact pinned upstream bundle and license files', async () => {
    const actualEntries = await Promise.all(
      (Object.keys(EXPECTED_HASHES) as VendorFileName[]).map(
        async (fileName) => [fileName, await sha256(fileName)] as const,
      ),
    );
    expect(Object.fromEntries(actualEntries)).toEqual(EXPECTED_HASHES);

    const bundle = await readFile(vendorFile('axe.min.js.txt'), 'utf8');
    expect(bundle.startsWith('/*! axe v4.12.1\n')).toBe(true);
    expect(bundle).toContain(
      'This entire copyright notice must appear in every copy of this file',
    );
  });

  test('documents the exact package, source, integrity, and license provenance', async () => {
    const notice = await readFile(vendorFile('NOTICE.md'), 'utf8');
    expect(notice).toContain('`axe-core` version 4.12.1');
    expect(notice).toContain(
      'https://registry.npmjs.org/axe-core/-/axe-core-4.12.1.tgz',
    );
    expect(notice).toContain(
      'https://github.com/dequelabs/axe-core/tree/v4.12.1',
    );
    expect(notice).toContain(EXPECTED_HASHES['axe.min.js.txt']);
    expect(notice).toContain('Mozilla Public License 2.0');

    const license = await readFile(vendorFile('LICENSE'), 'utf8');
    expect(license.startsWith('Mozilla Public License, version 2.0')).toBe(
      true,
    );
    const thirdPartyLicense = await readFile(
      vendorFile('LICENSE-3RD-PARTY.txt'),
      'utf8',
    );
    expect(thirdPartyLicense).toContain('MIT License');
    expect(thirdPartyLicense).toContain('ISC License');
  });
});
