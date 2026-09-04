import type { Metadata } from 'next';

import {
  organizationName,
  privacyContactUrl,
} from '../../../lib/config/deployment';

export const metadata: Metadata = {
  title: 'Privacy policy | PSD EOC',
  description: 'How the configured organization handles staff data in PSD EOC.',
};

export const dynamic = 'force-dynamic';

interface PrivacyPolicyPageProps {
  readonly contactUrl: string;
  readonly organization: string;
}

function PrivacyPolicyPage({
  contactUrl,
  organization,
}: PrivacyPolicyPageProps) {
  return (
    <main className="policy-shell" id="main-content" tabIndex={-1}>
      <header className="policy-heading">
        <p className="eyebrow">PSD EOC</p>
        <h1>Privacy policy</h1>
        <p className="lede">
          This policy explains how {organization} accesses, collects, uses,
          protects, retains, and discloses staff data when operating PSD EOC.
        </p>
        <p className="updated">Effective August 25, 2026</p>
      </header>

      <section aria-labelledby="scope-heading">
        <h2 id="scope-heading">Scope</h2>
        <p>
          PSD EOC is a managed, staff-only emergency operations application.
          Student data is outside the scope of PSD EOC. Staff must not enter
          student rosters, schedules, locations, guardian information, or
          reunification information into the application.
        </p>
      </section>

      <section aria-labelledby="data-heading">
        <h2 id="data-heading">Data the application handles</h2>
        <h3>Staff identity and access data</h3>
        <p>
          The application receives managed staff directory and Google group
          records, including work email address, display name, group membership,
          and group-derived role and facility access. Depending on deployment
          configuration, approved staff notification records can also include a
          work notification email address or phone number. The directory can
          include authorized staff who have not signed in. When a staff member
          signs in, the application also receives the managed Google account
          subject used to authenticate that person and enforce access on the
          server.
        </p>
        <h3>Device and notification data</h3>
        <p>
          The application stores opaque session and device-enrollment
          identifiers, platform and app-version facts, and—when notification
          registration is enabled—an installation identifier and push token.
          These values support secure return access, session revocation,
          notification registration, and delivery troubleshooting.
        </p>
        <h3>Mobile numbers and text messages</h3>
        <p>
          A staff member may choose to give a mobile number so {organization}
          can reach them by text message during an emergency. Giving a number is
          voluntary and is never required to use PSD EOC; staff who give none
          still receive email and in-app notifications. The application records
          the number, the exact wording the person agreed to, and when they
          agreed, because a mobile carrier can require proof that a message to
          that number was permitted.
        </p>
        <p>
          Mobile numbers and these consent records are used only to send
          emergency notifications, drills, and the delivery tests that prove the
          system still reaches staff. They are never used for marketing, and are
          not sold, rented, or shared with third parties or affiliates for
          marketing or any other independent purpose. They are disclosed only to
          the messaging provider {organization} configures, and only to the
          extent needed to deliver a message.
        </p>
        <p>
          Staff can stop text messages at any time, either in PSD EOC or by
          replying STOP to any message. Withdrawing marks the consent withdrawn
          and stops further messages; the record of the consent itself is
          retained as the evidence a carrier may request.
        </p>
        <h3>Event content, media, and foreground location</h3>
        <p>
          Authorized staff may submit event messages, journal entries, photos,
          captions, and a foreground location with measured accuracy. Photo and
          location access occurs only after a staff member chooses the related
          action. The application does not request background location, Motion
          &amp; Fitness data, microphone access, contacts, or broad device
          storage access. Other authorized staff with access to the same event
          may see submitted content, its staff attribution, and related event
          history.
        </p>
        <h3>Operational and security records</h3>
        <p>
          The application records timestamps, authorization decisions,
          capability results, event changes, and provider handoff outcomes for
          safety, troubleshooting, accountability, and records obligations.
        </p>
      </section>

      <section aria-labelledby="use-heading">
        <h2 id="use-heading">How data is used</h2>
        <p>
          Data is used only to authenticate and authorize staff, coordinate
          emergency operations and drills, maintain event and security history,
          register approved staff devices, hand approved messages to configured
          providers, and diagnose application or delivery failures. PSD EOC has
          no advertising, cross-app tracking, consumer profiling, or data-sale
          feature.
        </p>
      </section>

      <section aria-labelledby="providers-heading">
        <h2 id="providers-heading">Service providers</h2>
        <p>
          Depending on deployment configuration, {organization} uses Google for
          managed sign-in and staff-group verification; Amazon Web Services for
          application hosting, database, file, monitoring, email, and messaging
          services; Expo for mobile builds, push-token exchange, and
          push-message delivery; and Apple or Google for private app
          distribution and platform push delivery. A push handoff can provide
          Expo with the installation token, notification title and body, and
          event and facility routing identifiers needed to deliver that message.
          Email or SMS handoffs can provide the configured provider with an
          approved staff endpoint and message. These providers may process the
          data needed to perform those services on behalf of the organization.
          PSD EOC does not disclose staff data to advertising brokers or sell it
          to another organization.
        </p>
      </section>

      <section aria-labelledby="security-heading">
        <h2 id="security-heading">Security</h2>
        <p>
          User data sent by the application is encrypted in transit. Mobile
          sessions are kept in encrypted operating-system storage. Server-side
          authorization is deny-by-default and scoped by staff role and
          facility. Provider responses, uploaded files, and message content are
          treated as untrusted input and validated before use.
        </p>
      </section>

      <section aria-labelledby="retention-heading">
        <h2 id="retention-heading">Retention and deletion</h2>
        <p>
          Staff accounts are managed by {organization}, not created inside PSD
          EOC. Signing out revokes the mobile session, and removing staff access
          prevents later application access. The organization may delete or
          deactivate session, device, and notification-registration data when it
          is no longer required.
        </p>
        <p>
          Event journals and security records are append-only: corrections use
          superseding entries instead of rewriting history. Those records, and
          related media or delivery evidence, may be retained after staff access
          ends when required for safety, security, public-records, litigation,
          or other legal obligations. A request will not erase records the
          organization is required to preserve.
        </p>
      </section>

      <section aria-labelledby="contact-heading">
        <h2 id="contact-heading">Privacy questions and data requests</h2>
        <p>
          Staff can ask about access, correction, retention, or deletion through
          the organization&apos;s published contact channel. The organization
          will verify the requester and explain any records it must retain.
        </p>
        <a className="contact-link" href={contactUrl}>
          Contact {organization}
        </a>
      </section>

      <aside aria-label="No advertising or sale of data" className="summary">
        <h2>No advertising or sale of data</h2>
        <p>
          PSD EOC is an operational staff tool. It contains no advertising SDK,
          behavioral advertising, or sale of staff information. No mobile
          number, and no record of consent to be texted, is shared with any
          third party or affiliate for marketing.
        </p>
      </aside>
    </main>
  );
}

export default function PrivacyPage() {
  return (
    <PrivacyPolicyPage
      contactUrl={privacyContactUrl()}
      organization={organizationName()}
    />
  );
}
