import {
  DISTRICT_WEBSITE_URL,
  PRODUCTION_ACCESS_CONFIRMATION,
  PRODUCTION_ACCESS_USE_CASE,
  TARGET_ACCOUNT_ID,
  TARGET_REGION,
  assertConfirmedTarget,
  assertMutationAllowed,
  assertTargetAccount,
  createDefaultRuntime,
  errorMessage,
  isEmailAddress,
  terminalSafeText,
  type CliRuntime,
  type ProductionAccessRequest,
  type SesAccountSnapshot,
} from './ses-common';

interface PreviewOptions {
  readonly mode: 'preview';
}

interface CheckOptions {
  readonly confirmedAccount: string;
  readonly confirmedRegion: string;
  readonly mode: 'check';
}

interface SubmitOptions {
  readonly contactEmail: string;
  readonly confirmedAccount: string;
  readonly confirmedRegion: string;
  readonly mode: 'submit';
}

type ProductionAccessOptions = PreviewOptions | CheckOptions | SubmitOptions;

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

export function parseProductionAccessOptions(
  args: readonly string[],
): ProductionAccessOptions {
  let mode: ProductionAccessOptions['mode'] = 'preview';
  let contactEmail: string | undefined;
  let confirmedAccount: string | undefined;
  let confirmedRegion: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--check' || argument === '--submit') {
      const requestedMode = argument.slice(2) as 'check' | 'submit';
      if (mode !== 'preview') {
        throw new Error('Choose exactly one of --check or --submit.');
      }
      mode = requestedMode;
      continue;
    }
    if (argument === '--contact-email') {
      if (contactEmail !== undefined) {
        throw new Error('--contact-email may be supplied only once.');
      }
      contactEmail = optionValue(args, index, '--contact-email');
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
    throw new Error('Unknown argument (value redacted).');
  }

  if (mode === 'preview') {
    if (
      contactEmail !== undefined ||
      confirmedAccount !== undefined ||
      confirmedRegion !== undefined
    ) {
      throw new Error('Target confirmations require --check or --submit.');
    }
    return { mode };
  }
  assertConfirmedTarget(confirmedAccount, confirmedRegion);
  if (mode !== 'submit' && contactEmail !== undefined) {
    throw new Error('--contact-email is valid only with --submit.');
  }
  if (mode === 'submit') {
    if (
      contactEmail === undefined ||
      !isEmailAddress(contactEmail) ||
      contactEmail.toLowerCase().endsWith('.invalid') ||
      contactEmail.toUpperCase().includes('REPLACE_ME')
    ) {
      throw new Error(
        '--submit requires one valid non-placeholder runtime --contact-email address.',
      );
    }
    return {
      confirmedAccount: TARGET_ACCOUNT_ID,
      confirmedRegion: TARGET_REGION,
      contactEmail,
      mode,
    };
  }
  return {
    confirmedAccount: TARGET_ACCOUNT_ID,
    confirmedRegion: TARGET_REGION,
    mode,
  };
}

function accountValue(value: boolean | undefined): string {
  return value === undefined ? 'unknown' : String(value);
}

function describeAccount(account: SesAccountSnapshot): string {
  return [
    `productionAccessEnabled=${accountValue(account.productionAccessEnabled)}`,
    `sendingEnabled=${accountValue(account.sendingEnabled)}`,
    `reviewStatus=${terminalSafeText(account.reviewStatus ?? 'unknown')}`,
  ].join('; ');
}

function assertSubmissionState(
  account: SesAccountSnapshot,
): 'initial' | 'retry' {
  const { productionAccessEnabled, reviewStatus, sendingEnabled } = account;
  if (productionAccessEnabled !== false || sendingEnabled !== true) {
    throw new Error(
      `SES account state is not safe for a production-access request: ${describeAccount(account)}.`,
    );
  }
  if (reviewStatus === undefined) {
    return 'initial';
  }
  if (reviewStatus === 'FAILED') {
    return 'retry';
  }
  throw new Error(
    `SES review state ${terminalSafeText(reviewStatus)} does not permit submission.`,
  );
}

function productionAccessRequest(
  contactEmail: string,
): ProductionAccessRequest {
  return {
    additionalContactEmailAddresses: [contactEmail],
    contactLanguage: 'EN',
    mailType: 'TRANSACTIONAL',
    productionAccessEnabled: true,
    useCaseDescription: PRODUCTION_ACCESS_USE_CASE,
    websiteUrl: DISTRICT_WEBSITE_URL,
  };
}

function printOfflinePreview(runtime: CliRuntime): void {
  runtime.stdout(
    'OFFLINE PREVIEW: no AWS client was created and no API was called.',
  );
  runtime.stdout(
    `Target: account ${TARGET_ACCOUNT_ID}, region ${TARGET_REGION}; SES transactional production-access request only.`,
  );
  runtime.stdout(
    'The request is staff-only, approximately 1,200 opt-in recipients, no marketing, no purchased lists, and no student data.',
  );
  runtime.stdout(
    `Read-only inventory: --check --confirm-account ${TARGET_ACCOUNT_ID} --confirm-region ${TARGET_REGION}.`,
  );
  runtime.stdout(
    `Human-only request: --submit --confirm-account ${TARGET_ACCOUNT_ID} --confirm-region ${TARGET_REGION} --contact-email <approved-runtime-address>.`,
  );
}

export async function runProductionAccess(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<void> {
  const options = parseProductionAccessOptions(args);
  if (options.mode === 'preview') {
    printOfflinePreview(runtime);
    return;
  }

  if (options.mode === 'submit') {
    assertMutationAllowed(runtime);
  }

  const api = await runtime.createApi();
  await assertTargetAccount(api);
  const account = await api.getAccount();

  if (options.mode === 'check') {
    runtime.stdout(`Read-only SES account check: ${describeAccount(account)}.`);
    runtime.stdout('No production-access request was submitted.');
    return;
  }

  if (
    account.productionAccessEnabled === true &&
    account.sendingEnabled === true &&
    account.reviewStatus === 'GRANTED'
  ) {
    runtime.stdout(
      'SES production access is already granted and sending is enabled; no request was submitted.',
    );
    return;
  }
  if (
    account.productionAccessEnabled === false &&
    account.reviewStatus === 'PENDING'
  ) {
    runtime.stdout(
      'An SES production-access review is already pending; no request was submitted.',
    );
    return;
  }
  if (account.reviewStatus === 'DENIED') {
    throw new Error(
      'The prior SES production-access request was denied. Resolve it with AWS before any resubmission.',
    );
  }

  const requestKind = assertSubmissionState(account);
  runtime.stdout(
    `Consequence preview: ${requestKind === 'retry' ? 'retry' : 'submit'} an SES production-access request for ${TARGET_ACCOUNT_ID}/${TARGET_REGION} with one runtime contact address (redacted); no email will be sent by this operation.`,
  );
  const confirmation = await runtime.confirm(
    `Type exactly: ${PRODUCTION_ACCESS_CONFIRMATION}`,
  );
  if (confirmation !== PRODUCTION_ACCESS_CONFIRMATION) {
    throw new Error('Confirmation did not match; no request was submitted.');
  }

  try {
    await api.putAccountDetails(productionAccessRequest(options.contactEmail));
  } catch {
    throw new Error(
      'SES production-access submission outcome is unknown. Do not retry; run the read-only --check command first.',
    );
  }
  runtime.stdout(
    'SES production-access request submitted. AWS approval is still pending; this does not mean production access was granted.',
  );
}

export async function productionAccessMain(
  args: readonly string[],
  runtime: CliRuntime = createDefaultRuntime(),
): Promise<number> {
  try {
    await runProductionAccess(args, runtime);
    return 0;
  } catch (error) {
    runtime.stderr(`ERROR: ${errorMessage(error)}`);
    return 1;
  }
}
