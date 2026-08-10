import type { SecurityAuditEntry } from '@psd-eoc/contracts';

import type { SecurityAuditFact } from './model';

/** Minimal append seam consumed by auth, capability, and admin call sites. */
export interface SecurityAuditWriter {
  append(fact: SecurityAuditFact | unknown): Promise<SecurityAuditEntry>;
}
