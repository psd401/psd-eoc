import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { StoreLinksFooterContent } from './store-links-footer';

describe('StoreLinksFooterContent', () => {
  test('links to both store listings when both are configured', () => {
    const html = renderToStaticMarkup(
      <StoreLinksFooterContent
        listings={{
          appStore: 'https://apps.apple.com/app/id1234567890',
          googlePlay:
            'https://play.google.com/store/apps/details?id=invalid.example.eoc',
        }}
      />,
    );
    expect(html).toContain('<footer class="store-links-footer">');
    expect(html).toContain(
      'href="https://apps.apple.com/app/id1234567890" rel="noopener noreferrer" target="_blank">App Store</a>',
    );
    expect(html).toContain(
      'href="https://play.google.com/store/apps/details?id=invalid.example.eoc" rel="noopener noreferrer" target="_blank">Google Play</a>',
    );
  });

  test('leaves out a store that is not configured', () => {
    const html = renderToStaticMarkup(
      <StoreLinksFooterContent
        listings={{
          appStore: null,
          googlePlay:
            'https://play.google.com/store/apps/details?id=invalid.example.eoc',
        }}
      />,
    );
    expect(html).toContain('Google Play');
    expect(html).not.toContain('App Store');
  });

  test('renders no footer when neither store is configured', () => {
    expect(
      renderToStaticMarkup(
        <StoreLinksFooterContent
          listings={{ appStore: null, googlePlay: null }}
        />,
      ),
    ).toBe('');
  });
});
