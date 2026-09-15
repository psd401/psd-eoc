import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tenant context lives in two files next to each other. `cdk.json` is the
 * checked-in manifest. `cdk.local.json`, which git ignores, carries the keys a
 * district keeps out of a public repository: today its AWS account ID and the
 * support phone number printed in SMS consent copy. The CDK app hands the
 * local file to `App` as default context, so `cdk.json` and the CLI still win
 * when they define the same key; operator scripts read the merged view.
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

/** The manifest's `psdEoc:*` context with the local context merged over it. */
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
  return Object.freeze({
    ...manifestContext,
    ...readLocalTenantContext(directory),
  });
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
