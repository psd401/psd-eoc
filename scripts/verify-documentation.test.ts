import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  currentMarkdownFiles,
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

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['.git', '.next', '.terraform', 'node_modules'].includes(entry.name)) {
      return [];
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}

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

function reviewedRetentionEvidence(
  contents: string,
  reviewDate: string,
): string {
  return contents
    .replace(
      'Controlled mapping review status: `pending`.',
      'Controlled mapping review status: `reviewed`.',
    )
    .replace(
      'Controlled mapping review date: `not completed`.',
      `Controlled mapping review date: \`${reviewDate}\`.`,
    )
    .replace(
      'Controlled mapping inventory coverage: `not completed`.',
      'Controlled mapping inventory coverage: `all classes`.',
    )
    .replace(
      'Controlled mapping ambiguity status: `not completed`.',
      'Controlled mapping ambiguity status: `resolved`.',
    )
    .replace(
      /No completed records-officer review or\s+ambiguity\s+guidance has been supplied for this aggregate status\./u,
      'Records-officer review covers all inventory classes, and retained guidance resolves every ambiguity.',
    );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('documentation contract', () => {
  test('ignores generated tool documentation', () => {
    const root = mkdtempSync(join(tmpdir(), 'psd-eoc-generated-docs-'));
    temporaryDirectories.push(root);
    mkdirSync(join(root, '.terraform', 'providers'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# Source\n');
    writeFileSync(
      join(root, '.terraform', 'providers', 'README.md'),
      '# Generated provider documentation\n',
    );

    expect(currentMarkdownFiles(root)).toEqual([join(root, 'README.md')]);
  });

  test('keeps the repository documentation synchronized', () => {
    expect(verifyDocumentation()).toEqual([]);
  });

  test('forbids repository-hosted deployment workflows', () => {
    const repository = join(import.meta.dir, '..');
    const workflows = join(repository, '.github', 'workflows');
    const workflowFiles = readdirSync(workflows).filter((file) =>
      /\.ya?ml$/u.test(file),
    );

    for (const file of workflowFiles) {
      expect(file.toLowerCase()).not.toContain('deploy');
      const workflow = readFileSync(join(workflows, file), 'utf8').replaceAll(
        /\\\r?\n/gu,
        ' ',
      );
      expect(workflow).not.toMatch(/\bcdk\b[\s\S]{0,500}\bdeploy\b/iu);
      expect(workflow).not.toMatch(
        /aws cloudformation (?:create-stack|deploy|execute-change-set|update-stack)/iu,
      );
      expect(workflow).not.toMatch(
        /aws apprunner (?:create-service|update-service)/iu,
      );
      expect(workflow).not.toMatch(/\b(?:docker push|aws ecr put-image)\b/iu);
    }

    const prohibitedDocumentation = [
      /\.github\/workflows\/deploy/iu,
      /\bAWS_DEPLOY_[A-Z0-9_]+\b/u,
      /\bActions\s*→\s*Deploy\b/iu,
      /\bGitHub Actions OIDC\b/iu,
      /\bGitHub OIDC (?:deploy|deployment|role)\b/iu,
      /\bnormal OIDC workflow\b/iu,
      /\bsupported `Deploy` workflow\b/iu,
      /(?:\bissue\s+|\[)#31\b/iu,
      /^\s*31\.\s+Failure drills\b/imu,
    ];
    for (const file of markdownFiles(repository)) {
      const contents = readFileSync(file, 'utf8');
      for (const pattern of prohibitedDocumentation) {
        expect(contents).not.toMatch(pattern);
      }
    }
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
          ? reviewedRetentionEvidence(contents, 'not completed')
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
          ? reviewedRetentionEvidence(contents, '2026-08-25')
          : contents,
    );

    expect(validateRecordsRetentionDocumentation(root)).toEqual([]);
  });

  test('accepts explicit resolved prose with reviewed evidence', () => {
    const root = retentionDocumentationFixture(
      'psd-eoc-retention-resolved-',
      (path, contents) =>
        path === 'docs/INTEGRATIONS.md'
          ? reviewedRetentionEvidence(contents, '2026-08-25').replace(
              '<!-- psd-eoc:records-retention-review-status:end -->',
              'No classifications remain unresolved.\n\n<!-- psd-eoc:records-retention-review-status:end -->',
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
            ? reviewedRetentionEvidence(contents, '2026-99-99')
            : contents,
        message:
          'records-retention mapping status, date, and evidence are inconsistent',
        file: 'docs/INTEGRATIONS.md',
      },
      {
        name: 'future-review-date',
        transform: (path: string, contents: string): string =>
          path === 'docs/INTEGRATIONS.md'
            ? reviewedRetentionEvidence(contents, '9999-12-31')
            : contents,
        message:
          'records-retention mapping status, date, and evidence are inconsistent',
        file: 'docs/INTEGRATIONS.md',
      },
      {
        name: 'pre-schedule-review-date',
        transform: (path: string, contents: string): string =>
          path === 'docs/INTEGRATIONS.md'
            ? reviewedRetentionEvidence(contents, '2026-06-02')
            : contents,
        message:
          'records-retention mapping status, date, and evidence are inconsistent',
        file: 'docs/INTEGRATIONS.md',
      },
      ...[
        'One classification remains unresolved.',
        'The transport class was not reviewed.',
        'Ambiguities remain PENDING.',
      ].map((contradiction, index) => ({
        name: `reviewed-contradiction-${String(index)}`,
        transform: (path: string, contents: string): string =>
          path === 'docs/INTEGRATIONS.md'
            ? reviewedRetentionEvidence(contents, '2026-08-25').replace(
                '<!-- psd-eoc:records-retention-review-status:end -->',
                `${contradiction}\n\n<!-- psd-eoc:records-retention-review-status:end -->`,
              )
            : contents,
        message:
          'records-retention mapping status, date, and evidence are inconsistent',
        file: 'docs/INTEGRATIONS.md',
      })),
      {
        name: 'source-date-drift',
        transform: (path: string, contents: string): string =>
          path === 'docs/INTEGRATIONS.md'
            ? contents.replace(
                'official sources were rechecked on 2026-08-26:',
                'official sources were rechecked on 2026-08-25:',
              )
            : contents,
        message:
          'records-retention official-source date is invalid, stale, future-dated, duplicated, or inconsistent',
        file: 'docs/INTEGRATIONS.md',
      },
      {
        name: 'future-source-date',
        transform: (_path: string, contents: string): string =>
          contents
            .replace(
              'official sources were rechecked on 2026-08-26',
              'official sources were rechecked on 9999-12-31',
            )
            .replace(
              'Official sources last rechecked: `2026-08-26`.',
              'Official sources last rechecked: `9999-12-31`.',
            ),
        message:
          'records-retention official-source date is invalid, stale, future-dated, duplicated, or inconsistent',
        file: 'docs/INTEGRATIONS.md',
      },
      {
        name: 'stale-source-date',
        transform: (path: string, contents: string): string =>
          path === 'docs/INTEGRATIONS.md'
            ? contents
                .replace(
                  'official sources were rechecked on 2026-08-26',
                  'official sources were rechecked on 2026-08-25',
                )
                .replace(
                  'Official sources last rechecked: `2026-08-26`.',
                  'Official sources last rechecked: `2026-08-25`.',
                )
            : contents,
        message:
          'records-retention official-source date is invalid, stale, future-dated, duplicated, or inconsistent',
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
          path === 'docs/INTEGRATIONS.md'
            ? contents.replace('GS2017-016 Rev. 0', 'missing candidate')
            : contents,
        message:
          'records-retention candidate mapping differs from required current evidence',
        file: 'docs/INTEGRATIONS.md',
      },
      ...(
        [
          ['period', 'Retain for 3 years', 'Retain for 4 years'],
          [
            'trigger',
            'after the matter is resolved or recovery is complete',
            'after creation',
          ],
          [
            'disposition',
            'then destroy; non-archival',
            'then retain permanently',
          ],
          ['archival', 'non-archival.', 'archival.'],
          [
            'source-designation',
            '| OPR                |',
            '| OFM                |',
          ],
        ] as const
      ).map(([name, current, replacement]) => ({
        name: `candidate-${name}`,
        transform: (path: string, contents: string): string =>
          path === 'docs/INTEGRATIONS.md'
            ? contents.replace(current, replacement)
            : contents,
        message:
          'records-retention candidate mapping differs from required current evidence',
        file: 'docs/INTEGRATIONS.md',
      })),
      {
        name: 'source',
        transform: (path: string, contents: string): string =>
          path === 'docs/INTEGRATIONS.md'
            ? contents.replace(
                'local-government-common-records-retention-schedule-CORE.PDF',
                'missing-CORE.PDF',
              )
            : contents,
        message:
          'records-retention guidance is missing official source: https://www.sos.wa.gov/sites/default/files/2025-06/local-government-common-records-retention-schedule-CORE.PDF',
        file: 'docs/INTEGRATIONS.md',
      },
      {
        name: 'candidate-outside-contract',
        transform: (path: string, contents: string): string =>
          path === 'docs/INTEGRATIONS.md'
            ? contents.replace(
                '<!-- docs-contract:records-retention-candidates:end -->',
                '<!-- docs-contract:records-retention-candidates:end -->\n\nRoutine/minor responses use `GS50-18-29 Rev. 2` and retain for one year, then destroy.',
              )
            : contents,
        message:
          'records-retention candidate evidence appears outside its bounded contract',
        file: 'docs/INTEGRATIONS.md',
      },
      {
        name: 'candidate-paraphrase-outside-contract',
        transform: (path: string, contents: string): string =>
          path === 'docs/INTEGRATIONS.md'
            ? contents.replace(
                '<!-- docs-contract:records-retention-candidates:end -->',
                '<!-- docs-contract:records-retention-candidates:end -->\n\nRoutine/minor responses are retained for one year and destroyed afterward.',
              )
            : contents,
        message:
          'records-retention candidate evidence appears outside its bounded contract',
        file: 'docs/INTEGRATIONS.md',
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
          path === 'docs/INTEGRATIONS.md'
            ? contents.replace(
                'CORE v5.1 and K-12 v9.2 are non-authoritative draft revisions',
                'CORE v5.1 and K-12 v9.2 are current',
              )
            : contents,
        message:
          'records-retention review is missing required current evidence: CORE v5.1 and K-12 v9.2 are non-authoritative draft revisions',
        file: 'docs/INTEGRATIONS.md',
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
        message: 'records-retention policy differs from the required contract',
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

  test('rejects unsafe and duplicated claims from current docs', () => {
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
        'docs/runbooks/provider.md',
        'Deploy into account 123456789012 only.',
      ),
    ).toEqual(['current documentation hardcodes protected tenant identity']);
    expect(
      currentDocumentationViolations(
        'docs/CONFIGURATION.md',
        'The reserved account `000000000000` matches no live credential.',
      ),
    ).toEqual([]);
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
    expect(
      currentDocumentationViolations(
        'docs/ARCHITECTURE.md',
        'CORE v5.0 and GS2017-016 Rev. 0 are current.',
      ),
    ).toEqual(['current documentation duplicates volatile retention evidence']);
    for (const authorization of [
      'Administrators may purge all retained event records at any time.',
      'Deletion is permitted after export.',
      'Operators can dispose of audit records.',
      'Deletion is permitted after export, not before export.',
      'Deletion is not prohibited.',
      'No approval is needed, administrators may purge all retained event records.',
      'Administrators may purge event records if no legal hold exists.',
      'No user except administrators may purge retained event records.',
      'No one other than records administrators may delete retained event records.',
    ]) {
      expect(
        currentDocumentationViolations(
          'docs/runbooks/records.md',
          authorization,
        ),
      ).toEqual([
        'current documentation contains conflicting disposition authorization',
      ]);
    }
    for (const prohibition of [
      'Deletion is not permitted.',
      'Purge is not allowed.',
      'Automated disposition is never authorized.',
      'Down migrations are not permitted.',
    ]) {
      expect(
        currentDocumentationViolations('docs/runbooks/records.md', prohibition),
      ).toEqual([]);
    }
  });
});
