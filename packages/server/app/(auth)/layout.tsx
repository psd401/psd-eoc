import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Sign in | PSD EOC',
  description: 'Secure staff access to PSD EOC.',
};

export default function AuthLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        {children}
        <style>{`
          :root {
            color-scheme: light;
            font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
              "Segoe UI", sans-serif;
            background: #f5f7fa;
            color: #17202a;
          }

          * {
            box-sizing: border-box;
          }

          body {
            min-height: 100vh;
            margin: 0;
          }

          main {
            width: min(100% - 2rem, 38rem);
            margin: 0 auto;
            padding: clamp(3rem, 10vh, 7rem) 0 3rem;
          }

          main:focus {
            outline: 0.25rem solid #92400e;
            outline-offset: 0.25rem;
          }

          .auth-card {
            border: 1px solid #cbd5e1;
            border-radius: 0.75rem;
            background: #ffffff;
            box-shadow: 0 0.5rem 1.5rem rgb(15 23 42 / 8%);
            padding: clamp(1.5rem, 5vw, 2.5rem);
          }

          h1 {
            margin-top: 0;
            line-height: 1.2;
          }

          p {
            line-height: 1.6;
          }

          .button-link {
            display: inline-block;
            min-height: 2.75rem;
            margin: 0.75rem 0;
            border: 2px solid #174ea6;
            border-radius: 0.375rem;
            background: #174ea6;
            color: #ffffff;
            font-weight: 700;
            line-height: 1.25rem;
            padding: 0.625rem 1rem;
            text-decoration: none;
          }

          .button-link:hover {
            background: #123b7d;
          }

          a:focus-visible {
            outline: 0.25rem solid #92400e;
            outline-offset: 0.2rem;
          }

          .supporting-text {
            color: #475569;
            font-size: 0.95rem;
          }

          .skip-link {
            position: absolute;
            left: 0.75rem;
            top: -5rem;
            z-index: 10;
            background: #ffffff;
            color: #0f172a;
            padding: 0.75rem;
          }

          .skip-link:focus {
            top: 0.75rem;
          }
        `}</style>
      </body>
    </html>
  );
}
