import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type {
  AgentApiKeyIssuance,
  AgentApiKeySummary,
  AgentCapabilityGrant,
} from '@psd-eoc/contracts';

import {
  AgentAdmin,
  type AgentAdminAgent,
  type AgentAdminAuditRecord,
  type AgentAdminProps,
} from './agent-admin';

const ids = {
  agent: '20000000-0000-4000-8000-000000000001',
  key: '20000000-0000-4000-8000-000000000002',
  facility: '20000000-0000-4000-8000-000000000003',
  audit: '20000000-0000-4000-8000-000000000004',
  issuer: '20000000-0000-4000-8000-000000000005',
} as const;

const oneTimeCredential = 'psdeoc_agent_test_4J2FKPn7ZWxRTYv6hANbU0cL1q9s';
const issueIdempotencyKey = 'issue-agent-key:stable-test-token';
const verifierDigestThatMustNeverRender = 'd'.repeat(64);

const key: AgentApiKeySummary = {
  id: ids.key,
  agentId: ids.agent,
  displayName: 'Facilities reporting agent',
  facilityScope: { kind: 'facilities', facilityIds: [ids.facility] },
  capabilityIds: ['get-event', 'prepare-activation'],
  keyPrefix: 'psdeoc_A1',
  issuedByUserId: ids.issuer,
  issuedAt: '2026-08-10T16:00:00.000Z',
  expiresAt: '2026-11-08T16:00:00.000Z',
  revokedAt: null,
};

const issuedKey: AgentApiKeyIssuance = {
  key,
  oneTimeCredential,
};

const keyWithUnexpectedVerifier: AgentApiKeySummary &
  Readonly<{ credentialDigest: string }> = {
  ...key,
  credentialDigest: verifierDigestThatMustNeverRender,
};

const auditRecord: AgentAdminAuditRecord = {
  id: ids.audit,
  sequence: 42,
  action: 'get-event',
  outcome: 'success',
  principal: {
    kind: 'agent',
    agentId: ids.agent,
    apiKeyId: ids.key,
  },
  source: 'agent-rest',
  facilityId: ids.facility,
  reasonCode: null,
  occurredAt: '2026-08-10T16:05:00.000Z',
};

const agent: AgentAdminAgent = {
  id: ids.agent,
  displayName: 'Facilities reporting agent',
  keys: [keyWithUnexpectedVerifier],
  auditRecords: [auditRecord],
};

const humanOnlyOptionInjectedAtRuntime = {
  id: 'all-clear' as AgentCapabilityGrant,
  label: 'Unsafe injected action',
  description: 'This must be rejected by the presentation boundary.',
};

const baseProps: AgentAdminProps = {
  agents: [agent],
  facilities: [
    {
      id: ids.facility,
      code: 'HRH',
      name: 'Harbor Ridge High School',
      active: true,
    },
  ],
  grantOptions: [
    {
      id: 'get-event',
      label: 'Read event',
      description: 'Read an event in the selected facility scope.',
    },
    {
      id: 'prepare-activation',
      label: 'Prepare activation',
      description: 'Prepare a draft for later human confirmation.',
    },
    humanOnlyOptionInjectedAtRuntime,
  ],
  issueIdempotencyKey,
  issuedKey,
  notice: null,
  renderedAt: '2026-08-10T17:00:00.000Z',
  issueKeyAction: async (previousState) => previousState,
  revokeKeyAction: async (previousState) => previousState,
};

function render(overrides: Partial<AgentAdminProps> = {}): string {
  return renderToStaticMarkup(<AgentAdmin {...baseProps} {...overrides} />);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('agent administration presentation', () => {
  test('reveals the one-time credential exactly once with explicit handling guidance', () => {
    const markup = render();

    expect(occurrences(markup, oneTimeCredential)).toBe(1);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Store this API key now');
    expect(markup).toContain('shown once and cannot be recovered');
    expect(markup).toContain('readOnly=""');
    expect(markup).toMatch(
      /<section[^>]*class="credential-alert"[^>]*role="alert"[^>]*tabindex="-1"/u,
    );
    expect(markup).not.toContain(verifierDigestThatMustNeverRender);
    expect(markup).not.toContain('credentialDigest');
  });

  test('never includes the one-time credential in retained access or revocation forms', () => {
    const withoutReveal = render({ issuedKey: null });

    expect(withoutReveal).not.toContain(oneTimeCredential);
    expect(withoutReveal).toContain(`name="apiKeyId"`);
    expect(withoutReveal).toContain(`value="${ids.key}"`);
    expect(withoutReveal).toContain(`value="revoke-agent-key:${ids.key}"`);
    expect(withoutReveal).not.toContain(verifierDigestThatMustNeverRender);
  });

  test('binds stable replay-protection tokens into both mutation forms', () => {
    const markup = render();

    expect(markup).toContain(`value="${issueIdempotencyKey}"`);
    expect(markup).toContain('type="hidden" name="idempotencyKey"');
    expect(markup).toContain(`value="revoke-agent-key:${ids.key}"`);
  });

  test('uses native keyboard-operable controls and semantic table structure', () => {
    const markup = render();

    expect(markup).toContain('<main id="main-content" tabindex="-1">');
    expect(markup).toContain('<fieldset>');
    expect(markup).toContain('<legend>Facility scope</legend>');
    expect(markup).toContain('<legend>Capability scope</legend>');
    expect(markup).toContain('<details');
    expect(markup).toContain('<summary>Revoke key</summary>');
    expect(markup).toMatch(
      /<input[^>]*required=""[^>]*name="confirmRevocation"[^>]*>/u,
    );
    expect(markup).toContain('<button class="danger-action" type="submit">');
    expect(markup).toContain(
      '<caption>Issued keys and current authorization scope</caption>',
    );
    expect(markup).toContain('<th scope="col">Capability scope</th>');
    expect(markup).toContain('role="region" tabindex="0"');
    expect(markup).not.toContain('role="button"');
    expect(markup).not.toMatch(/tabindex="[1-9]/u);
  });

  test('filters canonical human-only action IDs even if unsafe data bypasses static typing', () => {
    const markup = render();

    expect(markup).not.toContain(
      'name="capabilityIds" type="checkbox" value="all-clear"',
    );
    expect(markup).not.toContain('Unsafe injected action');
    expect(markup).toContain('regardless of the facilities or capabilities');
  });

  test('shows scoped retained keys and minimized per-agent audit facts', () => {
    const markup = render();

    expect(markup).toContain('Harbor Ridge High School');
    expect(markup).toContain('prepare-activation');
    expect(markup).toContain('Agent call audit');
    expect(markup).toContain('get-event');
    expect(markup).toContain('agent-rest');
    expect(markup).toContain(ids.key);
    expect(markup).not.toContain('previousHash');
    expect(markup).not.toContain('entryHash');
  });

  test('keeps focus treatments and skip-navigation support in the route layout', () => {
    const componentSource = readFileSync(
      new URL('./agent-admin.tsx', import.meta.url),
      'utf8',
    );
    const layoutSource = readFileSync(
      new URL('./layout.tsx', import.meta.url),
      'utf8',
    );
    const operatorShellSource = readFileSync(
      new URL('../../nav/operator-shell.tsx', import.meta.url),
      'utf8',
    );
    const operatorShellStyles = readFileSync(
      new URL('../../nav/primary-nav.css', import.meta.url),
      'utf8',
    );
    const styles = readFileSync(
      new URL('./styles.css', import.meta.url),
      'utf8',
    );

    expect(componentSource).not.toContain('onClick=');
    expect(componentSource).not.toContain('onKeyDown=');
    expect(componentSource).toContain('credentialAlertRef.current?.focus()');
    expect(componentSource).toContain('[issuance.key.id]');
    expect(layoutSource).toContain('<OperatorShell>{children}</OperatorShell>');
    expect(operatorShellSource).toContain('href="#main-content"');
    expect(styles).toContain('.credential-alert:focus');
    expect(styles).toContain(':focus-visible');
    expect(operatorShellStyles).toContain('.skip-link:focus');
    expect(styles).toContain('@media (forced-colors: active)');
  });
});
