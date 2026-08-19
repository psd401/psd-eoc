import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { OperationalDocument } from '../../fanout-control-banner';
import OperationalLayout, {
  metadata as operationalMetadata,
} from '../../layout';
import EventRoomLayout, { metadata } from './layout';

describe('event-room nested layout', () => {
  test('composes its child title through the operational parent template', () => {
    expect(metadata.title).toBe('Event room');
    expect(metadata.description).toContain('event timeline');
  });

  test('leaves the document shell and skip link to the operational parent', () => {
    const childMarkup = renderToStaticMarkup(
      <EventRoomLayout>
        <main id="main-content">Synthetic event room</main>
      </EventRoomLayout>,
    );

    expect(childMarkup).toBe(
      '<main id="main-content">Synthetic event room</main>',
    );
    expect(childMarkup).not.toContain('<html');
    expect(childMarkup).not.toContain('<body');
    expect(childMarkup).not.toContain('Skip to main content');

    // The operational layout is checked structurally rather than rendered. Its
    // navigation is an async server component that reads the request cookies,
    // and renderToStaticMarkup cannot resolve one. What it delegates the shell
    // to is OperationalDocument, so that is where the markup is asserted.
    expect(
      OperationalLayout({
        children: <main id="main-content">Synthetic event room</main>,
      }).type,
    ).toBe(OperationalDocument);

    const composedMarkup = renderToStaticMarkup(
      <OperationalDocument
        banner={null}
        nav={<nav aria-label="Primary">Synthetic navigation</nav>}
      >
        <EventRoomLayout>
          <main id="main-content">Synthetic event room</main>
        </EventRoomLayout>
      </OperationalDocument>,
    );
    expect(composedMarkup.match(/<html/gu)).toHaveLength(1);
    expect(composedMarkup.match(/<body/gu)).toHaveLength(1);
    expect(composedMarkup.match(/Skip to main content/gu)).toHaveLength(1);
    // The skip link has to precede the navigation, or it cannot skip it.
    expect(composedMarkup.indexOf('Skip to main content')).toBeLessThan(
      composedMarkup.indexOf('Synthetic navigation'),
    );
    expect(operationalMetadata.title).toEqual({
      default: 'PSD EOC',
      template: '%s | PSD EOC',
    });
  });
});
