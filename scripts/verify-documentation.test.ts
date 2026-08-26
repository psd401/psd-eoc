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
    const repositoryRoot = join(import.meta.dir, '..');
    const root = mkdtempSync(join(tmpdir(), 'psd-eoc-retention-docs-'));
    temporaryDirectories.push(root);
    for (const path of [
      'docs/ARCHITECTURE.md',
      'docs/INTEGRATIONS.md',
      'docs/runbooks/go-live.md',
    ]) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      const contents = readFileSync(join(repositoryRoot, path), 'utf8');
      writeFileSync(
        join(root, path),
        path === 'docs/ARCHITECTURE.md'
          ? contents.replace('- `transport-and-operational-copies`\n', '')
          : contents,
      );
    }

    expect(validateRecordsRetentionDocumentation(root)).toContainEqual(
      expect.objectContaining({
        file: 'docs/ARCHITECTURE.md',
        message: expect.stringContaining('records-retention classes differ'),
      }),
    );
  });

  test('rejects a reviewed retention status without a review date', () => {
    const repositoryRoot = join(import.meta.dir, '..');
    const root = mkdtempSync(join(tmpdir(), 'psd-eoc-retention-status-'));
    temporaryDirectories.push(root);
    for (const path of [
      'docs/ARCHITECTURE.md',
      'docs/INTEGRATIONS.md',
      'docs/runbooks/go-live.md',
    ]) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      let contents = readFileSync(join(repositoryRoot, path), 'utf8');
      if (path === 'docs/INTEGRATIONS.md') {
        contents = contents.replace(
          'Controlled mapping review status: `pending`.',
          'Controlled mapping review status: `reviewed`.',
        );
      }
      writeFileSync(join(root, path), contents);
    }

    expect(validateRecordsRetentionDocumentation(root)).toContainEqual(
      expect.objectContaining({
        file: 'docs/INTEGRATIONS.md',
        message: 'records-retention mapping status lacks an honest review date',
      }),
    );
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
