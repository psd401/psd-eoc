import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

const REPOSITORY_ROOT = resolve(import.meta.dir, '..');

export interface DocumentationError {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

export function currentDocumentationViolations(
  repositoryPath: string,
  contents: string,
): string[] {
  const violations: string[] = [];
  if (/\bP\d+\.\d+\b/u.test(contents)) {
    violations.push(
      'current documentation contains an implementation-phase token',
    );
  }
  if (
    repositoryPath !== 'AGENTS.md' &&
    repositoryPath !== 'SECURITY.md' &&
    /(?:338414773271|\bpsd401-prr-prod\b|\beoc\.psd401\.net\b|\bnet\.psd401\.eoc\b|@psd401\.net\b|\bpsd401\.net\b|\bus-west-2\b)/iu.test(
      contents,
    )
  ) {
    violations.push(
      'current documentation hardcodes protected tenant identity',
    );
  }
  if (
    repositoryPath !== 'docs/INTEGRATIONS.md' &&
    /(?:the\s+\w+\s+stack is not deployed|no physical installation exists|\bremains\s+`(?:mocked|blocked|configured-unverified|live-verified)`|\bis currently\s+`(?:mocked|blocked|configured-unverified|live-verified)`|\*\*Status:\s*BLOCKED)/iu.test(
      contents,
    )
  ) {
    violations.push(
      'current documentation duplicates a volatile readiness claim',
    );
  }
  if (
    repositoryPath.startsWith('docs/runbooks/') &&
    /(?:#\d+\s+owns\b|under\s+(?:issue\s+)?#\d+\b|Issue\s+#\d+\s+(?:owns|retired)\b)/u.test(
      contents,
    )
  ) {
    violations.push(
      'current runbook delegates durable behavior to a completed issue',
    );
  }
  if (
    repositoryPath.startsWith('docs/runbooks/') &&
    /(?:\b(?:current|old|older|disabled|enable|control)(?:[ \t-]|\r?\n[ \t]*)+epoch\b|\bemergency[ -]re-enable\b|\bemergency control\b|\bcurrent control (?:state|truth)\b|\bcontrol-entry\b|\bdata\/control-epoch\b|\bnew control entry\b)/iu.test(
      contents,
    )
  ) {
    violations.push(
      'current runbook references the removed notification control gate',
    );
  }
  if (
    /bun run --cwd packages\/server (?:db:migrate|db:seed|dev)\b/u.test(
      contents,
    )
  ) {
    violations.push(
      'current documentation bypasses the pinned synthetic database commands',
    );
  }
  return violations;
}

function headingForAnchor(
  contents: string,
  anchor: string,
): {
  readonly line: number;
  readonly section: string;
} | null {
  const lines = contents.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.startsWith('### ')) continue;
    const heading = `${line}\n`;
    if (!githubAnchors(heading).has(anchor)) continue;
    let end = index + 1;
    while (end < lines.length && !(lines[end] ?? '').startsWith('### ')) {
      end += 1;
    }
    return {
      line: index + 1,
      section: lines.slice(index, end).join('\n'),
    };
  }
  return null;
}

export function validateMonitoringRunbooks(
  repositoryRoot: string,
): DocumentationError[] {
  const monitoringPath = join(repositoryRoot, 'infra', 'src', 'monitoring.ts');
  const runbookIndexPath = join(repositoryRoot, 'infra', 'README.md');
  const monitoring = readFileSync(monitoringPath, 'utf8');
  const runbookIndex = readFileSync(runbookIndexPath, 'utf8');
  const anchors = [
    ...new Set(
      [...monitoring.matchAll(/runbookAnchor:\s*'([^']+)'/gu)]
        .map((match) => match[1])
        .filter((value): value is string => value !== undefined),
    ),
  ].sort();
  const errors: DocumentationError[] = [];
  if (anchors.length === 0) {
    return [
      {
        file: 'infra/src/monitoring.ts',
        line: 1,
        message: 'monitoring source contains no runbook anchors',
      },
    ];
  }
  for (const anchor of anchors) {
    const heading = headingForAnchor(runbookIndex, anchor);
    if (heading === null) {
      errors.push({
        file: 'infra/README.md',
        line: 1,
        message: `monitoring runbook anchor is missing: ${anchor}`,
      });
      continue;
    }
    if (
      !/\]\(\.\.\/docs\/runbooks\/[^)#]+\.md(?:#[^)]+)?\)/u.test(
        heading.section,
      )
    ) {
      errors.push({
        file: 'infra/README.md',
        line: heading.line,
        message: `monitoring runbook anchor has no current procedure link: ${anchor}`,
      });
    }
  }
  return errors;
}

function lineNumber(contents: string, offset: number): number {
  return contents.slice(0, offset).split('\n').length;
}

function currentMarkdownFiles(repositoryRoot: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name === '.git' ||
        entry.name === 'node_modules' ||
        entry.name === '.next'
      ) {
        continue;
      }
      const absolute = join(directory, entry.name);
      const repositoryPath = relative(repositoryRoot, absolute);
      if (entry.isDirectory()) {
        if (repositoryPath === join('docs', 'archive')) {
          const archiveIndex = join(absolute, 'README.md');
          if (existsSync(archiveIndex)) files.push(archiveIndex);
          continue;
        }
        visit(absolute);
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        files.push(absolute);
      }
    }
  };
  visit(repositoryRoot);
  return files.sort();
}

function githubAnchors(contents: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^(?: {0,3})#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match?.[1] === undefined) continue;
    const base = match[1]
      .toLowerCase()
      .replace(/<[^>]+>/gu, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/[\s_]+/gu, '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${String(count)}`);
  }
  return anchors;
}

function isInsideRepository(repositoryRoot: string, target: string): boolean {
  const path = relative(repositoryRoot, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

export function validateMarkdownLinks(
  repositoryRoot: string,
  files: readonly string[],
): DocumentationError[] {
  const errors: DocumentationError[] = [];
  const anchorCache = new Map<string, ReadonlySet<string>>();
  for (const file of files) {
    const contents = readFileSync(file, 'utf8');
    const links = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+['"][^)]*)?\)/gu;
    for (const match of contents.matchAll(links)) {
      let target = match[1] ?? '';
      if (target.startsWith('<') && target.endsWith('>')) {
        target = target.slice(1, -1);
      }
      if (
        /^(?:https?:|mailto:|tel:)/u.test(target) ||
        (target.startsWith('/') && !target.startsWith('//'))
      ) {
        continue;
      }
      const hash = target.indexOf('#');
      const encodedPath = hash === -1 ? target : target.slice(0, hash);
      const encodedFragment = hash === -1 ? '' : target.slice(hash + 1);
      let localPath: string;
      let fragment: string;
      try {
        localPath = decodeURIComponent(encodedPath);
        fragment = decodeURIComponent(encodedFragment).toLowerCase();
      } catch {
        errors.push({
          file: relative(repositoryRoot, file),
          line: lineNumber(contents, match.index ?? 0),
          message: `malformed local link ${target}`,
        });
        continue;
      }
      const absolute =
        localPath.length === 0 ? file : resolve(dirname(file), localPath);
      if (!isInsideRepository(repositoryRoot, absolute)) {
        errors.push({
          file: relative(repositoryRoot, file),
          line: lineNumber(contents, match.index ?? 0),
          message: `local link escapes the repository: ${target}`,
        });
        continue;
      }
      if (!existsSync(absolute)) {
        errors.push({
          file: relative(repositoryRoot, file),
          line: lineNumber(contents, match.index ?? 0),
          message: `local link target does not exist: ${target}`,
        });
        continue;
      }
      if (
        fragment.length > 0 &&
        statSync(absolute).isFile() &&
        extname(absolute).toLowerCase() === '.md'
      ) {
        let anchors = anchorCache.get(absolute);
        if (anchors === undefined) {
          anchors = githubAnchors(readFileSync(absolute, 'utf8'));
          anchorCache.set(absolute, anchors);
        }
        if (!anchors.has(fragment)) {
          errors.push({
            file: relative(repositoryRoot, file),
            line: lineNumber(contents, match.index ?? 0),
            message: `local link fragment does not exist: ${target}`,
          });
        }
      }
    }
  }
  return errors;
}

function readPackageManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
}

function nearestPackageManifest(repositoryRoot: string, file: string): string {
  let directory = dirname(file);
  while (isInsideRepository(repositoryRoot, directory)) {
    const candidate = join(directory, 'package.json');
    if (existsSync(candidate)) return candidate;
    if (directory === repositoryRoot) break;
    directory = dirname(directory);
  }
  return join(repositoryRoot, 'package.json');
}

function validateBunCommands(
  repositoryRoot: string,
  files: readonly string[],
): DocumentationError[] {
  const errors: DocumentationError[] = [];
  for (const file of files) {
    const contents = readFileSync(file, 'utf8');
    const commands =
      /\bbun run(?:\s+--cwd\s+([^\s`\\]+))?\s+([A-Za-z0-9_./:-]+)/gu;
    for (const match of contents.matchAll(commands)) {
      const cwd = match[1];
      const script = match[2];
      if (script === undefined) continue;
      if (script.includes('/') || script.endsWith('.ts')) {
        if (!existsSync(resolve(repositoryRoot, script))) {
          errors.push({
            file: relative(repositoryRoot, file),
            line: lineNumber(contents, match.index ?? 0),
            message: `documented Bun entry point does not exist: ${script}`,
          });
        }
        continue;
      }
      const manifestPath =
        cwd === undefined
          ? nearestPackageManifest(repositoryRoot, file)
          : join(repositoryRoot, cwd, 'package.json');
      const validInSelectedPackage =
        existsSync(manifestPath) &&
        Object.hasOwn(readPackageManifest(manifestPath).scripts ?? {}, script);
      const validAtRoot =
        cwd === undefined &&
        Object.hasOwn(
          readPackageManifest(join(repositoryRoot, 'package.json')).scripts ??
            {},
          script,
        );
      if (!validInSelectedPackage && !validAtRoot) {
        errors.push({
          file: relative(repositoryRoot, file),
          line: lineNumber(contents, match.index ?? 0),
          message: `documented Bun script does not exist: ${match[0]}`,
        });
      }
    }
    const entries = /\bbun\s+(?!run\b)([A-Za-z0-9_./-]+\.ts)\b/gu;
    for (const match of contents.matchAll(entries)) {
      const path = match[1];
      if (path !== undefined && !existsSync(resolve(repositoryRoot, path))) {
        errors.push({
          file: relative(repositoryRoot, file),
          line: lineNumber(contents, match.index ?? 0),
          message: `documented Bun entry point does not exist: ${path}`,
        });
      }
    }
  }
  return errors;
}

export function extractContractList(contents: string, name: string): string[] {
  const start = `<!-- docs-contract:${name}:start -->`;
  const end = `<!-- docs-contract:${name}:end -->`;
  const startOffset = contents.indexOf(start);
  const endOffset = contents.indexOf(end);
  if (startOffset === -1 || endOffset <= startOffset) return [];
  return [
    ...contents
      .slice(startOffset + start.length, endOffset)
      .matchAll(/^- `([^`]+)`\s*$/gmu),
  ]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined)
    .sort();
}

const RECORDS_RETENTION_CLASSES = Object.freeze([
  'audit-and-mutation-evidence',
  'configuration-and-governance',
  'dispatch-and-delivery-evidence',
  'drills-and-delivery-tests',
  'generated-reports-and-exports',
  'identity-device-and-session-lifecycle',
  'media-and-private-objects',
  'notification-content-and-authorization',
  'operational-events-and-lifecycle',
  'operational-journal',
  'roster-and-recipient-snapshots',
  'transport-and-operational-copies',
]);

const RECORDS_RETENTION_SOURCE_URLS = Object.freeze([
  'https://www.sos.wa.gov/sites/default/files/2025-06/local-government-common-records-retention-schedule-CORE.PDF',
  'https://www.sos.wa.gov/sites/default/files/2026-06/Public-Schools-%28K-12%29-Records-Retention-Schedule.PDF',
  'https://www.sos.wa.gov/archives/help-government-agencies/managing-school-and-esd-records',
]);

const RECORDS_RETENTION_POLICY = Object.freeze([
  'automated-disposition: prohibited',
  'down-migrations: prohibited',
  'record-retention: all',
]);

const MINIMUM_RECORDS_RETENTION_SOURCE_CHECK_DATE = '2026-08-25';

function recordsRetentionError(
  file: string,
  contents: string,
  message: string,
  token = '<!-- psd-eoc:records-retention:start -->',
): DocumentationError {
  const offset = contents.indexOf(token);
  return {
    file,
    line: offset === -1 ? 1 : lineNumber(contents, offset),
    message,
  };
}

function normalizedDocumentationText(contents: string): string {
  return contents
    .replace(/([A-Za-z])-\s+([a-z])/gu, '$1-$2')
    .replace(/\s+/gu, ' ');
}

function occurrenceCount(contents: string, token: string): number {
  return contents.split(token).length - 1;
}

function boundedDocumentationSection(
  contents: string,
  start: string,
  end: string,
): string | null {
  if (
    occurrenceCount(contents, start) !== 1 ||
    occurrenceCount(contents, end) !== 1
  ) {
    return null;
  }
  const startOffset = contents.indexOf(start) + start.length;
  const endOffset = contents.indexOf(end);
  return endOffset > startOffset
    ? contents.slice(startOffset, endOffset)
    : null;
}

function uniqueCapture(contents: string, pattern: RegExp): string | undefined {
  const matches = [...contents.matchAll(pattern)];
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

function isRealIsoDate(value: string | undefined): value is string {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 'YYYY-MM-DD'.length) === value
  );
}

/**
 * Keeps the public repository's retention guidance complete and tenant-neutral.
 * The tenant's reviewed DAN mapping remains a controlled operations record.
 */
export function validateRecordsRetentionDocumentation(
  repositoryRoot: string,
): DocumentationError[] {
  const architectureFile = 'docs/ARCHITECTURE.md';
  const integrationsFile = 'docs/INTEGRATIONS.md';
  const goLiveFile = 'docs/runbooks/go-live.md';
  const architecture = readFileSync(
    join(repositoryRoot, architectureFile),
    'utf8',
  );
  const integrations = readFileSync(
    join(repositoryRoot, integrationsFile),
    'utf8',
  );
  const goLive = readFileSync(join(repositoryRoot, goLiveFile), 'utf8');
  const normalizedGoLive = normalizedDocumentationText(goLive);
  const errors: DocumentationError[] = [];

  const architectureStart = '<!-- psd-eoc:records-retention:start -->';
  const architectureEnd = '<!-- psd-eoc:records-retention:end -->';
  const reviewStart = '<!-- psd-eoc:records-retention-review-status:start -->';
  const reviewEnd = '<!-- psd-eoc:records-retention-review-status:end -->';
  const currentDocuments = currentMarkdownFiles(repositoryRoot).map((file) =>
    readFileSync(file, 'utf8'),
  );
  const currentMarkerCount = (marker: string): number =>
    currentDocuments.reduce(
      (count, contents) => count + occurrenceCount(contents, marker),
      0,
    );
  const architectureSection = boundedDocumentationSection(
    architecture,
    architectureStart,
    architectureEnd,
  );
  const reviewSection = boundedDocumentationSection(
    integrations,
    reviewStart,
    reviewEnd,
  );
  if (
    architectureSection === null ||
    currentMarkerCount(architectureStart) !== 1 ||
    currentMarkerCount(architectureEnd) !== 1
  ) {
    errors.push(
      recordsRetentionError(
        architectureFile,
        architecture,
        'expected one bounded current records-retention section',
      ),
    );
  }
  if (
    reviewSection === null ||
    currentMarkerCount(reviewStart) !== 1 ||
    currentMarkerCount(reviewEnd) !== 1
  ) {
    errors.push(
      recordsRetentionError(
        integrationsFile,
        integrations,
        'expected one bounded records-retention review-status section',
        reviewStart,
      ),
    );
  }
  const retentionGuidance = architectureSection ?? '';
  const retentionReview = reviewSection ?? '';
  const normalizedArchitecture = normalizedDocumentationText(retentionGuidance);
  const normalizedIntegrations = normalizedDocumentationText(retentionReview);

  for (const contract of [
    'records-retention-classes',
    'records-retention-policy',
  ]) {
    if (
      occurrenceCount(
        architecture,
        `<!-- docs-contract:${contract}:start -->`,
      ) !== 1 ||
      occurrenceCount(
        architecture,
        `<!-- docs-contract:${contract}:end -->`,
      ) !== 1
    ) {
      errors.push(
        recordsRetentionError(
          architectureFile,
          architecture,
          `expected one bounded ${contract} contract`,
        ),
      );
    }
  }

  const documentedClasses = extractContractList(
    architecture,
    'records-retention-classes',
  );
  if (
    JSON.stringify(documentedClasses) !==
    JSON.stringify([...RECORDS_RETENTION_CLASSES].sort())
  ) {
    errors.push(
      recordsRetentionError(
        architectureFile,
        architecture,
        `records-retention classes differ: documented=${documentedClasses.join(',')} actual=${RECORDS_RETENTION_CLASSES.join(',')}`,
      ),
    );
  }

  const documentedPolicy = extractContractList(
    architecture,
    'records-retention-policy',
  );
  if (
    JSON.stringify(documentedPolicy) !==
    JSON.stringify([...RECORDS_RETENTION_POLICY].sort())
  ) {
    errors.push(
      recordsRetentionError(
        architectureFile,
        architecture,
        `records-retention policy differs: documented=${documentedPolicy.join(',')} actual=${RECORDS_RETENTION_POLICY.join(',')}`,
      ),
    );
  }

  for (const sourceUrl of RECORDS_RETENTION_SOURCE_URLS) {
    if (!retentionGuidance.includes(sourceUrl)) {
      errors.push(
        recordsRetentionError(
          architectureFile,
          architecture,
          `records-retention guidance is missing official source: ${sourceUrl}`,
        ),
      );
    }
  }
  for (const [description, pattern] of [
    [
      'CORE v5.0 and its October 2, 2024 approval/effective date',
      /CORE[\s\S]{0,240}version 5\.0[\s\S]{0,160}October 2, 2024/iu,
    ],
    [
      'Public Schools (K-12) v9.1 and its June 3, 2026 approval/effective date',
      /Public Schools \(K-12\)[\s\S]{0,240}version 9\.1[\s\S]{0,160}approved and effective June 3, 2026/iu,
    ],
  ] as const) {
    if (!pattern.test(retentionGuidance)) {
      errors.push(
        recordsRetentionError(
          architectureFile,
          architecture,
          `records-retention guidance is missing ${description}`,
        ),
      );
    }
  }

  for (const required of [
    'GS2017-016 Rev. 0',
    'GS2012-025 Rev. 1',
    'GS50-18-29 Rev. 2',
    'GS2010-008 Rev. 2',
    'SD2011-153 Rev. 1',
    'routine/minor',
    'uncommon/major',
    'notification documentation',
    'mixed-content',
    'The product does not own a school-safety-plan record class',
    'reasonably anticipated litigation',
    'active public-records request',
    'archival appraisal',
    'district-controlled operations record',
    'This guidance authorizes none of the following: deletion, purge, a retention timer, a lifecycle rule, a down migration, or automated disposition',
    'CORE v5.1 and K-12 v9.2 are non-authoritative draft revisions',
  ]) {
    if (!normalizedArchitecture.includes(required)) {
      errors.push(
        recordsRetentionError(
          architectureFile,
          architecture,
          `records-retention guidance is missing required statement: ${required}`,
        ),
      );
    }
  }

  const architectureSourceCheckDate = uniqueCapture(
    retentionGuidance,
    /official sources were rechecked on (\d{4}-\d{2}-\d{2}):/giu,
  );
  const status = uniqueCapture(
    integrations,
    /^- Controlled mapping review status: `([^`]+)`\.$/gmu,
  );
  const reviewDate = uniqueCapture(
    integrations,
    /^- Controlled mapping review date: `([^`]+)`\.$/gmu,
  );
  const sourceCheckDate = uniqueCapture(
    integrations,
    /^- Official sources last rechecked: `(\d{4}-\d{2}-\d{2})`\.$/gmu,
  );
  if (status !== 'pending' && status !== 'reviewed') {
    errors.push(
      recordsRetentionError(
        integrationsFile,
        integrations,
        'records-retention mapping status must occur once and be pending or reviewed',
        reviewStart,
      ),
    );
  }
  const reviewDateIsHonest =
    (status === 'pending' && reviewDate === 'not completed') ||
    (status === 'reviewed' &&
      isRealIsoDate(reviewDate) &&
      isRealIsoDate(sourceCheckDate) &&
      reviewDate >= sourceCheckDate);
  const pendingEvidence = normalizedIntegrations.includes(
    'No completed records-officer review or ambiguity guidance has been supplied',
  );
  if (
    !reviewDateIsHonest ||
    (status === 'pending' && !pendingEvidence) ||
    (status === 'reviewed' &&
      (pendingEvidence || normalizedIntegrations.includes('pending')))
  ) {
    errors.push(
      recordsRetentionError(
        integrationsFile,
        integrations,
        'records-retention mapping status, date, and evidence are inconsistent',
        reviewStart,
      ),
    );
  }
  if (
    !isRealIsoDate(architectureSourceCheckDate) ||
    !isRealIsoDate(sourceCheckDate) ||
    architectureSourceCheckDate < MINIMUM_RECORDS_RETENTION_SOURCE_CHECK_DATE ||
    architectureSourceCheckDate !== sourceCheckDate
  ) {
    errors.push(
      recordsRetentionError(
        integrationsFile,
        integrations,
        'records-retention official-source dates are invalid, stale, duplicated, or inconsistent',
        reviewStart,
      ),
    );
  }
  if (!normalizedIntegrations.includes('retain every product record')) {
    errors.push(
      recordsRetentionError(
        integrationsFile,
        integrations,
        'readiness register lacks aggregate retention review evidence and the retain-everything boundary',
        reviewStart,
      ),
    );
  }

  const normalizedRetentionDocuments = `${normalizedArchitecture} ${normalizedIntegrations} ${normalizedGoLive}`;
  for (const contradiction of [
    /\bdo not retain every product record\b/iu,
    /\b(?:automated disposition|disposition automation) (?:is|becomes|remains)(?: now)? (?:enabled|allowed|authorized)\b/iu,
  ]) {
    if (contradiction.test(normalizedRetentionDocuments)) {
      errors.push(
        recordsRetentionError(
          architectureFile,
          architecture,
          'records-retention guidance contradicts the retain-everything policy',
        ),
      );
    }
  }

  for (const required of [
    '../ARCHITECTURE.md#records-retention-classification',
    'does not block launch while every product record remains retained and automated disposition remains absent',
    'blocks any later disposition design',
  ]) {
    if (!normalizedGoLive.includes(required)) {
      errors.push(
        recordsRetentionError(
          goLiveFile,
          goLive,
          `go-live procedure is missing the retention boundary: ${required}`,
          '# Go-live procedure',
        ),
      );
    }
  }
  return errors;
}

function compareNames(
  errors: DocumentationError[],
  documented: readonly string[],
  actual: readonly string[],
  label: string,
): void {
  const expected = [...new Set(actual)].sort();
  const received = [...new Set(documented)].sort();
  if (JSON.stringify(expected) !== JSON.stringify(received)) {
    errors.push({
      file: 'docs/CONFIGURATION.md',
      line: 1,
      message: `${label} differ: documented=${received.join(',')} actual=${expected.join(',')}`,
    });
  }
}

function verifyContracts(repositoryRoot: string): DocumentationError[] {
  const errors: DocumentationError[] = [];
  const configuration = readFileSync(
    join(repositoryRoot, 'docs', 'CONFIGURATION.md'),
    'utf8',
  );
  const cdk = JSON.parse(
    readFileSync(join(repositoryRoot, 'infra', 'cdk.json'), 'utf8'),
  ) as { readonly context?: Readonly<Record<string, unknown>> };
  compareNames(
    errors,
    extractContractList(configuration, 'cdk-context'),
    Object.keys(cdk.context ?? {}).filter((key) => key.startsWith('psdEoc:')),
    'CDK context names',
  );

  const workflow = readFileSync(
    join(repositoryRoot, '.github', 'workflows', 'deploy.yml'),
    'utf8',
  );
  const captured = (pattern: RegExp): string[] =>
    [...workflow.matchAll(pattern)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
  compareNames(
    errors,
    extractContractList(configuration, 'workflow-vars'),
    captured(/\$\{\{\s*vars\.([A-Z0-9_]+)\s*\}\}/gu),
    'deploy workflow variable names',
  );
  compareNames(
    errors,
    extractContractList(configuration, 'workflow-secrets'),
    captured(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/gu),
    'deploy workflow secret names',
  );
  const dispatch = workflow.slice(
    workflow.indexOf('  workflow_dispatch:'),
    workflow.indexOf('\npermissions:'),
  );
  compareNames(
    errors,
    extractContractList(configuration, 'workflow-inputs'),
    [...dispatch.matchAll(/^ {6}([a-z][a-z0-9_]+):\s*$/gmu)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined),
    'deploy workflow input names',
  );
  compareNames(
    errors,
    extractContractList(configuration, 'workflow-parameters'),
    captured(/--parameters\s+"\$STACK_NAME:([A-Za-z0-9]+)=/gu),
    'deploy workflow CloudFormation parameter names',
  );
  return errors;
}

function verifyInformationArchitecture(
  repositoryRoot: string,
  files: readonly string[],
): DocumentationError[] {
  const errors: DocumentationError[] = [];
  const documents = files.map((file) => ({
    absolute: file,
    contents: readFileSync(file, 'utf8'),
    path: relative(repositoryRoot, file),
  }));
  for (const document of documents) {
    for (const message of currentDocumentationViolations(
      document.path,
      document.contents,
    )) {
      errors.push({ file: document.path, line: 1, message });
    }
  }
  const readinessMarkers = documents.reduce(
    (count, document) =>
      count +
      (document.contents.match(/<!-- psd-eoc:readiness-register -->/gu)
        ?.length ?? 0),
    0,
  );
  if (readinessMarkers !== 1) {
    errors.push({
      file: 'docs/INTEGRATIONS.md',
      line: 1,
      message: `expected one current readiness register marker; found ${String(readinessMarkers)}`,
    });
  }

  for (const document of documents) {
    if (
      document.path.startsWith(`docs${sep}runbooks${sep}`) &&
      document.path !== join('docs', 'runbooks', 'README.md') &&
      !document.contents.includes('../INTEGRATIONS.md')
    ) {
      errors.push({
        file: document.path,
        line: 1,
        message:
          'current runbook must link to the operational readiness register',
      });
    }
    if (
      document.path.startsWith(`docs${sep}runbooks${sep}`) &&
      /^(?:\*\*(?:Current truth|Deployment\/read-back truth)|## Current (?:status|readiness truth))/mu.test(
        document.contents,
      )
    ) {
      errors.push({
        file: document.path,
        line: 1,
        message: 'runbooks must not duplicate current readiness declarations',
      });
    }
    if (
      document.path.startsWith(`docs${sep}runbooks${sep}`) &&
      /(?:\bcurrently\s+`?blocked|\*\*BLOCKED BY\b|no such deployed tool exists today|no approved deploy(?:ment)? workflow|not documented or deployed, so[^.]*\*\*BLOCKED)/iu.test(
        document.contents,
      )
    ) {
      errors.push({
        file: document.path,
        line: 1,
        message: 'runbook contains a dated readiness claim',
      });
    }
  }

  for (const path of [
    'docs/archive/PLAN.md',
    'docs/archive/CODEX_GOALS.md',
    'docs/archive/discovery/DECISION_LOG.md',
    'docs/archive/evidence/live-pilot.md',
    'docs/archive/infrastructure/gcp-README-2026-08-25.md',
    'docs/archive/runbooks/appstore-setup-2026-08-25.md',
    'docs/archive/runbooks/email-setup-2026-08-25.md',
    'docs/archive/runbooks/sms-registration-2026-08-25.md',
  ]) {
    if (!existsSync(join(repositoryRoot, path))) {
      errors.push({
        file: path,
        line: 1,
        message: 'archived record is missing',
      });
    }
  }
  const archiveIndex = readFileSync(
    join(repositoryRoot, 'docs', 'archive', 'README.md'),
    'utf8',
  );
  for (const indexed of [
    'PLAN.md',
    'CODEX_GOALS.md',
    'discovery/DECISION_LOG.md',
    'infrastructure/gcp-README-2026-08-25.md',
    'runbooks/appstore-setup-2026-08-25.md',
    'runbooks/email-setup-2026-08-25.md',
    'runbooks/sms-registration-2026-08-25.md',
  ]) {
    if (!archiveIndex.includes(indexed)) {
      errors.push({
        file: 'docs/archive/README.md',
        line: 1,
        message: `archive index does not include ${indexed}`,
      });
    }
  }

  for (const path of [
    'README.md',
    'CLAUDE.md',
    '.github/pull_request_template.md',
  ]) {
    const contents = readFileSync(join(repositoryRoot, path), 'utf8');
    if (!contents.includes('bun run check')) {
      errors.push({
        file: path,
        line: 1,
        message: 'contributor entry point must name bun run check',
      });
    }
    if (/only files owned by|work only the .*issue/iu.test(contents)) {
      errors.push({
        file: path,
        line: 1,
        message: 'contributor guidance contradicts the adjacent-fix policy',
      });
    }
  }

  const mcpResources = readFileSync(
    join(repositoryRoot, 'packages', 'mcp', 'src', 'resources.ts'),
    'utf8',
  );
  if (/docs\/(?:PLAN|CODEX_GOALS)|docs\/archive/u.test(mcpResources)) {
    errors.push({
      file: 'packages/mcp/src/resources.ts',
      line: 1,
      message:
        'MCP current resources must not expose archived planning records',
    });
  }

  for (const path of [
    'packages/contracts',
    'packages/server',
    'packages/mobile',
    'packages/mcp',
    'workers',
    'infra',
    'scripts',
  ]) {
    if (!existsSync(join(repositoryRoot, path))) {
      errors.push({
        file: 'docs/ARCHITECTURE.md',
        line: 1,
        message: `documented package path does not exist: ${path}`,
      });
    }
  }
  return errors;
}

export function verifyDocumentation(
  repositoryRoot: string = REPOSITORY_ROOT,
): DocumentationError[] {
  const root = resolve(repositoryRoot);
  const files = currentMarkdownFiles(root);
  return [
    ...validateMarkdownLinks(root, files),
    ...validateBunCommands(root, files),
    ...validateMonitoringRunbooks(root),
    ...validateRecordsRetentionDocumentation(root),
    ...verifyContracts(root),
    ...verifyInformationArchitecture(root, files),
  ].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.message.localeCompare(right.message),
  );
}

if (import.meta.main) {
  const errors = verifyDocumentation();
  if (errors.length === 0) {
    console.info('Documentation contract is valid.');
  } else {
    for (const error of errors) {
      console.error(`${error.file}:${String(error.line)}: ${error.message}`);
    }
    process.exitCode = 1;
  }
}
