import type { TemplateMode } from '@psd-eoc/contracts';
import type { ReactNode } from 'react';

import { ClassificationIcon } from './classification-icon';

export interface ClassificationBannerProps {
  readonly mode: TemplateMode;
  readonly detail?: ReactNode;
}

const classificationPresentation = {
  real: {
    label: 'REAL INCIDENT',
    defaultDetail:
      'This is a real incident. Staff notifications are not a drill.',
  },
  drill: {
    label: 'DRILL — TRAINING ONLY',
    defaultDetail: 'This is a drill for training. It is not a real incident.',
  },
} as const satisfies Record<
  TemplateMode,
  Readonly<{ label: string; defaultDetail: string }>
>;

export function ClassificationBanner({
  mode,
  detail,
}: ClassificationBannerProps) {
  const presentation = classificationPresentation[mode];

  return (
    <section
      className={`classification-banner classification-banner--${mode}`}
      aria-label={`${presentation.label} classification`}
    >
      <span className="classification-banner__icon" aria-hidden="true">
        <ClassificationIcon mode={mode} />
      </span>
      <div>
        <p className="classification-banner__label">{presentation.label}</p>
        <p className="classification-banner__detail">
          {detail ?? presentation.defaultDetail}
        </p>
      </div>
    </section>
  );
}
