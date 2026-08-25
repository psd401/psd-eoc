'use client';

import { EVENT_CLASSIFICATION_PRESENTATIONS } from '@psd-eoc/contracts';

export function DialogClassification({
  label,
  real,
}: Readonly<{ label: string; real: boolean }>) {
  const test = label === EVENT_CLASSIFICATION_PRESENTATIONS.test.label;
  return (
    <p
      className={`dialog-classification ${real ? 'mode-real' : test ? 'mode-test' : 'mode-drill'}`}
    >
      <span aria-hidden="true">{real ? '!' : test ? '◇' : '✎'} </span>
      {label}
    </p>
  );
}
