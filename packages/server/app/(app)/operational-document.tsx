import type { ReactNode } from 'react';

/**
 * The document shell every authenticated page renders inside.
 *
 * This used to live beside the fan-out control banner, which is gone: there is
 * no mode in which notifications are switched off, so there is nothing for a
 * banner to announce.
 */
export function OperationalDocument({
  nav,
  children,
}: Readonly<{
  nav?: ReactNode;
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        {nav}
        {children}
      </body>
    </html>
  );
}
