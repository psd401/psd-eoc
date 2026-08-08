import {
  assertNoProjectIamBinding,
  listUserManagedKeys,
  normalizeApprovedStaffGroup,
  PROJECT_ID,
  readGroupsReaderContract,
  readUserManagedKeyCreatedAt,
} from './groups-contract';
import {
  assertActiveGcloudAccount,
  assertApplicationDefaultIdentity,
  assertAwsAccount,
  readSecretValue,
  requiredString,
  requireExactConfirmation,
  runCommand,
} from './runtime';
import { validateStoredCredential } from './verify-groups-readonly';

const AWS_ACCOUNT_ID = '338414773271';
const AWS_PROFILE = 'psd401-prr-prod';
const AWS_REGION = 'us-west-2';
const SECRET_NAME = '/psd-eoc/google-groups';
const TERRAFORM_ADMIN = 'kjh_admin@psd401.net';

async function main(): Promise<void> {
  if (process.argv.slice(2).length > 0) {
    throw new Error('This helper accepts no command-line options.');
  }
  const approvedGroup = normalizeApprovedStaffGroup(
    process.env.PSD_EOC_APPROVED_TEST_GROUP,
  );
  assertActiveGcloudAccount(TERRAFORM_ADMIN);
  await assertApplicationDefaultIdentity(TERRAFORM_ADMIN);
  const contract = readGroupsReaderContract();
  assertNoProjectIamBinding(contract);
  assertAwsAccount(AWS_PROFILE, AWS_ACCOUNT_ID, AWS_REGION);
  const credential = readSecretValue({
    profile: AWS_PROFILE,
    region: AWS_REGION,
    secretName: SECRET_NAME,
  });
  const privateKeyId = requiredString(credential, 'private_key_id');
  const liveKeys = listUserManagedKeys(contract);
  if (liveKeys.size !== 1 || !liveKeys.has(privateKeyId)) {
    throw new Error(
      'Rotation requires exactly the one Google key stored in AWS.',
    );
  }
  const liveCredentialCreatedAt = readUserManagedKeyCreatedAt(
    contract,
    privateKeyId,
    false,
  );
  validateStoredCredential(
    credential,
    contract,
    approvedGroup,
    liveCredentialCreatedAt,
  );

  await requireExactConfirmation(
    'Groups credential revocation preview: revoke the exact live roster-reader Google key currently bound to the AWS secret. Roster sync will fail closed and must use its last versioned snapshot until provisioning and live verification of the replacement key finish. No AWS secret, group, notification, or human-only action is changed.',
    'revoke-psd-eoc-readonly-groups-key',
  );

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
  console.log(
    'PASS: revoked the exact AWS-bound Google key. Provision and live-verify its replacement before re-enabling roster sync; no credential value was printed.',
  );
}

if (import.meta.main) {
  await main();
}
