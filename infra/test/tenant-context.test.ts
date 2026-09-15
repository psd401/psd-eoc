import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LOCAL_TENANT_CONTEXT_FILE,
  TENANT_MANIFEST_FILE,
  UNCONFIGURED_AWS_ACCOUNT,
  readLocalTenantContext,
  readTenantContext,
  tenantAwsAccount,
} from '../src/tenant-context';

let directory: string;

function writeManifest(context: Record<string, unknown>): void {
  writeFileSync(
    join(directory, TENANT_MANIFEST_FILE),
    JSON.stringify({ app: 'bun bin/psd-eoc.ts', context }),
  );
}

function writeLocal(contents: string): void {
  writeFileSync(join(directory, LOCAL_TENANT_CONTEXT_FILE), contents);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'psd-eoc-tenant-context-'));
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

describe('local tenant context', () => {
  it('is empty when the file is absent', () => {
    expect(readLocalTenantContext(directory)).toEqual({});
  });

  it('accepts only psdEoc keys from a JSON object', () => {
    writeLocal('[]');
    expect(() => readLocalTenantContext(directory)).toThrow(
      `${LOCAL_TENANT_CONTEXT_FILE} must be a JSON object.`,
    );
    writeLocal('{');
    expect(() => readLocalTenantContext(directory)).toThrow(
      `${LOCAL_TENANT_CONTEXT_FILE} is not valid JSON`,
    );
    writeLocal(JSON.stringify({ '@aws-cdk/core:checkSecretUsage': true }));
    expect(() => readLocalTenantContext(directory)).toThrow(
      'may only contain psdEoc:* context keys; found @aws-cdk/core:checkSecretUsage.',
    );
    writeLocal(JSON.stringify({ 'psdEoc:awsAccount': '123456789012' }));
    expect(readLocalTenantContext(directory)).toEqual({
      'psdEoc:awsAccount': '123456789012',
    });
  });
});

describe('merged tenant context', () => {
  it('keeps only the manifest psdEoc keys and adds the local file', () => {
    writeManifest({
      '@aws-cdk/core:checkSecretUsage': true,
      'psdEoc:awsRegion': 'us-east-1',
      'psdEoc:organizationName': 'Example School District',
    });
    expect(readTenantContext(directory)).toEqual({
      'psdEoc:awsRegion': 'us-east-1',
      'psdEoc:organizationName': 'Example School District',
    });
    writeLocal(JSON.stringify({ 'psdEoc:awsAccount': '123456789012' }));
    expect(readTenantContext(directory)).toEqual({
      'psdEoc:awsAccount': '123456789012',
      'psdEoc:awsRegion': 'us-east-1',
      'psdEoc:organizationName': 'Example School District',
    });
  });

  it('refuses a key that both files define instead of picking a side', () => {
    writeManifest({ 'psdEoc:organizationName': 'Example School District' });
    writeLocal(
      JSON.stringify({
        'psdEoc:awsAccount': '123456789012',
        'psdEoc:organizationName': 'Local Override District',
      }),
    );
    expect(() => readTenantContext(directory)).toThrow(
      `${LOCAL_TENANT_CONTEXT_FILE} and ${TENANT_MANIFEST_FILE} both define psdEoc:organizationName; keep each key in exactly one file.`,
    );
  });

  it('reports the reserved account until the local file defines a valid one', () => {
    writeManifest({ 'psdEoc:awsRegion': 'us-east-1' });
    expect(tenantAwsAccount(directory)).toBe(UNCONFIGURED_AWS_ACCOUNT);
    writeLocal(JSON.stringify({ 'psdEoc:awsAccount': '12345' }));
    expect(() => tenantAwsAccount(directory)).toThrow(
      'psdEoc:awsAccount must be a 12-digit AWS account ID.',
    );
    writeLocal(JSON.stringify({ 'psdEoc:awsAccount': 123456789012 }));
    expect(() => tenantAwsAccount(directory)).toThrow(
      'psdEoc:awsAccount must be a 12-digit AWS account ID.',
    );
    writeLocal(JSON.stringify({ 'psdEoc:awsAccount': '123456789012' }));
    expect(tenantAwsAccount(directory)).toBe('123456789012');
  });
});
