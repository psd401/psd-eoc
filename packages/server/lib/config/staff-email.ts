import {
  staffRosterEmailSchemaForDomain,
  type StaffRosterEmail,
} from '@psd-eoc/contracts';
import type { z } from 'zod';

import { staffHostedDomain } from './deployment';

let bound: z.ZodType<StaffRosterEmail> | undefined;

/**
 * The staff-email schema bound to this deployment's domain.
 *
 * A roster and an access group hold this district's staff and nobody else, so
 * an address outside the domain is refused rather than quietly carried. The
 * domain used to be a literal in `@psd-eoc/contracts`, which meant no other
 * district could put its own staff anywhere; it is the same value Google OIDC
 * pins sign-in to, read once here.
 *
 * Resolved lazily, not at import: a module that merely declares the shape of a
 * provider payload should not require a configured deployment to load. Use
 * this wherever an address is actually admitted, and the bare
 * `StaffRosterEmailSchema` only where shape is all that is being described.
 */
export function staffRosterEmail(): z.ZodType<StaffRosterEmail> {
  bound ??= staffRosterEmailSchemaForDomain(staffHostedDomain());
  return bound;
}

/** Forgets the resolved domain. Tests that change the environment need this. */
export function resetStaffRosterEmailForTests(): void {
  bound = undefined;
}
