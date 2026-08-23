import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { OperatorShell } from '../../nav/operator-shell';

export const metadata: Metadata = {
  title: 'Security audit log | Emergency operations',
  description: 'Review minimized, tamper-evident security events.',
};

export default function AuditRootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <OperatorShell>
      {children}
      <style>{`
          :root {
            color-scheme: light;
            font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
              "Segoe UI", sans-serif;
            background: #f4f7fb;
            color: #17202a;
          }

          * { box-sizing: border-box; }
          body { min-height: 100vh; margin: 0; }
          main { width: min(100% - 2rem, 92rem); margin: 0 auto; padding: 2rem 0 4rem; }
          main:focus { outline: .25rem solid #92400e; outline-offset: .25rem; }
          header { max-width: 60rem; }
          h1, h2 { line-height: 1.2; }
          p { line-height: 1.55; }
          .eyebrow { color: #174ea6; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
          .filters, .notice, .table-region { margin-top: 1.5rem; }
          fieldset, .notice { border: 1px solid #94a3b8; border-radius: .5rem; background: #fff; padding: 1rem; }
          legend { font-size: 1.2rem; font-weight: 800; padding: 0 .4rem; }
          .filter-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1rem; }
          label { display: grid; gap: .35rem; font-weight: 700; }
          input, select, button, .next-page { min-height: 2.75rem; border-radius: .3rem; font: inherit; }
          input, select { width: 100%; border: 1px solid #64748b; background: #fff; padding: .55rem; }
          .field-help { color: #475569; font-size: .9rem; font-weight: 400; line-height: 1.4; }
          .actions { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1rem; }
          button, .next-page { display: inline-flex; align-items: center; border: 2px solid #174ea6; padding: .5rem 1rem; font-weight: 750; }
          button { background: #174ea6; color: #fff; cursor: pointer; }
          button:disabled { cursor: wait; opacity: .7; }
          .secondary-action, .next-page { background: #fff; color: #174ea6; }
          .query-status { min-height: 1.5rem; }
          .pagination { margin-top: 1rem; }
          .error { border-color: #b91c1c; }
          .table-region { overflow-x: auto; border: 1px solid #94a3b8; background: #fff; }
          table { width: 100%; border-collapse: collapse; }
          caption { padding: .8rem; text-align: left; font-weight: 650; }
          th, td { border-top: 1px solid #cbd5e1; padding: .7rem; text-align: left; vertical-align: top; }
          th { background: #e8eef7; }
          td code { display: block; max-width: 24rem; overflow-wrap: anywhere; }
          a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, .table-region:focus-visible {
            outline: .25rem solid #92400e; outline-offset: .15rem;
          }
          .skip-link { position: absolute; left: .75rem; top: -5rem; z-index: 10; background: #fff; color: #0f172a; padding: .75rem; }
          .skip-link:focus { top: .75rem; }
        `}</style>
    </OperatorShell>
  );
}
