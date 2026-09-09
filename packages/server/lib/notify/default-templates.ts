import {
  MessageTemplateCatalogSchema,
  type MessageTemplateCatalog,
  type NotificationPurpose,
  type TemplateMode,
} from '@psd-eoc/contracts';

/**
 * The wording every response type starts with, before an administrator
 * changes it on the Responses page. The renderer places the classification
 * marker and the lifecycle state in front of each field, so the wording here
 * begins with the response and the school and says who acted and when.
 *
 * Chosen 2026-09-09 against the district's previous alerting product, read
 * side by side on a phone after the same drill: name the response and the
 * school first, then who started or completed it and when, then the threat,
 * then where to look. The SMS wording is kept inside one 160-character part
 * for ordinary names; the renderer truncates the tail, which is the least
 * important clause, when a long school and threat name push it over.
 */
const WORDING: Readonly<
  Record<
    NotificationPurpose,
    Readonly<{
      title: string;
      body: string;
      subject: string;
      textBody: string;
      sms: string;
    }>
  >
> = Object.freeze({
  activation: Object.freeze({
    title: '{{eventType}} at {{site}}',
    body: 'Started by {{initiator}} at {{startTime}}. Threat: {{threat}}. Open PSD EOC for current instructions.',
    subject: '{{eventType}} at {{site}}',
    textBody:
      '{{eventType}} at {{site}} has been started by {{initiator}}.\nLocation: {{site}}\nThreat: {{threat}}\nTime: {{startTime}}\n\nOpen PSD EOC for current instructions. Call 911 first when emergency assistance is needed.',
    sms: '{{eventType}} at {{site}} started by {{initiator}}, {{startTime}}. Threat: {{threat}}. Open PSD EOC.',
  }),
  'all-clear': Object.freeze({
    title: '{{eventType}} at {{site}}',
    body: 'Completed by {{updatedBy}} at {{updatedAt}}. Open PSD EOC for current information.',
    subject: '{{eventType}} at {{site}}',
    textBody:
      '{{updatedBy}} has completed {{eventType}} at {{site}}.\nEvent completed: {{updatedAt}}\nLocation: {{site}}\n\nOpen PSD EOC for current information.',
    sms: '{{eventType}} at {{site}} completed by {{updatedBy}}, {{updatedAt}}. Open PSD EOC.',
  }),
  reactivation: Object.freeze({
    title: '{{eventType}} at {{site}}',
    body: 'Reactivated by {{updatedBy}} at {{updatedAt}}. Threat: {{threat}}. Open PSD EOC for current instructions.',
    subject: '{{eventType}} at {{site}}',
    textBody:
      '{{eventType}} at {{site}} has been reactivated by {{updatedBy}}.\nLocation: {{site}}\nThreat: {{threat}}\nTime: {{updatedAt}}\n\nOpen PSD EOC for current instructions. Call 911 first when emergency assistance is needed.',
    sms: '{{eventType}} at {{site}} reactivated by {{updatedBy}}, {{updatedAt}}. Threat: {{threat}}. Open PSD EOC.',
  }),
});

const PURPOSES = ['activation', 'all-clear', 'reactivation'] as const;

/** The complete default catalog for one mode, valid against the contract. */
export function defaultMessageTemplateCatalog(
  templateMode: TemplateMode,
): MessageTemplateCatalog {
  const classificationMarker = templateMode === 'real' ? 'INCIDENT' : 'DRILL';
  return MessageTemplateCatalogSchema.parse(
    Object.fromEntries(
      PURPOSES.map((purpose) => {
        const wording = WORDING[purpose];
        const common = { templateMode, purpose, classificationMarker };
        return [
          purpose,
          {
            templateMode,
            purpose,
            push: {
              ...common,
              channel: 'push',
              title: wording.title,
              body: wording.body,
            },
            email: {
              ...common,
              channel: 'email',
              subject: wording.subject,
              textBody: wording.textBody,
            },
            sms: { ...common, channel: 'sms', body: wording.sms },
          },
        ];
      }),
    ),
  );
}

/** The administrator-editable fields of a catalog, for comparing two. */
export function templateCatalogWording(
  catalog: MessageTemplateCatalog,
): string {
  return JSON.stringify(
    PURPOSES.map((purpose) => {
      const set = catalog[purpose];
      return [
        set.push.title,
        set.push.body,
        set.email.subject,
        set.email.textBody,
        set.sms.body,
      ];
    }),
  );
}
