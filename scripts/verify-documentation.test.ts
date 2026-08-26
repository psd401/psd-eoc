import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  currentDocumentationViolations,
  extractContractList,
  validateMarkdownLinks,
  validateMonitoringRunbooks,
  validateRecordsRetentionDocumentation,
  verifyDocumentation,
} from './verify-documentation';

const temporaryDirectories: string[] = [];
const retentionDocumentPaths = [
  'docs/ARCHITECTURE.md',
  'docs/INTEGRATIONS.md',
  'docs/runbooks/go-live.md',
] as const;

function retentionDocumentationFixture(
  prefix: string,
  transform: (path: string, contents: string) => string,
): string {
  const repositoryRoot = join(import.meta.dir, '..');
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  for (const path of retentionDocumentPaths) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(
      join(root, path),
      transform(path, readFileSync(join(repositoryRoot, path), 'utf8')),
    );
  }
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('documentation contract', () => {
  test('keeps the repository documentation synchronized', () => {
    expect(verifyDocumentation()).toEqual([]);
  });

  test('maps every monitoring alarm anchor to a current procedure', () => {
    expect(validateMonitoringRunbooks(join(import.meta.dir, '..'))).toEqual([]);
  });

  test('rejects monitoring anchors without a current procedure', () => {
    const root = mkdtempSync(join(tmpdir(), 'psd-eoc-monitoring-docs-'));
    temporaryDirectories.push(root);
    mkdirSync(join(root, 'infra', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'infra', 'src', 'monitoring.ts'),
      "runbookAnchor: 'missing-procedure'\n",
    );
    writeFileSync(
      join(root, 'infra', 'README.md'),
      '### Missing procedure\n\nDescribe the alarm without a link.\n',
    );

    expect(validateMonitoringRunbooks(root)).toEqual([
      {
        file: 'infra/README.md',
        line: 1,
        message:
          'monitoring runbook anchor has no current procedure link: missing-procedure',
      },
    ]);
  });

  test('validates relative files, directories, and heading fragments', () => {
    const root = mkdtempSync(join(tmpdir(), 'psd-eoc-doc-links-'));
    temporaryDirectories.push(root);
    mkdirSync(join(root, 'guide'));
    writeFileSync(join(root, 'guide', 'README.md'), '# Setup path\n');
    const source = join(root, 'README.md');
    writeFileSync(
      source,
      '[guide](guide/) [heading](guide/README.md#setup-path)\n',
    );

    expect(validateMarkdownLinks(root, [source])).toEqual([]);

    writeFileSync(source, '[missing](guide/README.md#not-there)\n');
    expect(validateMarkdownLinks(root, [source])).toEqual([
      {
        file: 'README.md',
        line: 1,
        message:
          'local link fragment does not exist: guide/README.md#not-there',
      },
    ]);
  });

  test('extracts only marked configuration names', () => {
    expect(
      extractContractList(
        [
          '`ignored`',
          '<!-- docs-contract:names:start -->',
          '- `SECOND`',
          '- `FIRST`',
          '<!-- docs-contract:names:end -->',
        ].join('\n'),
        'names',
      ),
    ).toEqual(['FIRST', 'SECOND']);
  });

  test('keeps records-retention sources, classes, and review status explicit', () => {
    expect(
      validateRecordsRetentionDocumentation(join(import.meta.dir, '..')),
    ).toEqual([]);
  });

  test('rejects an incomplete record-class inventory', () => {
    const root = retentionDocumentationFixture(
      'psd-eoc-retention-docs-',
      (path, contents) =>
        path === 'docs/ARCHITECTURE.md'
          ? contents.replace('- `transport-and-operational-copies`\n', '')
          : contents,
    );

    expect(validateRecordsRetentionDocumentation(root)).toContainEqual(
      expect.objectContaining({
        file: 'docs/ARCHITECTURE.md',
        message: expect.stringContaining('records-retention classes differ'),
      }),
    );
  });

  test('rejects a reviewed retention status without a review date', () => {
    const root = retentionDocumentationFixture(
      'psd-eoc-retention-status-',
      (path, contents) =>
        path === 'docs/INTEGRATIONS.md'
          ? contents.replace(
              'Controlled mapping review status: `pending`.',
              'Controlled mapping review status: `reviewed`.',
            )
          : contents,
    );

    expect(validateRecordsRetentionDocumentation(root)).toContainEqual(
      expect.objectContaining({
        file: 'docs/INTEGRATIONS.md',
        message:
          'records-retention mapping status, date, and evidence are inconsistent',
      }),
    );
  });

  test('accepts one consistent reviewed status with a real review date', () => {
    const root = retentionDocumentationFixture(
      'psd-eoc-retention-reviewed-',
      (path, contents) =>
        path === 'docs/INTEGRATIONS.md'
          ? contents
              .replace(
                'Controlled mapping review status: `pending`.',
                'Controlled mapping review status: `reviewed`.',
              )
              .replace(
                'Controlled mapping review date: `not completed`.',
                'Controlled mapping review date: `2026-08-25`.',
              )
              .replace(
                /No completed records-officer review or ambiguity\s+guidance has been supplied for this aggregate status\./u,
                'Records-officer review and ambiguity guidance have been supplied for this aggregate status.',
              )
          : contents,
    );

    expect(validateRecordsRetentionDocumentation(root)).toEqual([]);
  });

  test('rejects duplicate, invalid, future, or inconsistent review evidence', () => {
    const cases = [
      {
        name: 'duplicate-marker',
        transform: (path: string, contents: string): string =>
          path === 'docs/INTEGRATIONS.md'
            ? contents.replace(
                '<!-- psd-eoc:records-retention-review-status:start -->',
                '<!-- psd-eoc:records-retention-review-status:start -->\n<!-- psd-eoc:records-retention-review-status:start -->',
              )
            : contents,
        message: 'expected one bounded records-retention review-status section',
        file: 'docs/INTEGRATIONS.md',
      },
      {
        name: 'duplicate-status',
        transform: (path: string, contents: string): string =>
          path === 'docs/INTEGRATIONS.md'
            ? contents.replace(
                '- Controlled mapping review status: `pending`.',
                '- Controlled mapping review status: `pending`.\n- Controlled mapping review status: `reviewed`.',
              )
            : contents,
        message:
          'records-retention mapping status must occur once and be pending or reviewed',
        file: 'docs/INTEGRATIONS.md',
      },
      {
        name: 'status-outside-bounds',
        transform: (path: string, contents: string): string =>
          path === 'docs/INTEGRATIONS.md'
            ? contents
                .replace('- Controlled mapping review status: `pending`.\n', '')
                .replace(
                  '<!-- psd-eoc:records-retention-review-status:end -->',
                  '<!-- psd-eoc:records-retention-review-status:end -->\n\n- Controlled mapping review status: `pending`.',
                )
            : contents,
        message:
          'records-retention mapping status must occur once and be pending or reviewed',
        file: 'docs/INTEGRATIONS.md',
      },
      {
        name: 'invalid-date',
        transform: (path: string, contents: string): string =>
          path === 'docs/INTEGRATIONS.md'
            ? contents
                .replace(
                  'Controlled mapping review status: `pending`.',
                  'Controlled mapping review status: `reviewed`.',
                )
                .replace(
                  'Controlled mapping review date: `not completed`.',
                  'Controlled mapping review date: `2026-99-99`.',
                )
                .replace(
                  /No completed records-officer review or ambiguity\s+guidance has been supplied for this aggregate status\./u,
                  'Records-officer review and ambiguity guidance have been supplied for this aggregate status.',
                )
            : contents,
        message:
          'records-retention mapping status, date, and evidence are inconsistent',
        file: 'docs/INTEGRATIONS.md',
      },
      {
        name: 'source-date-drift',
        transform: (path: string, contents: string): string =>
          path === 'docs/ARCHITECTURE.md'
            ? contents.replace(
                'official sources were rechecked on 2026-08-25',
                'official sources were rechecked on 2026-08-26',
              )
            : contents,
        message:
          'records-retention official-source dates are invalid, future-dated, duplicated, or inconsistent',
        file: 'docs/INTEGRATIONS.md',
      },
      {
        name: 'future-source-date',
        transform: (_path: string, contents: string): string =>
          contents
            .replace(
              'official sources were rechecked on 2026-08-25',
              'official sources were rechecked on 9999-12-31',
            )
            .replace(
              'Official sources last rechecked: `2026-08-25`.',
              'Official sources last rechecked: `9999-12-31`.',
            ),
        message:
          'records-retention official-source dates are invalid, future-dated, duplicated, or inconsistent',
        file: 'docs/INTEGRATIONS.md',
      },
    ];

    for (const scenario of cases) {
      const root = retentionDocumentationFixture(
        `psd-eoc-retention-${scenario.name}-`,
        scenario.transform,
      );
      expect(validateRecordsRetentionDocumentation(root)).toContainEqual(
        expect.objectContaining({
          file: scenario.file,
          message: scenario.message,
        }),
      );
    }
  });

  test('rejects weakened source, override, draft, policy, and go-live contracts', () => {
    const cases = [
      {
        name: 'candidate',
        transform: (path: string, contents: string): string =>
          path === 'docs/ARCHITECTURE.md'
            ? contents.replace('GS2017-016 Rev. 0', 'missing candidate')
            : contents,
        message:
          'records-retention guidance is missing required statement: GS2017-016 Rev. 0',
        file: 'docs/ARCHITECTURE.md',
      },
      {
        name: 'source',
        transform: (path: string, contents: string): string =>
          path === 'docs/ARCHITECTURE.md'
            ? contents.replace(
                'local-government-common-records-retention-schedule-CORE.PDF',
                'missing-CORE.PDF',
              )
            : contents,
        message:
          'records-retention guidance is missing official source: https://www.sos.wa.gov/sites/default/files/2025-06/local-government-common-records-retention-schedule-CORE.PDF',
        file: 'docs/ARCHITECTURE.md',
      },
      {
        name: 'override',
        transform: (path: string, contents: string): string =>
          path === 'docs/ARCHITECTURE.md'
            ? contents.replace(
                /active\s+public-records request/u,
                'closed request',
              )
            : contents,
        message:
          'records-retention guidance is missing required statement: active public-records request',
        file: 'docs/ARCHITECTURE.md',
      },
      {
        name: 'draft-current',
        transform: (path: string, contents: string): string =>
          path === 'docs/ARCHITECTURE.md'
            ? contents.replace(
                'CORE v5.1 and K-12 v9.2 are non-authoritative draft revisions',
                'CORE v5.1 and K-12 v9.2 are current',
              )
            : contents,
        message:
          'records-retention guidance is missing required statement: CORE v5.1 and K-12 v9.2 are non-authoritative draft revisions',
        file: 'docs/ARCHITECTURE.md',
      },
      {
        name: 'policy',
        transform: (path: string, contents: string): string =>
          path === 'docs/ARCHITECTURE.md'
            ? contents.replace(
                '`automated-disposition: prohibited`',
                '`automated-disposition: enabled`',
              )
            : contents,
        message:
          'records-retention policy differs: documented=automated-disposition: enabled,deletion: prohibited,down-migrations: prohibited,lifecycle-rules: prohibited,purge: prohibited,record-retention: all,retention-timers: prohibited actual=automated-disposition: prohibited,deletion: prohibited,down-migrations: prohibited,lifecycle-rules: prohibited,purge: prohibited,record-retention: all,retention-timers: prohibited',
        file: 'docs/ARCHITECTURE.md',
      },
      {
        name: 'go-live',
        transform: (path: string, contents: string): string =>
          path === 'docs/runbooks/go-live.md'
            ? contents.replace(
                /blocks\s+any later disposition design/u,
                'allows a later disposition design',
              )
            : contents,
        message:
          'go-live procedure is missing the retention boundary: blocks any later disposition design',
        file: 'docs/runbooks/go-live.md',
      },
      ...[
        'Administrators may purge all retained event records at any time.',
        'Deletion is permitted after export.',
        'Operators can dispose of audit records.',
      ].map((authorization, index) => ({
        name: `authorization-${String(index)}`,
        transform: (path: string, contents: string): string =>
          path === 'docs/ARCHITECTURE.md'
            ? contents.replace(
                '<!-- psd-eoc:records-retention:end -->',
                `${authorization}\n\n<!-- psd-eoc:records-retention:end -->`,
              )
            : contents,
        message:
          'records-retention guidance contains conflicting disposition authorization',
        file: 'docs/ARCHITECTURE.md',
      })),
    ];

    for (const scenario of cases) {
      const root = retentionDocumentationFixture(
        `psd-eoc-retention-${scenario.name}-`,
        scenario.transform,
      );
      expect(validateRecordsRetentionDocumentation(root)).toContainEqual(
        expect.objectContaining({
          file: scenario.file,
          message: scenario.message,
        }),
      );
    }
  });

  test('rejects phase, tenant, and duplicate readiness claims from current docs', () => {
    expect(
      currentDocumentationViolations(
        'docs/runbooks/provider.md',
        'P5.5 says the PsdEoc stack is not deployed in us-west-2.',
      ),
    ).toEqual([
      'current documentation contains an implementation-phase token',
      'current documentation hardcodes protected tenant identity',
      'current documentation duplicates a volatile readiness claim',
    ]);
    expect(
      currentDocumentationViolations(
        'docs/INTEGRATIONS.md',
        'The boundary remains `blocked`.',
      ),
    ).toEqual([]);
    expect(
      currentDocumentationViolations(
        'docs/runbooks/provider.md',
        'Issue #292 retired this path; #30 owns the next test.',
      ),
    ).toEqual([
      'current runbook delegates durable behavior to a completed issue',
    ]);
    expect(
      currentDocumentationViolations(
        'docs/runbooks/rollback.md',
        'Verify the current delivery control\n   epoch before recovery.',
      ),
    ).toEqual([
      'current runbook references the removed notification control gate',
    ]);
    expect(
      currentDocumentationViolations(
        'CLAUDE.md',
        'bun run --cwd packages/server db:migrate',
      ),
    ).toEqual([
      'current documentation bypasses the pinned synthetic database commands',
    ]);
  });
});
