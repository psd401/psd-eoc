import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { Call911Affordance } from '../components/call-911-affordance';
import { ClassificationBanner } from '../components/classification-banner';

describe('start-flow safety presentation', () => {
  test('renders real, drill, and test classifications with independent words, icons, and theme hooks', () => {
    const real = renderToStaticMarkup(<ClassificationBanner mode="real" />);
    const drill = renderToStaticMarkup(<ClassificationBanner mode="drill" />);
    const syntheticTest = renderToStaticMarkup(
      <ClassificationBanner kind="test" mode="drill" />,
    );

    expect(real).toContain('classification-banner--real');
    expect(real).toContain('<svg');
    expect(real).toContain('M12 2 23 22H1L12 2Z');
    expect(real).toContain('REAL INCIDENT');
    expect(real).not.toContain('TRAINING ONLY');

    expect(drill).toContain('classification-banner--drill');
    expect(drill).toContain('<svg');
    expect(drill).toContain('m5 16-1 4 4-1L19 8l-3-3L5 16');
    expect(drill).toContain('DRILL — TRAINING ONLY');
    expect(drill).toContain('not a real incident');

    expect(syntheticTest).toContain('classification-banner--test');
    expect(syntheticTest).toContain('M12 2 22 12 12 22 2 12 12 2Z');
    expect(syntheticTest).toContain('TEST — NOT A REAL INCIDENT');
    expect(syntheticTest).toContain('#765A00');
    expect(syntheticTest).not.toContain('DRILL — TRAINING ONLY');
  });

  test('keeps 911 a plain human-controlled phone action with an explicit boundary', () => {
    const markup = renderToStaticMarkup(<Call911Affordance />);

    expect(markup).toContain('href="tel:911"');
    expect(markup).toContain('Call 911 first.');
    expect(markup).toContain(
      'PSD EOC notifies staff; it does not contact 911.',
    );
    expect(markup).not.toContain('auto');
  });
});
