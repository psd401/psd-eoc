import {
  getEventClassificationPresentation,
  type EventKind,
  type TemplateMode,
} from '@psd-eoc/contracts';

interface ClassificationIconProps {
  readonly kind?: EventKind;
  readonly mode: TemplateMode;
}

/** Decorative shape paired with an always-visible classification label. */
export function ClassificationIcon({ kind, mode }: ClassificationIconProps) {
  const classification = getEventClassificationPresentation({
    kind: kind ?? (mode === 'real' ? 'incident' : 'drill'),
    templateMode: mode,
  });
  if (classification.icon.name === 'warning') {
    return (
      <svg
        className="classification-icon"
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
      >
        <path d="M12 2 23 22H1L12 2Z" fill="currentColor" />
        <path d="M11 8h2v7h-2V8Zm0 9h2v2h-2v-2Z" fill="white" />
      </svg>
    );
  }
  if (classification.icon.name === 'practice-pencil') {
    return (
      <svg
        className="classification-icon"
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
      >
        <path
          d="m5 16-1 4 4-1L19 8l-3-3L5 16Zm9-9 3 3M4 21h16"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      </svg>
    );
  }
  return (
    <svg
      className="classification-icon"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path
        d="M12 2 22 12 12 22 2 12 12 2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
      />
    </svg>
  );
}
