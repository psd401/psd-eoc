import {
  getEventClassificationPresentation,
  type EventKind,
  type TemplateMode,
} from '@psd-eoc/contracts';
import type { CSSProperties, ReactNode } from 'react';

import { ClassificationIcon } from './classification-icon';

export interface ClassificationBannerProps {
  readonly kind?: EventKind;
  readonly mode: TemplateMode;
  readonly detail?: ReactNode;
}

export function ClassificationBanner({
  kind,
  mode,
  detail,
}: ClassificationBannerProps) {
  const presentation = getEventClassificationPresentation({
    kind: kind ?? (mode === 'real' ? 'incident' : 'drill'),
    templateMode: mode,
  });
  const style = {
    '--classification-banner-background': presentation.colors.bannerBackground,
    '--classification-banner-border': presentation.colors.border,
    '--classification-banner-foreground': presentation.colors.onBanner,
  } as CSSProperties;

  return (
    <section
      className={`classification-banner classification-banner--${mode} classification-banner--${presentation.kind}`}
      aria-label={`${presentation.label} classification`}
      style={style}
    >
      <span className="classification-banner__icon" aria-hidden="true">
        <ClassificationIcon kind={presentation.kind} mode={mode} />
      </span>
      <div>
        <p className="classification-banner__label">{presentation.label}</p>
        <p className="classification-banner__detail">
          {detail ?? presentation.explanation}
        </p>
      </div>
    </section>
  );
}
