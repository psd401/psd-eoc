import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * AWS refuses MaxResults alongside an explicit id list, with
 * PARAMETERS_CANNOT_BE_USED_TOGETHER. Three calls in the adapter did exactly
 * that, and every real submission failed on the first one it reached.
 *
 * The adapter constructs its own AWS clients and every other test in this
 * package substitutes a fake for the whole thing, so no behavioural test
 * covers the commands it actually builds. Reading the source is the cheapest
 * check that would have caught this, and matches how this repository already
 * pins migration and stylesheet invariants.
 */
describe('AWS command construction', () => {
  const source = readFileSync(
    new URL('./aws-adapter.ts', import.meta.url),
    'utf8',
  );

  const commandBlocks = [
    ...source.matchAll(/new (Describe\w+Command)\(\{([\s\S]*?)\n\s*\}\)/gu),
  ].map(([, name, body]) => ({ body: body ?? '', name: name ?? '' }));

  it('finds the describe commands it means to inspect', () => {
    expect(commandBlocks.length).toBeGreaterThanOrEqual(6);
  });

  it('does not bind a leased number through RequestPhoneNumber', () => {
    // The SDK documents RequestPhoneNumber's RegistrationId as "attach your
    // phone number for an external registration process". This tool registers
    // through AWS itself, so passing it was refused with
    // INVALID_PARAMETER Fields="registrationId" and the number is instead
    // bound afterwards by CreateRegistrationAssociation.
    const request =
      /new RequestPhoneNumberCommand\(\{([\s\S]*?)\n\s*\}\)/u.exec(source);
    expect(request).not.toBeNull();
    expect(request?.[1] ?? '').not.toMatch(/\bRegistrationId:/u);
  });

  it.each(commandBlocks.map((block) => [block.name, block.body]))(
    '%s does not combine MaxResults with an explicit id list',
    (_name, body) => {
      const scopesById = /\b\w*Ids:/u.test(body);
      const paginates = /\bMaxResults:/u.test(body);
      expect(scopesById && paginates).toBe(false);
    },
  );
});
