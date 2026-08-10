import type { TemplateMode } from '@psd-eoc/contracts';

interface ClassificationIconProps {
  readonly mode: TemplateMode;
}

/** Decorative shape paired with an always-visible classification label. */
export function ClassificationIcon({ mode }: ClassificationIconProps) {
  return mode === 'real' ? (
    <svg
      className="classification-icon"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="M12 2 23 22H1L12 2Z" fill="currentColor" />
      <path d="M11 8h2v7h-2V8Zm0 9h2v2h-2v-2Z" fill="white" />
    </svg>
  ) : (
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
