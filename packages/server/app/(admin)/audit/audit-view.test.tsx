import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SecurityAuditPageSchema } from '@psd-eoc/contracts';

import { AuditViewContent } from './audit-view';
import {
  emptyAuditFilterState,
  parseAuditSubmission,
  toAuditDisplayPage,
  type AuditFilterState,
  type AuditViewState,
} from './filters';

const AGENT_ID = '00000000-0000-4000-8000-000000000602';
const API_KEY_ID = '00000000-0000-4000-8000-000000000603';
const CURSOR = 'eyJzeW50aGV0aWMiOnRydWV9';

const FILTERS: AuditFilterState = {
  actorKind: 'agent',
  actorReference: AGENT_ID,
  action: 'query-security-audit',
  from: '2026-08-08T08:00:00',
  through: '2026-08-08T17:00:00',
};

function submission(
  fields: Readonly<Record<string, string | readonly string[]>>,
): FormData {
  const formData = new FormData();
  for (const [name, rawValues] of Object.entries(fields)) {
    const values = typeof rawValues === 'string' ? [rawValues] : rawValues;
    for (const value of values) formData.append(name, value);
  }
  return formData;
}

function noOpFormAction(formData: FormData): void {
  void formData;
  // Static semantic rendering never submits this action.
}

function auditPage() {
  return toAuditDisplayPage(
    SecurityAuditPageSchema.parse({
      items: [
        {
          id: '00000000-0000-4000-8000-000000000601',
          sequence: 7,
          previousHash: 'a'.repeat(64),
          entryHash: 'b'.repeat(64),
          category: 'audit-query',
          action: 'query-security-audit',
          actionIds: [],
          confirmationId: null,
          outcome: 'success',
          principal: {
            kind: 'agent',
            agentId: AGENT_ID,
            apiKeyId: API_KEY_ID,
          },
          source: 'agent-rest',
          facilityId: null,
          target: {
            kind: 'audit-query',
            id: '00000000-0000-4000-8000-000000000604',
          },
          requestId: '00000000-0000-4000-8000-000000000604',
          reasonCode: null,
          occurredAt: '2026-08-08T17:00:00.000Z',
        },
      ],
      pageInfo: {
        hasMore: true,
        nextCursor: CURSOR,
      },
    }),
  );
}

describe('security audit admin view', () => {
  test('parses an exact actor, action, and explicit UTC time from POST data', () => {
    const parsed = parseAuditSubmission(
      submission({
        intent: 'filter',
        actorKind: 'agent',
        actorReference: AGENT_ID,
        action: 'query-security-audit',
        from: '2026-08-08T08:00:00',
        through: '2026-08-08T17:00:00',
      }),
    );
    expect(parsed).toMatchObject({
      valid: true,
      query: {
        actorKind: 'agent',
        principal: { kind: 'agent', agentId: AGENT_ID },
        action: 'query-security-audit',
        occurredFrom: '2026-08-08T08:00:00.000Z',
        occurredThrough: '2026-08-08T17:00:00.000Z',
        cursor: null,
      },
    });
  });

  test('rejects unknown, repeated, mismatched, and stale filter fields', () => {
    expect(
      parseAuditSubmission(submission({ email: 'synthetic.staff@psd401.net' }))
        .valid,
    ).toBe(false);
    expect(
      parseAuditSubmission(submission({ actorKind: ['agent', 'human'] })).valid,
    ).toBe(false);
    expect(
      parseAuditSubmission(submission({ actorReference: AGENT_ID })).valid,
    ).toBe(false);
    const contactData = parseAuditSubmission(
      submission({
        actorKind: 'human',
        actorReference: 'synthetic.staff@psd401.net',
      }),
    );
    expect(contactData.valid).toBe(false);
    expect(contactData.filters.actorReference).toBe('');
    expect(
      parseAuditSubmission(submission({ intent: 'filter', cursor: CURSOR }))
        .valid,
    ).toBe(false);
    expect(
      parseAuditSubmission(
        submission({
          from: '2026-08-08T18:00',
          through: '2026-08-08T17:00',
        }),
      ).valid,
    ).toBe(false);
  });

  test('accepts an opaque cursor only through POST pagination', () => {
    const parsed = parseAuditSubmission(
      submission({
        intent: 'page',
        actorKind: 'agent',
        actorReference: AGENT_ID,
        action: 'query-security-audit',
        cursor: CURSOR,
      }),
    );
    expect(parsed).toMatchObject({
      valid: true,
      query: {
        principal: { kind: 'agent', agentId: AGENT_ID },
        cursor: CURSOR,
      },
    });
  });

  test('renders accessible POST controls and minimized semantic results', () => {
    const state: AuditViewState = {
      filters: FILTERS,
      page: auditPage(),
      errorMessage: null,
      forbidden: false,
    };
    expect(JSON.stringify(state)).not.toContain(API_KEY_ID);
    expect(JSON.stringify(state)).not.toContain(
      '00000000-0000-4000-8000-000000000604',
    );
    const html = renderToStaticMarkup(
      <AuditViewContent
        state={state}
        formAction={noOpFormAction}
        pending={false}
      />,
    );

    expect(html).toContain('Filter audit records');
    expect(html).toContain('Actor type');
    expect(html).toContain('Actor identifier');
    expect(html).toContain('From (UTC)');
    expect(html).toContain('<caption>');
    expect(html).toContain('Recorded chain hash');
    expect(html).toContain('Not facility-specific');
    expect(html).toContain('Next page of audit records');
    expect(html).toContain('1 security audit record displayed.');
    expect(html).toContain(AGENT_ID);
    expect(html).toContain(CURSOR);
    expect(html).not.toContain('href=');
    expect(html).not.toContain(API_KEY_ID);
    expect(html).not.toContain('@psd401.net');
    expect(html).not.toContain('messageContent');
  });

  test('shows a generic denial without rendering query controls', () => {
    const html = renderToStaticMarkup(
      <AuditViewContent
        state={{
          filters: emptyAuditFilterState(),
          page: null,
          errorMessage: null,
          forbidden: true,
        }}
        formAction={noOpFormAction}
        pending={false}
      />,
    );
    expect(html).toContain('Administrator access required');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<table');
  });
});
