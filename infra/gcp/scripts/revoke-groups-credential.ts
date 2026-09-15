import {
  assertRosterReaderCredentialBoundary,
  listUserManagedKeys,
  normalizeApprovedStaffGroup,
  PROJECT_ID,
  readGroupsReaderContract,
  readRevocableUserManagedKeyCreatedAt,
  type GroupsReaderContract,
} from './groups-contract';
import {
  AWS_ACCOUNT_ID,
  assertActiveGcloudAccount,
  assertApplicationDefaultIdentity,
  assertAwsAccount,
  awsSecretExists,
  readSecretValue,
  requiredString,
  requireExactConfirmation,
  runCommand,
} from './runtime';
import { validateStoredCredential } from './verify-groups-readonly';

const AWS_PROFILE = 'psd401-prr-prod';
const AWS_REGION = 'us-west-2';
const SECRET_NAME = '/psd-eoc/google-groups';
const TERRAFORM_ADMIN = 'kjh_admin@psd401.net';

interface RevocationContract {
  readonly contract: GroupsReaderContract;
  readonly privateKeyId: string;
}

function assertGroupsSecretDestination(): void {
  assertAwsAccount(AWS_PROFILE, AWS_ACCOUNT_ID, AWS_REGION);
  if (
    !awsSecretExists({
      expectedAccountId: AWS_ACCOUNT_ID,
      profile: AWS_PROFILE,
      region: AWS_REGION,
      secretName: SECRET_NAME,
    })
  ) {
    throw new Error(
      'The retained AWS Groups credential secret does not exist.',
    );
  }
}

async function readRevocationContract(
  approvedGroup: string,
): Promise<RevocationContract> {
  assertActiveGcloudAccount(TERRAFORM_ADMIN);
  await assertApplicationDefaultIdentity(TERRAFORM_ADMIN);
  const contract = readGroupsReaderContract();
  assertRosterReaderCredentialBoundary(contract);
  assertGroupsSecretDestination();
  const credential = readSecretValue({
    profile: AWS_PROFILE,
    region: AWS_REGION,
    secretName: SECRET_NAME,
  });
  assertGroupsSecretDestination();
  const privateKeyId = requiredString(credential, 'private_key_id');
  const liveKeys = listUserManagedKeys(contract);
  if (liveKeys.size !== 1 || !liveKeys.has(privateKeyId)) {
    throw new Error(
      'Rotation requires exactly the one Google key stored in AWS.',
    );
  }
  const liveCredentialCreatedAt = readRevocableUserManagedKeyCreatedAt(
    contract,
    privateKeyId,
  );
  validateStoredCredential(
    credential,
    contract,
    approvedGroup,
    liveCredentialCreatedAt,
  );
  assertRosterReaderCredentialBoundary(contract);
  assertGroupsSecretDestination();
  return { contract, privateKeyId };
}

async function main(): Promise<void> {
  if (process.argv.slice(2).length > 0) {
    throw new Error('This helper accepts no command-line options.');
  }
  const approvedGroup = normalizeApprovedStaffGroup(
    process.env.PSD_EOC_APPROVED_TEST_GROUP,
  );
  await readRevocationContract(approvedGroup);

  await requireExactConfirmation(
    'Groups credential revocation preview: revoke the exact live roster-reader Google key currently bound to the AWS secret. Roster sync will fail closed and must use its last versioned snapshot until provisioning and live verification of the replacement key finish. No AWS secret, group, notification, or human-only action is changed.',
    'revoke-psd-eoc-readonly-groups-key',
  );
  const { contract, privateKeyId } =
    await readRevocationContract(approvedGroup);

  try {
    runCommand(
      'gcloud',
      [
        'iam',
        'service-accounts',
        'keys',
        'delete',
        privateKeyId,
        '--iam-account',
        contract.email,
        '--project',
        PROJECT_ID,
        '--quiet',
      ],
      { redactFailureOutput: true },
    );
  } catch {
    // A lost response can follow a successful revocation; prove the end state.
  }

  const remainingKeys = listUserManagedKeys(contract);
  if (remainingKeys.size !== 0) {
    throw new Error(
      'Google did not prove that only the AWS-bound roster-reader key was revoked; reconcile keys before provisioning.',
    );
  }
  assertRosterReaderCredentialBoundary(contract);
  console.log(
    'PASS: revoked the exact AWS-bound Google key. While issue #68 is undeployed, keep this credential disconnected from scheduled roster sync; after #68, require both replacement credential proof and an application-level approved staff-only sync. No credential value was printed.',
  );
}

if (import.meta.main) {
  await main();
}
