import type { ReactNode } from 'react';

export default function PublicLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
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
            background: #eef3f7;
            color: #14263a;
          }

          * { box-sizing: border-box; }
          body { margin: 0; min-height: 100vh; }
          a { color: #075985; }
          a:focus-visible, main:focus { outline: 0.25rem solid #92400e; outline-offset: 0.25rem; }
          .skip-link { position: absolute; left: 1rem; top: -6rem; z-index: 2; background: white; padding: 0.75rem 1rem; }
          .skip-link:focus { top: 1rem; }
          .policy-shell { width: min(100% - 2rem, 54rem); margin: 0 auto; padding: 3rem 0 5rem; }
          .policy-heading { border-bottom: 0.35rem solid #175a8e; margin-bottom: 2rem; padding-bottom: 1.5rem; }
          .eyebrow { color: #3b5874; font-size: 0.8rem; font-weight: 800; letter-spacing: 0.12em; margin: 0 0 0.5rem; text-transform: uppercase; }
          h1 { font-size: clamp(2.25rem, 7vw, 4.5rem); letter-spacing: -0.04em; line-height: 1; margin: 0; }
          h2 { font-size: clamp(1.45rem, 4vw, 2rem); line-height: 1.2; margin: 0 0 0.75rem; }
          h3 { font-size: 1.05rem; margin: 1.4rem 0 0.35rem; }
          p { line-height: 1.7; margin: 0.5rem 0 1rem; }
          section, .summary { background: white; border: 1px solid #c8d5df; border-radius: 0.8rem; margin-top: 1rem; padding: clamp(1.2rem, 4vw, 2rem); }
          .lede { color: #334e68; font-size: 1.15rem; max-width: 44rem; }
          .updated { color: #526d82; font-size: 0.9rem; margin-bottom: 0; }
          .contact-link { display: inline-block; min-height: 2.75rem; border: 2px solid #175a8e; border-radius: 0.45rem; font-weight: 800; padding: 0.65rem 1rem; }
          .summary { background: #e7f1f8; border-color: #91afc7; }
          @media (max-width: 38rem) { .policy-shell { padding-top: 2rem; } }
        `}</style>
      </body>
    </html>
  );
}
