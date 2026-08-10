import { describe, expect, it } from 'bun:test';

import {
  DISTRICT_WEBSITE_URL,
  PRODUCTION_ACCESS_CONFIRMATION,
  PRODUCTION_ACCESS_USE_CASE,
  SES_CLIENT_MAX_ATTEMPTS,
  SES_CONFIGURATION_SET_NAME,
  SES_IDENTITY_DOMAIN,
  SES_MAIL_FROM_DOMAIN,
  SES_TEST_FROM_ADDRESS,
  TARGET_ACCOUNT_ID,
  TARGET_REGION,
  TEST_EMAIL_BODY,
  TEST_EMAIL_SUBJECT,
  TEST_SEND_CONFIRMATION,
  sesClientConfig,
  type CliRuntime,
  type ProductionAccessRequest,
  type SesAccountSnapshot,
  type SesEmailIdentitySnapshot,
  type SesOperationsApi,
  type TestEmailRequest,
} from '../src/ops/ses-common';
import { productionAccessMain } from '../src/ops/ses-production-access';
import { verificationMain } from '../src/ops/ses-verification';

const TEST_CONTACT = 'ses-contact@example.test';
const TEST_RECIPIENT = 'synthetic-recipient@example.invalid';
const TARGET_CONFIRMATIONS = [
  '--confirm-account',
  TARGET_ACCOUNT_ID,
  '--confirm-region',
  TARGET_REGION,
] as const;
const PRODUCTION_CHECK_ARGS = ['--check', ...TARGET_CONFIRMATIONS] as const;
const PRODUCTION_SUBMIT_ARGS = [
  '--submit',
  ...TARGET_CONFIRMATIONS,
  '--contact-email',
  TEST_CONTACT,
] as const;
const VERIFICATION_CHECK_ARGS = ['--check', ...TARGET_CONFIRMATIONS] as const;
const TEST_SEND_ARGS = [
  '--send-test',
  ...TARGET_CONFIRMATIONS,
  '--recipient',
  TEST_RECIPIENT,
] as const;

const INITIAL_ACCOUNT: SesAccountSnapshot = {
  productionAccessEnabled: false,
  sendingEnabled: true,
};

const READY_SOURCE_IDENTITY: SesEmailIdentitySnapshot = {
  configurationSetName: SES_CONFIGURATION_SET_NAME,
  dkimSigningEnabled: true,
  dkimStatus: 'SUCCESS',
  identityType: 'DOMAIN',
  mailFromDomain: SES_MAIL_FROM_DOMAIN,
  mailFromDomainStatus: 'SUCCESS',
  verificationStatus: 'SUCCESS',
  verifiedForSendingStatus: true,
};

const READY_RECIPIENT_IDENTITY: SesEmailIdentitySnapshot = {
  identityType: 'EMAIL_ADDRESS',
  verificationStatus: 'SUCCESS',
  verifiedForSendingStatus: true,
};

interface HarnessOptions {
  readonly account?: SesAccountSnapshot;
  readonly callerAccount?: string;
  readonly confirmation?: string;
  readonly confirmations?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isInteractive?: boolean;
  readonly messageId?: string;
  readonly putError?: Error;
  readonly recipientIdentity?: SesEmailIdentitySnapshot;
  readonly recipientLookupError?: Error;
  readonly sendError?: Error;
  readonly sourceIdentity?: SesEmailIdentitySnapshot;
}

interface HarnessCalls {
  createApi: number;
  getAccount: number;
  getCallerIdentity: number;
  getEmailIdentity: string[];
  prompts: string[];
  putAccountDetails: ProductionAccessRequest[];
  sendTestEmail: TestEmailRequest[];
}

interface Harness {
  readonly calls: HarnessCalls;
  readonly errors: string[];
  readonly output: string[];
  readonly runtime: CliRuntime;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const calls: HarnessCalls = {
    createApi: 0,
    getAccount: 0,
    getCallerIdentity: 0,
    getEmailIdentity: [],
    prompts: [],
    putAccountDetails: [],
    sendTestEmail: [],
  };
  const output: string[] = [];
  const errors: string[] = [];
  const api: SesOperationsApi = {
    async getAccount() {
      calls.getAccount += 1;
      return options.account ?? INITIAL_ACCOUNT;
    },
    async getCallerIdentity() {
      calls.getCallerIdentity += 1;
      return { accountId: options.callerAccount ?? TARGET_ACCOUNT_ID };
    },
    async getEmailIdentity(identity) {
      calls.getEmailIdentity.push(identity);
      if (
        identity !== SES_IDENTITY_DOMAIN &&
        options.recipientLookupError !== undefined
      ) {
        throw options.recipientLookupError;
      }
      return identity === SES_IDENTITY_DOMAIN
        ? (options.sourceIdentity ?? READY_SOURCE_IDENTITY)
        : (options.recipientIdentity ?? READY_RECIPIENT_IDENTITY);
    },
    async putAccountDetails(input) {
      calls.putAccountDetails.push(input);
      if (options.putError !== undefined) {
        throw options.putError;
      }
    },
    async sendTestEmail(input) {
      calls.sendTestEmail.push(input);
      if (options.sendError !== undefined) {
        throw options.sendError;
      }
      return { messageId: options.messageId ?? 'synthetic-message-id' };
    },
  };
  const runtime: CliRuntime = {
    confirm: async (prompt) => {
      calls.prompts.push(prompt);
      return (
        options.confirmations?.[calls.prompts.length - 1] ??
        options.confirmation ??
        ''
      );
    },
    createApi: async () => {
      calls.createApi += 1;
      return api;
    },
    env: options.env ?? {},
    isInteractive: options.isInteractive ?? true,
    stderr: (message) => errors.push(message),
    stdout: (message) => output.push(message),
  };
  return { calls, errors, output, runtime };
}

describe('SES production-access operation', () => {
  it('disables SDK retries for non-idempotent SES write operations', () => {
    expect(SES_CLIENT_MAX_ATTEMPTS).toBe(1);
    expect(sesClientConfig()).toEqual({
      maxAttempts: 1,
      region: TARGET_REGION,
    });
  });

  it('defaults to an entirely offline preview', async () => {
    const harness = createHarness();

    expect(await productionAccessMain([], harness.runtime)).toBe(0);

    expect(harness.calls.createApi).toBe(0);
    expect(harness.calls.getCallerIdentity).toBe(0);
    expect(harness.calls.putAccountDetails).toHaveLength(0);
    expect(harness.output.join(' ')).toContain('OFFLINE PREVIEW');
  });

  it('redacts address-shaped unknown arguments before constructing a client', async () => {
    const unknownAddress = 'approved-contact@example.test';
    const harness = createHarness();

    expect(await productionAccessMain([unknownAddress], harness.runtime)).toBe(
      1,
    );

    expect(harness.errors.join(' ')).toContain(
      'Unknown argument (value redacted).',
    );
    expect(harness.errors.join(' ')).not.toContain(unknownAddress);
    expect(harness.calls.createApi).toBe(0);
    expect(harness.calls.putAccountDetails).toHaveLength(0);
  });

  it('rejects CI and non-TTY submissions before constructing a client', async () => {
    const ciHarness = createHarness({
      env: { CI: '' },
      isInteractive: true,
    });
    const nonTtyHarness = createHarness({ isInteractive: false });
    expect(
      await productionAccessMain(PRODUCTION_SUBMIT_ARGS, ciHarness.runtime),
    ).toBe(1);
    expect(
      await productionAccessMain(PRODUCTION_SUBMIT_ARGS, nonTtyHarness.runtime),
    ).toBe(1);

    expect(ciHarness.calls.createApi).toBe(0);
    expect(nonTtyHarness.calls.createApi).toBe(0);
    expect(ciHarness.calls.putAccountDetails).toHaveLength(0);
    expect(nonTtyHarness.calls.putAccountDetails).toHaveLength(0);
  });

  it('requires exact account and region confirmations before client creation', async () => {
    const accountHarness = createHarness();
    const regionHarness = createHarness();

    expect(
      await productionAccessMain(
        [
          '--check',
          '--confirm-account',
          '111122223333',
          '--confirm-region',
          TARGET_REGION,
        ],
        accountHarness.runtime,
      ),
    ).toBe(1);
    expect(
      await productionAccessMain(
        [
          '--check',
          '--confirm-account',
          TARGET_ACCOUNT_ID,
          '--confirm-region',
          'us-east-1',
        ],
        regionHarness.runtime,
      ),
    ).toBe(1);

    expect(accountHarness.calls.createApi).toBe(0);
    expect(regionHarness.calls.createApi).toBe(0);
  });

  it('rejects placeholder production contact addresses before client creation', async () => {
    const invalidHarness = createHarness();
    const replaceHarness = createHarness();

    expect(
      await productionAccessMain(
        [
          '--submit',
          ...TARGET_CONFIRMATIONS,
          '--contact-email',
          'contact@example.invalid',
        ],
        invalidHarness.runtime,
      ),
    ).toBe(1);
    expect(
      await productionAccessMain(
        [
          '--submit',
          ...TARGET_CONFIRMATIONS,
          '--contact-email',
          'REPLACE_ME@example.test',
        ],
        replaceHarness.runtime,
      ),
    ).toBe(1);

    expect(invalidHarness.calls.createApi).toBe(0);
    expect(replaceHarness.calls.createApi).toBe(0);
  });

  it('stops after STS when credentials resolve to the wrong account', async () => {
    const harness = createHarness({ callerAccount: '111122223333' });

    expect(
      await productionAccessMain(PRODUCTION_CHECK_ARGS, harness.runtime),
    ).toBe(1);

    expect(harness.calls.getCallerIdentity).toBe(1);
    expect(harness.calls.getAccount).toBe(0);
    expect(harness.calls.putAccountDetails).toHaveLength(0);
    expect(harness.errors.join(' ')).toContain(TARGET_ACCOUNT_ID);
  });

  it('reports an exactly granted account as a truthful no-op', async () => {
    const harness = createHarness({
      account: {
        productionAccessEnabled: true,
        reviewStatus: 'GRANTED',
        sendingEnabled: true,
      },
    });

    expect(
      await productionAccessMain(PRODUCTION_SUBMIT_ARGS, harness.runtime),
    ).toBe(0);

    expect(harness.calls.putAccountDetails).toHaveLength(0);
    expect(harness.calls.prompts).toHaveLength(0);
    expect(harness.output.join(' ')).toContain('already granted');
  });

  it('does not duplicate a pending request and fails closed after denial', async () => {
    const pendingHarness = createHarness({
      account: {
        productionAccessEnabled: false,
        reviewStatus: 'PENDING',
        sendingEnabled: true,
      },
    });
    const deniedHarness = createHarness({
      account: {
        productionAccessEnabled: false,
        reviewStatus: 'DENIED',
        sendingEnabled: true,
      },
    });
    expect(
      await productionAccessMain(
        PRODUCTION_SUBMIT_ARGS,
        pendingHarness.runtime,
      ),
    ).toBe(0);
    expect(
      await productionAccessMain(PRODUCTION_SUBMIT_ARGS, deniedHarness.runtime),
    ).toBe(1);

    expect(pendingHarness.calls.putAccountDetails).toHaveLength(0);
    expect(deniedHarness.calls.putAccountDetails).toHaveLength(0);
    expect(pendingHarness.output.join(' ')).toContain('already pending');
    expect(deniedHarness.errors.join(' ')).toContain('denied');
  });

  it('submits one exact transactional request after a valid failed-review retry', async () => {
    const harness = createHarness({
      account: {
        productionAccessEnabled: false,
        reviewStatus: 'FAILED',
        sendingEnabled: true,
      },
      confirmation: PRODUCTION_ACCESS_CONFIRMATION,
    });

    expect(
      await productionAccessMain(PRODUCTION_SUBMIT_ARGS, harness.runtime),
    ).toBe(0);

    expect(harness.calls.putAccountDetails).toEqual([
      {
        additionalContactEmailAddresses: [TEST_CONTACT],
        contactLanguage: 'EN',
        mailType: 'TRANSACTIONAL',
        productionAccessEnabled: true,
        useCaseDescription: PRODUCTION_ACCESS_USE_CASE,
        websiteUrl: DISTRICT_WEBSITE_URL,
      },
    ]);
    expect(PRODUCTION_ACCESS_USE_CASE).toContain('approximately 1,200');
    expect(PRODUCTION_ACCESS_USE_CASE).toContain('opt-in');
    expect(PRODUCTION_ACCESS_USE_CASE).toContain('no marketing');
    expect(PRODUCTION_ACCESS_USE_CASE).toContain('no student data');
    expect(PRODUCTION_ACCESS_USE_CASE).toContain('Bounces and complaints');
    expect(harness.output.join(' ')).toContain('request submitted');
    expect(harness.output.join(' ')).toContain('does not mean');
    expect(harness.output.join(' ')).not.toContain(TEST_CONTACT);
  });

  it('requires the exact confirmation and never prints success after API failure', async () => {
    const mismatchHarness = createHarness({ confirmation: 'yes' });
    const failedHarness = createHarness({
      confirmation: PRODUCTION_ACCESS_CONFIRMATION,
      putError: new Error(`provider leaked ${TEST_CONTACT}\nerror\u001b[31m`),
    });
    expect(
      await productionAccessMain(
        PRODUCTION_SUBMIT_ARGS,
        mismatchHarness.runtime,
      ),
    ).toBe(1);
    expect(
      await productionAccessMain(PRODUCTION_SUBMIT_ARGS, failedHarness.runtime),
    ).toBe(1);

    expect(mismatchHarness.calls.putAccountDetails).toHaveLength(0);
    expect(failedHarness.calls.putAccountDetails).toHaveLength(1);
    expect(failedHarness.output.join(' ')).not.toContain('request submitted');
    expect(failedHarness.errors.join(' ')).toContain('outcome is unknown');
    expect(failedHarness.errors.join(' ')).toContain('Do not retry');
    expect(failedHarness.errors.join(' ')).toContain('read-only --check');
    expect(failedHarness.errors.join(' ')).not.toContain(TEST_CONTACT);
    expect(failedHarness.errors.join(' ')).not.toContain('provider leaked');
    expect(failedHarness.errors.join(' ')).not.toContain('\n');
    expect(failedHarness.errors.join(' ')).not.toContain('\u001b');
  });
});

describe('SES verification operation', () => {
  it('defaults to an entirely offline preview', async () => {
    const harness = createHarness();

    expect(await verificationMain([], harness.runtime)).toBe(0);

    expect(harness.calls.createApi).toBe(0);
    expect(harness.calls.getEmailIdentity).toHaveLength(0);
    expect(harness.calls.sendTestEmail).toHaveLength(0);
    expect(harness.output.join(' ')).toContain('OFFLINE PREVIEW');
  });

  it('redacts address-shaped unknown arguments before constructing a client', async () => {
    const unknownAddress = 'approved-recipient@example.test';
    const harness = createHarness();

    expect(await verificationMain([unknownAddress], harness.runtime)).toBe(1);

    expect(harness.errors.join(' ')).toContain(
      'Unknown argument (value redacted).',
    );
    expect(harness.errors.join(' ')).not.toContain(unknownAddress);
    expect(harness.calls.createApi).toBe(0);
    expect(harness.calls.sendTestEmail).toHaveLength(0);
  });

  it('permits a read-only readiness check without production access', async () => {
    const harness = createHarness();

    expect(
      await verificationMain(VERIFICATION_CHECK_ARGS, harness.runtime),
    ).toBe(0);

    expect(harness.calls.getEmailIdentity).toEqual([SES_IDENTITY_DOMAIN]);
    expect(harness.calls.sendTestEmail).toHaveLength(0);
    expect(harness.output.join(' ')).toContain('readiness check passed');
    expect(harness.output.join(' ')).toContain('No email was sent');
  });

  it('rejects CI, non-TTY, and wrong-account test sends before SES mutation', async () => {
    const ciHarness = createHarness({ env: { CI: '1' } });
    const nonTtyHarness = createHarness({ isInteractive: false });
    const wrongAccountHarness = createHarness({
      callerAccount: '111122223333',
    });
    expect(await verificationMain(TEST_SEND_ARGS, ciHarness.runtime)).toBe(1);
    expect(await verificationMain(TEST_SEND_ARGS, nonTtyHarness.runtime)).toBe(
      1,
    );
    expect(
      await verificationMain(TEST_SEND_ARGS, wrongAccountHarness.runtime),
    ).toBe(1);

    expect(ciHarness.calls.createApi).toBe(0);
    expect(nonTtyHarness.calls.createApi).toBe(0);
    expect(wrongAccountHarness.calls.getAccount).toBe(0);
    expect(wrongAccountHarness.calls.sendTestEmail).toHaveLength(0);
  });

  it('requires exact account and region confirmations before verification clients', async () => {
    const accountHarness = createHarness();
    const regionHarness = createHarness();

    expect(
      await verificationMain(
        [
          '--check',
          '--confirm-account',
          '111122223333',
          '--confirm-region',
          TARGET_REGION,
        ],
        accountHarness.runtime,
      ),
    ).toBe(1);
    expect(
      await verificationMain(
        [
          '--check',
          '--confirm-account',
          TARGET_ACCOUNT_ID,
          '--confirm-region',
          'us-east-1',
        ],
        regionHarness.runtime,
      ),
    ).toBe(1);

    expect(accountHarness.calls.createApi).toBe(0);
    expect(regionHarness.calls.createApi).toBe(0);
  });

  const sourceBlockers: Array<
    readonly [string, Partial<SesEmailIdentitySnapshot>]
  > = [
    ['identity verification', { verificationStatus: 'PENDING' }],
    ['verified-for-sending', { verifiedForSendingStatus: false }],
    ['DKIM signing', { dkimSigningEnabled: false }],
    ['DKIM status', { dkimStatus: 'PENDING' }],
    ['MAIL FROM domain', { mailFromDomain: 'wrong.example.invalid' }],
    ['MAIL FROM status', { mailFromDomainStatus: 'PENDING' }],
    ['configuration set', { configurationSetName: 'wrong-config' }],
  ];
  for (const [label, change] of sourceBlockers) {
    it(`blocks sending when ${label} is not ready`, async () => {
      const harness = createHarness({
        confirmations: [TEST_SEND_CONFIRMATION, TEST_RECIPIENT],
        sourceIdentity: { ...READY_SOURCE_IDENTITY, ...change },
      });

      expect(await verificationMain(TEST_SEND_ARGS, harness.runtime)).toBe(1);

      expect(harness.calls.getEmailIdentity).toEqual([SES_IDENTITY_DOMAIN]);
      expect(harness.calls.sendTestEmail).toHaveLength(0);
    });
  }

  it('requires the exact recipient to be a separately verified email identity', async () => {
    const harness = createHarness({
      confirmations: [TEST_SEND_CONFIRMATION, TEST_RECIPIENT],
      recipientIdentity: {
        identityType: 'DOMAIN',
        verificationStatus: 'SUCCESS',
        verifiedForSendingStatus: true,
      },
    });

    expect(await verificationMain(TEST_SEND_ARGS, harness.runtime)).toBe(1);

    expect(harness.calls.getEmailIdentity).toEqual([
      SES_IDENTITY_DOMAIN,
      TEST_RECIPIENT,
    ]);
    expect(harness.calls.sendTestEmail).toHaveLength(0);
  });

  it('blocks a test send when production-access state is unknown', async () => {
    const harness = createHarness({
      account: { sendingEnabled: true },
      confirmations: [TEST_SEND_CONFIRMATION, TEST_RECIPIENT],
    });

    expect(await verificationMain(TEST_SEND_ARGS, harness.runtime)).toBe(1);

    expect(harness.calls.getEmailIdentity).toEqual([SES_IDENTITY_DOMAIN]);
    expect(harness.calls.sendTestEmail).toHaveLength(0);
    expect(harness.errors.join(' ')).toContain(
      'production-access state is unknown',
    );
  });

  it('redacts provider errors from exact-recipient verification', async () => {
    const harness = createHarness({
      confirmations: [TEST_SEND_CONFIRMATION, TEST_RECIPIENT],
      recipientLookupError: new Error(`not found: ${TEST_RECIPIENT}`),
    });

    expect(await verificationMain(TEST_SEND_ARGS, harness.runtime)).toBe(1);

    expect(harness.calls.sendTestEmail).toHaveLength(0);
    expect(harness.errors.join(' ')).toContain('redacted provider error');
    expect(harness.errors.join(' ')).not.toContain(TEST_RECIPIENT);
    expect(harness.errors.join(' ')).not.toContain('not found');
  });

  it('requires the exact test-send confirmation', async () => {
    const phraseHarness = createHarness({ confirmation: 'send it' });
    const recipientHarness = createHarness({
      confirmations: [TEST_SEND_CONFIRMATION, 'different@example.invalid'],
    });

    expect(await verificationMain(TEST_SEND_ARGS, phraseHarness.runtime)).toBe(
      1,
    );
    expect(
      await verificationMain(TEST_SEND_ARGS, recipientHarness.runtime),
    ).toBe(1);

    expect(phraseHarness.calls.sendTestEmail).toHaveLength(0);
    expect(recipientHarness.calls.sendTestEmail).toHaveLength(0);
  });

  it('sends exactly one unmistakable synthetic message and labels only provider acceptance', async () => {
    const harness = createHarness({
      account: {
        productionAccessEnabled: true,
        reviewStatus: 'GRANTED',
        sendingEnabled: true,
      },
      confirmations: [TEST_SEND_CONFIRMATION, TEST_RECIPIENT],
      messageId: 'synthetic-message-id',
    });

    expect(await verificationMain(TEST_SEND_ARGS, harness.runtime)).toBe(0);

    expect(harness.calls.sendTestEmail).toEqual([
      {
        configurationSetName: SES_CONFIGURATION_SET_NAME,
        fromAddress: SES_TEST_FROM_ADDRESS,
        recipientAddress: TEST_RECIPIENT,
        subject: TEST_EMAIL_SUBJECT,
        textBody: TEST_EMAIL_BODY,
      },
    ]);
    expect(TEST_EMAIL_SUBJECT.startsWith('TEST ONLY — NO EMERGENCY')).toBe(
      true,
    );
    expect(TEST_EMAIL_BODY.startsWith('TEST ONLY — NO EMERGENCY')).toBe(true);
    expect(TEST_EMAIL_BODY).toContain('neither a real incident');
    expect(TEST_EMAIL_BODY).toContain('nor a drill activation');
    expect(harness.output.join(' ')).toContain('provider-accepted');
    expect(harness.output.join(' ')).toContain('productionAccessEnabled=true');
    expect(harness.output.join(' ')).toContain('not proof of delivery');
    expect(harness.output.join(' ')).not.toContain('delivered');
    expect(harness.output.join(' ')).not.toContain(TEST_RECIPIENT);
  });

  it('does not report acceptance when SES fails or omits MessageId', async () => {
    const failedHarness = createHarness({
      confirmations: [TEST_SEND_CONFIRMATION, TEST_RECIPIENT],
      sendError: new Error(`provider failed for ${TEST_RECIPIENT}`),
    });
    const missingIdHarness = createHarness({
      confirmations: [TEST_SEND_CONFIRMATION, TEST_RECIPIENT],
      messageId: '',
    });
    expect(await verificationMain(TEST_SEND_ARGS, failedHarness.runtime)).toBe(
      1,
    );
    expect(
      await verificationMain(TEST_SEND_ARGS, missingIdHarness.runtime),
    ).toBe(1);

    expect(failedHarness.calls.sendTestEmail).toHaveLength(1);
    expect(missingIdHarness.calls.sendTestEmail).toHaveLength(1);
    expect(failedHarness.output.join(' ')).not.toContain('provider-accepted');
    expect(missingIdHarness.output.join(' ')).not.toContain(
      'provider-accepted',
    );
    expect(failedHarness.errors.join(' ')).toContain('outcome is unknown');
    expect(missingIdHarness.errors.join(' ')).toContain('outcome is unknown');
    expect(failedHarness.errors.join(' ')).toContain('Do not retry');
    expect(missingIdHarness.errors.join(' ')).toContain('Do not retry');
    expect(failedHarness.errors.join(' ')).not.toContain(TEST_RECIPIENT);
    expect(failedHarness.errors.join(' ')).not.toContain('provider failed');
  });
});
