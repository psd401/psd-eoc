import {
  SES_CONFIGURATION_SET_NAME,
  SES_IDENTITY_DOMAIN,
  SES_MAIL_FROM_DOMAIN,
  SES_TEST_FROM_ADDRESS,
  TARGET_ACCOUNT_ID,
  TARGET_REGION,
  TEST_EMAIL_BODY,
  TEST_EMAIL_SUBJECT,
  TEST_SEND_CONFIRMATION,
  assertConfirmedTarget,
  assertMutationAllowed,
  assertTargetAccount,
  createDefaultRuntime,
  errorMessage,
  isEmailAddress,
  terminalSafeText,
  type CliRuntime,
  type SesAccountSnapshot,
  type SesEmailIdentitySnapshot,
  type SesOperationsApi,
} from './ses-common';

interface PreviewOptions {
  readonly mode: 'preview';
}

interface CheckOptions {
  readonly confirmedAccount: string;
  readonly confirmedRegion: string;
  readonly mode: 'check';
}

interface SendTestOptions {
  readonly confirmedAccount: string;
  readonly confirmedRegion: string;
  readonly mode: 'send-test';
  readonly recipientAddress: string;
}

type VerificationOptions = PreviewOptions | CheckOptions | SendTestOptions;

function optionValue(
  args: readonly string[],
  index: number,
  name: string,
): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

export function parseVerificationOptions(
  args: readonly string[],
): VerificationOptions {
  let mode: VerificationOptions['mode'] = 'preview';
  let recipientAddress: string | undefined;
  let confirmedAccount: string | undefined;
  let confirmedRegion: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--check' || argument === '--send-test') {
      const requestedMode = argument === '--check' ? 'check' : 'send-test';
      if (mode !== 'preview') {
        throw new Error('Choose exactly one of --check or --send-test.');
      }
      mode = requestedMode;
      continue;
    }
    if (argument === '--recipient') {
      if (recipientAddress !== undefined) {
        throw new Error('--recipient may be supplied only once.');
      }
      recipientAddress = optionValue(args, index, '--recipient');
      index += 1;
      continue;
    }
    if (argument === '--confirm-account' || argument === '--confirm-region') {
      const isAccount = argument === '--confirm-account';
      if (
        (isAccount && confirmedAccount !== undefined) ||
        (!isAccount && confirmedRegion !== undefined)
      ) {
        throw new Error(`${argument} may be supplied only once.`);
      }
      const value = optionValue(args, index, argument);
      if (isAccount) {
        confirmedAccount = value;
      } else {
        confirmedRegion = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${terminalSafeText(argument ?? '')}`);
  }

  if (mode === 'preview') {
    if (
      recipientAddress !== undefined ||
      confirmedAccount !== undefined ||
      confirmedRegion !== undefined
    ) {
      throw new Error('Target confirmations require --check or --send-test.');
    }
    return { mode };
  }
  assertConfirmedTarget(confirmedAccount, confirmedRegion);
  if (mode !== 'send-test' && recipientAddress !== undefined) {
    throw new Error('--recipient is valid only with --send-test.');
  }
  if (mode === 'send-test') {
    if (recipientAddress === undefined || !isEmailAddress(recipientAddress)) {
      throw new Error(
        '--send-test requires one valid runtime --recipient address.',
      );
    }
    return {
      confirmedAccount: TARGET_ACCOUNT_ID,
      confirmedRegion: TARGET_REGION,
      mode,
      recipientAddress,
    };
  }
  return {
    confirmedAccount: TARGET_ACCOUNT_ID,
    confirmedRegion: TARGET_REGION,
    mode,
  };
}

function sourceIdentityFailures(identity: SesEmailIdentitySnapshot): string[] {
  const failures: string[] = [];
  if (identity.identityType !== 'DOMAIN') {
    failures.push('identity type is not DOMAIN');
  }
  if (identity.verificationStatus !== 'SUCCESS') {
    failures.push('identity verification is not SUCCESS');
  }
  if (identity.verifiedForSendingStatus !== true) {
    failures.push('identity is not verified for sending');
  }
  if (identity.dkimSigningEnabled !== true) {
    failures.push('DKIM signing is not enabled');
  }
  if (identity.dkimStatus !== 'SUCCESS') {
    failures.push('DKIM status is not SUCCESS');
  }
  if (identity.mailFromDomain !== SES_MAIL_FROM_DOMAIN) {
    failures.push('MAIL FROM domain does not match the expected domain');
  }
  if (identity.mailFromDomainStatus !== 'SUCCESS') {
    failures.push('MAIL FROM status is not SUCCESS');
  }
  if (identity.configurationSetName !== SES_CONFIGURATION_SET_NAME) {
    failures.push('default configuration set does not match');
  }
  return failures;
}

function assertSourceReady(
  account: SesAccountSnapshot,
  identity: SesEmailIdentitySnapshot,
): void {
  const failures = sourceIdentityFailures(identity);
  if (account.sendingEnabled !== true) {
    failures.unshift('account sending is not enabled');
  }
  if (failures.length > 0) {
    throw new Error(`SES identity is not ready: ${failures.join('; ')}.`);
  }
}

function assertRecipientReady(identity: SesEmailIdentitySnapshot): void {
  if (
    identity.identityType !== 'EMAIL_ADDRESS' ||
    identity.verificationStatus !== 'SUCCESS' ||
    identity.verifiedForSendingStatus !== true
  ) {
    throw new Error(
      'The exact test recipient is not a separately verified SUCCESS email identity.',
    );
  }
}

async function readSourceReadiness(api: SesOperationsApi): Promise<{
  readonly account: SesAccountSnapshot;
  readonly identity: SesEmailIdentitySnapshot;
}> {
  const account = await api.getAccount();
  const identity = await api.getEmailIdentity(SES_IDENTITY_DOMAIN);
  assertSourceReady(account, identity);
  return { account, identity };
}

function printOfflinePreview(runtime: CliRuntime): void {
  runtime.stdout(
    'OFFLINE PREVIEW: no AWS client was created and no API was called.',
  );
  runtime.stdout(
    `Target: account ${TARGET_ACCOUNT_ID}, region ${TARGET_REGION}, identity ${SES_IDENTITY_DOMAIN}.`,
  );
  runtime.stdout(
    `Read-only identity/DKIM/MAIL FROM check: --check --confirm-account ${TARGET_ACCOUNT_ID} --confirm-region ${TARGET_REGION}.`,
  );
  runtime.stdout(
    `A test send is a live provider write reserved for an authorized human: --send-test --confirm-account ${TARGET_ACCOUNT_ID} --confirm-region ${TARGET_REGION} --recipient <approved-verified-synthetic-address>.`,
  );
}

export async function runVerification(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<void> {
  const options = parseVerificationOptions(args);
  if (options.mode === 'preview') {
    printOfflinePreview(runtime);
    return;
  }

  if (options.mode === 'send-test') {
    assertMutationAllowed(runtime);
  }

  const api = await runtime.createApi();
  await assertTargetAccount(api);
  const { account } = await readSourceReadiness(api);

  if (options.mode === 'check') {
    runtime.stdout(
      `SES identity readiness check passed for ${SES_IDENTITY_DOMAIN}; productionAccessEnabled=${String(account.productionAccessEnabled ?? 'unknown')}.`,
    );
    runtime.stdout('No email was sent.');
    return;
  }

  if (account.productionAccessEnabled === undefined) {
    throw new Error(
      'SES production-access state is unknown; no test email can be sent.',
    );
  }

  let recipientIdentity: SesEmailIdentitySnapshot;
  try {
    recipientIdentity = await api.getEmailIdentity(options.recipientAddress);
  } catch {
    throw new Error(
      'Exact-recipient verification failed with a redacted provider error; no email was sent.',
    );
  }
  assertRecipientReady(recipientIdentity);
  runtime.stdout(
    `Consequence preview: productionAccessEnabled=${String(account.productionAccessEnabled ?? 'unknown')}; send exactly one unmistakable TEST ONLY message from ${SES_TEST_FROM_ADDRESS} to one approved synthetic target (address redacted) using configuration set ${SES_CONFIGURATION_SET_NAME}.`,
  );
  const confirmation = await runtime.confirm(
    `Type exactly: ${TEST_SEND_CONFIRMATION}`,
  );
  if (confirmation !== TEST_SEND_CONFIRMATION) {
    throw new Error('Confirmation did not match; no email was sent.');
  }
  const recipientConfirmation = await runtime.confirm(
    'Retype the exact approved recipient address:',
  );
  if (recipientConfirmation !== options.recipientAddress) {
    throw new Error('Recipient retype did not match; no email was sent.');
  }

  let result: { readonly messageId?: string };
  try {
    result = await api.sendTestEmail({
      configurationSetName: SES_CONFIGURATION_SET_NAME,
      fromAddress: SES_TEST_FROM_ADDRESS,
      recipientAddress: options.recipientAddress,
      subject: TEST_EMAIL_SUBJECT,
      textBody: TEST_EMAIL_BODY,
    });
  } catch {
    throw new Error(
      'SES test-send outcome is unknown. Do not retry until mailbox and event evidence resolve provider acceptance and delivery state.',
    );
  }
  if (result.messageId === undefined || result.messageId.length === 0) {
    throw new Error(
      'SES test-send outcome is unknown because no MessageId was returned. Do not retry until mailbox and event evidence resolve provider acceptance and delivery state.',
    );
  }
  runtime.stdout(
    `SES provider-accepted one TEST ONLY message (MessageId=${terminalSafeText(result.messageId)}). This is not proof of delivery or human receipt.`,
  );
}

export async function verificationMain(
  args: readonly string[],
  runtime: CliRuntime = createDefaultRuntime(),
): Promise<number> {
  try {
    await runVerification(args, runtime);
    return 0;
  } catch (error) {
    runtime.stderr(`ERROR: ${errorMessage(error)}`);
    return 1;
  }
}
