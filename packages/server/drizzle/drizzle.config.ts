import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle's generation configuration is deliberately file-only: generating a
 * migration never needs database credentials or a connection to an AWS
 * environment.
 */
export default defineConfig({
  dialect: 'postgresql',
  out: './drizzle/migrations',
  schema: './db/schema.ts',
  strict: true,
  verbose: true,
});
