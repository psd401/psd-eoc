import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

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

    const composedMarkup = renderToStaticMarkup(
      <OperationalLayout>
        <EventRoomLayout>
          <main id="main-content">Synthetic event room</main>
        </EventRoomLayout>
      </OperationalLayout>,
    );
    expect(composedMarkup.match(/<html/gu)).toHaveLength(1);
    expect(composedMarkup.match(/<body/gu)).toHaveLength(1);
    expect(composedMarkup.match(/Skip to main content/gu)).toHaveLength(1);
    expect(operationalMetadata.title).toEqual({
      default: 'PSD EOC',
      template: '%s | PSD EOC',
    });
  });
});
