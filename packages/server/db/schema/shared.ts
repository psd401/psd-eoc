import { timestamp, varchar } from 'drizzle-orm/pg-core';
export const auditCode = (name: string) => varchar(name, { length: 100 });
export const digest = (name: string) => varchar(name, { length: 64 });
export const occurredAt = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });
