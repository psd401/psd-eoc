import type {
  EventTypeDraftListItem,
  EventTypeVersion,
  EventTypeVersionDraft,
  MessageTemplateCatalog,
  NotificationChannel,
  NotificationPurpose,
  TemplateMode,
} from '@psd-eoc/contracts';

/**
 * Presentation for the human half of "an agent drafts, a human publishes":
 * the list of drafts waiting for review, who proposed each one, and a
 * field-by-field comparison of a draft against the published version it was
 * based on. Nothing here talks to the server; the editor owns that.
 */

const PURPOSES = [
  'activation',
  'all-clear',
  'reactivation',
] as const satisfies readonly NotificationPurpose[];

const PURPOSE_LABELS = {
  activation: 'Activation',
  'all-clear': 'All-clear',
  reactivation: 'Reactivation',
} as const satisfies Record<NotificationPurpose, string>;

const CHANNEL_FIELDS = [
  ['push', 'title', 'Push lock-screen title'],
  ['push', 'body', 'Push lock-screen body'],
  ['sms', 'body', 'SMS body'],
  ['email', 'subject', 'Email subject'],
  ['email', 'textBody', 'Email body'],
] as const satisfies readonly (readonly [
  NotificationChannel,
  'body' | 'subject' | 'textBody' | 'title',
  string,
])[];

/** Beyond this many words a field is compared whole rather than word by word. */
const MAX_WORD_DIFF_TOKENS = 600;
/**
 * A sentence rewritten end to end still shares a few words with the old one,
 * and a word-by-word result then alternates removed and added fragments that
 * neither a sighted reader nor a screen reader can follow. Past this many
 * change runs with under half the words shared, the field is shown whole.
 */
const MAX_INTERLEAVED_CHANGES = 4;

function modeLabel(mode: TemplateMode): string {
  return mode === 'real' ? 'REAL INCIDENT' : 'DRILL — TRAINING ONLY';
}

function modeMarker(mode: TemplateMode): string {
  return mode === 'real' ? '[INCIDENT]' : '[DRILL]';
}

/** What a reviewer reads as a draft's author; never a bare UUID alone. */
export function draftAuthorLabel(
  item: Pick<EventTypeDraftListItem, 'author' | 'draftedBy'>,
): string {
  if (item.author.kind === 'human') {
    return item.author.displayName ?? 'A staff account no longer on record';
  }
  const agentName =
    item.author.agentDisplayName ?? 'an agent no longer on record';
  const key =
    item.author.key === null
      ? 'a key no longer on record'
      : `key ${item.author.key.displayName} (${item.author.key.keyPrefix}…)`;
  return `Agent ${agentName} via ${key}`;
}

/** Published version the draft can be compared with, as the reviewer reads it. */
export function draftBaseLabel(
  item: Pick<EventTypeDraftListItem, 'baseVersionId' | 'baseVersionNumber'>,
  current: Readonly<{ id: string; version: number }> | null,
): string {
  if (item.baseVersionId === null || item.baseVersionNumber === null) {
    return 'New response; nothing published yet';
  }
  if (current === null) {
    return `Version ${item.baseVersionNumber}`;
  }
  if (current.id === item.baseVersionId) {
    return `Version ${item.baseVersionNumber} (current)`;
  }
  return `Version ${item.baseVersionNumber}; version ${current.version} is now current, so this draft must be re-based before it can publish`;
}

export function DraftReviewList({
  drafts,
  currentVersions,
  selectedDraftId,
  onReview,
  disabled = false,
}: Readonly<{
  drafts: readonly EventTypeDraftListItem[];
  /** Latest published version per event-type ID, where the page knows it. */
  currentVersions: ReadonlyMap<
    string,
    Readonly<{ id: string; version: number }>
  >;
  selectedDraftId: string | null;
  onReview: (draft: EventTypeDraftListItem) => void;
  disabled?: boolean;
}>) {
  return (
    <section className="panel drafts-panel" aria-labelledby="drafts-heading">
      <h2 id="drafts-heading">Drafts awaiting review</h2>
      <p className="field-help">
        Every unpublished draft on the server, newest first, including wording
        an agent proposed through the API. Reviewing a draft loads its exact
        wording, the three channel previews, and a comparison with the published
        version it was based on. Nothing is sent to staff until an administrator
        publishes.
      </p>
      {drafts.length === 0 ? (
        <p className="muted">No drafts are waiting for review.</p>
      ) : (
        <table className="drafts-table">
          <caption className="visually-hidden">
            Unpublished drafts awaiting review, newest first
          </caption>
          <thead>
            <tr>
              <th scope="col">Response</th>
              <th scope="col">Mode</th>
              <th scope="col">Drafted by</th>
              <th scope="col">Started</th>
              <th scope="col">Based on</th>
              <th scope="col">
                <span className="visually-hidden">Review</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {drafts.map((draft) => {
              const selected = draft.id === selectedDraftId;
              return (
                <tr
                  key={draft.id}
                  aria-current={selected ? 'true' : undefined}
                  className={selected ? 'selected' : undefined}
                >
                  <th scope="row">{draft.name}</th>
                  <td>
                    <span className={`mode-pill ${draft.templateMode}`}>
                      {draft.templateMode === 'real' ? 'REAL' : 'DRILL'}
                    </span>
                  </td>
                  <td className="draft-author">{draftAuthorLabel(draft)}</td>
                  <td>
                    <time dateTime={draft.createdAt} suppressHydrationWarning>
                      {new Intl.DateTimeFormat(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(new Date(draft.createdAt))}
                    </time>
                  </td>
                  <td>
                    {draftBaseLabel(
                      draft,
                      currentVersions.get(draft.eventTypeId) ?? null,
                    )}
                  </td>
                  <td>
                    <button
                      aria-pressed={selected}
                      className="secondary"
                      disabled={disabled}
                      onClick={() => onReview(draft)}
                      type="button"
                    >
                      {selected ? 'Reviewing' : 'Review'}
                      <span className="visually-hidden">
                        {' '}
                        {draft.name} drafted by {draftAuthorLabel(draft)}
                      </span>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

export type DiffSegment = Readonly<{
  kind: 'same' | 'removed' | 'added';
  text: string;
}>;

/**
 * Word-level comparison of two wordings. Whitespace runs are kept as tokens so
 * the result re-joins to the exact original text. Longest-common-subsequence
 * over words is quadratic, so very long fields fall back to one removed run
 * followed by one added run rather than stalling the page.
 */
export function wordDiff(
  before: string,
  after: string,
): readonly DiffSegment[] {
  if (before === after) {
    return before.length === 0 ? [] : [{ kind: 'same', text: before }];
  }
  const left = before.split(/(\s+)/u).filter((token) => token.length > 0);
  const right = after.split(/(\s+)/u).filter((token) => token.length > 0);
  if (
    left.length > MAX_WORD_DIFF_TOKENS ||
    right.length > MAX_WORD_DIFF_TOKENS
  ) {
    return [
      ...(before.length === 0
        ? []
        : [{ kind: 'removed', text: before } as const]),
      ...(after.length === 0 ? [] : [{ kind: 'added', text: after } as const]),
    ];
  }
  const table: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        left[i] === right[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const segments: Array<{ kind: DiffSegment['kind']; text: string }> = [];
  const push = (kind: DiffSegment['kind'], text: string): void => {
    const last = segments.at(-1);
    if (last?.kind === kind) {
      last.text += text;
    } else {
      segments.push({ kind, text });
    }
  };
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      push('same', left[i]!);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      push('removed', left[i]!);
      i += 1;
    } else {
      push('added', right[j]!);
      j += 1;
    }
  }
  while (i < left.length) push('removed', left[i++]!);
  while (j < right.length) push('added', right[j++]!);
  const changeRuns = segments.filter((segment) => segment.kind !== 'same');
  const sharedWords = segments
    .filter((segment) => segment.kind === 'same')
    .flatMap((segment) => segment.text.split(/\s+/u))
    .filter((word) => word.length > 0).length;
  const longestSide = Math.max(
    left.filter((token) => token.trim().length > 0).length,
    right.filter((token) => token.trim().length > 0).length,
  );
  if (
    changeRuns.length > MAX_INTERLEAVED_CHANGES &&
    sharedWords * 2 < longestSide
  ) {
    return [
      { kind: 'removed', text: before },
      { kind: 'added', text: after },
    ];
  }
  return segments;
}

export interface TemplateFieldComparison {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly before: string | null;
  readonly after: string;
  readonly changed: boolean;
}

function fieldText(
  catalog: MessageTemplateCatalog,
  purpose: NotificationPurpose,
  channel: NotificationChannel,
  field: 'body' | 'subject' | 'textBody' | 'title',
): string {
  const template = catalog[purpose][channel];
  switch (template.channel) {
    case 'push':
      return field === 'title' ? template.title : template.body;
    case 'email':
      return field === 'subject' ? template.subject : template.textBody;
    case 'sms':
      return template.body;
  }
}

/**
 * Every independently visible field of a draft beside the same field of the
 * version it was based on. With no base, everything is new and `before` is
 * null. Mode and classification markers are not compared: they are immutable
 * and the renderer, not the wording, supplies them.
 */
export function compareDraftToBase(
  draft: Pick<
    EventTypeVersionDraft,
    'description' | 'enabled' | 'name' | 'templates'
  >,
  base: Pick<
    EventTypeVersion,
    'description' | 'enabled' | 'name' | 'templates'
  > | null,
): readonly TemplateFieldComparison[] {
  const availability = (enabled: boolean): string =>
    enabled
      ? 'Available for new activations'
      : 'Not available for new activations';
  const compare = (
    id: string,
    group: string,
    label: string,
    before: string | null,
    after: string,
  ): TemplateFieldComparison => ({
    id,
    group,
    label,
    before,
    after,
    changed: before === null || before !== after,
  });
  return [
    compare('name', 'Response', 'Display name', base?.name ?? null, draft.name),
    compare(
      'description',
      'Response',
      'Description',
      base === null ? null : (base.description ?? ''),
      draft.description ?? '',
    ),
    compare(
      'enabled',
      'Response',
      'Availability',
      base === null ? null : availability(base.enabled),
      availability(draft.enabled),
    ),
    ...PURPOSES.flatMap((purpose) =>
      CHANNEL_FIELDS.map(([channel, field, label]) =>
        compare(
          `${purpose}-${channel}-${field}`,
          `${PURPOSE_LABELS[purpose]} messages`,
          label,
          base === null
            ? null
            : fieldText(base.templates, purpose, channel, field),
          fieldText(draft.templates, purpose, channel, field),
        ),
      ),
    ),
  ];
}

function Wording({
  comparison,
}: Readonly<{ comparison: TemplateFieldComparison }>) {
  if (!comparison.changed) {
    return <span className="diff-same">{comparison.after}</span>;
  }
  if (comparison.before === null) {
    return (
      <ins className="diff-added">
        <span className="visually-hidden">New wording: </span>
        {comparison.after}
      </ins>
    );
  }
  return (
    <>
      {wordDiff(comparison.before, comparison.after).map((segment, index) => {
        const key = `${segment.kind}-${index}`;
        switch (segment.kind) {
          case 'same':
            return (
              <span className="diff-same" key={key}>
                {segment.text}
              </span>
            );
          case 'removed':
            return (
              <del className="diff-removed" key={key}>
                <span className="visually-hidden">Removed: </span>
                {segment.text}
              </del>
            );
          case 'added':
            return (
              <ins className="diff-added" key={key}>
                <span className="visually-hidden">Added: </span>
                {segment.text}
              </ins>
            );
        }
      })}
    </>
  );
}

export function TemplateDiff({
  draft,
  base,
  baseVersionNumber,
}: Readonly<{
  draft: Pick<
    EventTypeVersionDraft,
    | 'baseVersionId'
    | 'description'
    | 'enabled'
    | 'name'
    | 'templateMode'
    | 'templates'
  >;
  /** The published version the draft was based on; null while it loads or when there is none. */
  base: Pick<
    EventTypeVersion,
    'description' | 'enabled' | 'id' | 'name' | 'templates' | 'version'
  > | null;
  baseVersionNumber?: number | null;
}>) {
  const comparisons = compareDraftToBase(draft, base);
  const changed = comparisons.filter((comparison) => comparison.changed);
  const groups = [
    ...new Set(comparisons.map((comparison) => comparison.group)),
  ];
  const waitingForBase = draft.baseVersionId !== null && base === null;
  const versionLabel =
    base === null
      ? baseVersionNumber == null
        ? 'the published version'
        : `published version ${baseVersionNumber}`
      : `published version ${base.version}`;
  return (
    <section className="diff-section" aria-labelledby="diff-heading">
      <h3 id="diff-heading">Changes against {versionLabel}</h3>
      <p className={`mode-banner ${draft.templateMode}`}>
        {modeLabel(draft.templateMode)} WORDING — every rendered field keeps the{' '}
        {modeMarker(draft.templateMode)} marker
      </p>
      {waitingForBase ? (
        <p role="status">Loading {versionLabel} for comparison…</p>
      ) : (
        <p className="diff-summary" role="status">
          {draft.baseVersionId === null
            ? `No published version to compare against; all ${String(comparisons.length)} fields are new.`
            : changed.length === 0
              ? `No wording differs from ${versionLabel}.`
              : `${String(changed.length)} of ${String(comparisons.length)} fields differ from ${versionLabel}. Removed words are struck through; added words are underlined.`}
        </p>
      )}
      {groups.map((group) => (
        <table className="diff-table" key={group}>
          <caption>{group}</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Status</th>
              <th scope="col">Wording</th>
            </tr>
          </thead>
          <tbody>
            {comparisons
              .filter((comparison) => comparison.group === group)
              .map((comparison) => (
                <tr
                  className={comparison.changed ? 'changed' : undefined}
                  data-field={comparison.id}
                  key={comparison.id}
                >
                  <th scope="row">{comparison.label}</th>
                  <td className="diff-status">
                    {waitingForBase
                      ? 'Pending'
                      : comparison.before === null
                        ? 'New'
                        : comparison.changed
                          ? 'Changed'
                          : 'Unchanged'}
                  </td>
                  <td className="diff-wording">
                    {waitingForBase ? (
                      <span className="diff-same">{comparison.after}</span>
                    ) : (
                      <Wording comparison={comparison} />
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      ))}
    </section>
  );
}
