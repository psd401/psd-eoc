import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tenant context lives in two files next to each other. `cdk.json` is the
 * checked-in manifest. `cdk.local.json`, which git ignores, carries the keys a
 * district keeps out of a public repository: today its AWS account ID and the
 * support phone number printed in SMS consent copy. Each key lives in exactly
 * one of the two files: the CDK app hands the local file to `App` as default
 * context and refuses to run when `cdk.json` or a `-c` flag overrides one of
 * its keys, and `readTenantContext` refuses a key that both files define, so
 * the deployed stack and the operator scripts can never disagree.
 */
export const TENANT_MANIFEST_FILE = 'cdk.json';
export const LOCAL_TENANT_CONTEXT_FILE = 'cdk.local.json';
/**
 * Reserved account ID reported when no local context exists. Operator scripts
 * compare live credentials against it, so an unconfigured checkout refuses
 * every AWS mutation instead of guessing a target.
 */
export const UNCONFIGURED_AWS_ACCOUNT = '000000000000';

export const infraRoot = fileURLToPath(new URL('..', import.meta.url));

export type TenantContext = Readonly<Record<string, unknown>>;

function readJsonObject(
  path: string,
  label: string,
): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function tenantKeysOnly(
  record: Readonly<Record<string, unknown>>,
  label: string,
): TenantContext {
  for (const key of Object.keys(record)) {
    if (!key.startsWith('psdEoc:')) {
      throw new Error(
        `${label} may only contain psdEoc:* context keys; found ${key}.`,
      );
    }
  }
  return Object.freeze({ ...record });
}

/** The git-ignored local context, or an empty object when the file is absent. */
export function readLocalTenantContext(
  directory: string = infraRoot,
): TenantContext {
  const path = join(directory, LOCAL_TENANT_CONTEXT_FILE);
  if (!existsSync(path)) return Object.freeze({});
  return tenantKeysOnly(
    readJsonObject(path, LOCAL_TENANT_CONTEXT_FILE),
    LOCAL_TENANT_CONTEXT_FILE,
  );
}

/**
 * The manifest's `psdEoc:*` context plus the local context. A key defined in
 * both files is an error rather than a precedence question.
 */
export function readTenantContext(
  directory: string = infraRoot,
): TenantContext {
  const manifest = readJsonObject(
    join(directory, TENANT_MANIFEST_FILE),
    TENANT_MANIFEST_FILE,
  );
  const context = manifest.context;
  const manifestContext =
    context !== null && typeof context === 'object' && !Array.isArray(context)
      ? Object.fromEntries(
          Object.entries(context as Record<string, unknown>).filter(([key]) =>
            key.startsWith('psdEoc:'),
          ),
        )
      : {};
  const localContext = readLocalTenantContext(directory);
  for (const key of Object.keys(localContext)) {
    if (key in manifestContext) {
      throw new Error(
        `${LOCAL_TENANT_CONTEXT_FILE} and ${TENANT_MANIFEST_FILE} both define ${key}; keep each key in exactly one file.`,
      );
    }
  }
  return Object.freeze({ ...manifestContext, ...localContext });
}

/**
 * The tenant's 12-digit AWS account ID, or `UNCONFIGURED_AWS_ACCOUNT` when
 * neither file defines `psdEoc:awsAccount`.
 */
export function tenantAwsAccount(directory: string = infraRoot): string {
  const value = readTenantContext(directory)['psdEoc:awsAccount'];
  if (value === undefined) return UNCONFIGURED_AWS_ACCOUNT;
  if (typeof value !== 'string' || !/^\d{12}$/u.test(value)) {
    throw new Error(
      'CDK context psdEoc:awsAccount must be a 12-digit AWS account ID.',
    );
  }
  return value;
}
