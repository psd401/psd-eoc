import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tenant context lives in two files next to each other. `cdk.json` is the
 * checked-in manifest. `cdk.local.json`, which git ignores, carries the keys a
 * district keeps out of a public repository: its identity (domains, origin,
 * name, facilities), cloud account, region and hosted zone, and the operator
 * identities of its GCP tooling. The committed `cdk.local.example.json` shows
 * every key with a synthetic tenant. Each key lives in exactly
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
 * A string tenant key for operator tooling. Without a fallback the tooling
 * refuses to run until the key is configured; with one, a checkout without
 * cdk.local.json still loads the module (tests, typecheck) and gets a
 * reserved value no real provider call can reach. A configured value that
 * fails the pattern always refuses.
 */
export function tenantString(
  key: string,
  pattern: RegExp,
  options: { readonly fallback?: string; readonly directory?: string } = {},
): string {
  const value = readTenantContext(options.directory ?? infraRoot)[key];
  if (value === undefined && options.fallback !== undefined) {
    return options.fallback;
  }
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(
      `${LOCAL_TENANT_CONTEXT_FILE} must define ${key} matching ${String(pattern)}.`,
    );
  }
  return value;
}

/**
 * The tenant's Google Cloud billing account in the canonical 6-6-6 form. It
 * has no unconfigured fallback: the GCP operator tooling that needs it must
 * not run without cdk.local.json.
 */
export function tenantGcpBillingAccount(directory: string = infraRoot): string {
  const value = readTenantContext(directory)['psdEoc:gcpBillingAccount'];
  if (
    typeof value !== 'string' ||
    !/^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/u.test(value)
  ) {
    throw new Error(
      `${LOCAL_TENANT_CONTEXT_FILE} must define psdEoc:gcpBillingAccount in the canonical 6-6-6 uppercase form.`,
    );
  }
  return value;
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

/**
 * Region operator scripts target when neither file defines psdEoc:awsRegion.
 * Any valid region works: the reserved unconfigured account already refuses
 * every call, so this only lets an unconfigured checkout load the modules.
 */
export const UNCONFIGURED_AWS_REGION = 'ca-central-1';

/** The tenant's AWS region, or `UNCONFIGURED_AWS_REGION` when unset. */
export function tenantAwsRegion(directory: string = infraRoot): string {
  return tenantString('psdEoc:awsRegion', /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u, {
    directory,
    fallback: UNCONFIGURED_AWS_REGION,
  });
}
