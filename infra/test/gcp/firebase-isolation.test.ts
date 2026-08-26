import { describe, expect, test } from 'bun:test';

const firebaseRoot = new URL('../../gcp/firebase/', import.meta.url);
const groupsRoot = new URL('../../gcp/', import.meta.url);

async function contents(root: URL, names: readonly string[]): Promise<string> {
  return (
    await Promise.all(names.map((name) => Bun.file(new URL(name, root)).text()))
  ).join('\n');
}

describe('isolated Firebase Terraform root', () => {
  test('keeps Firebase resources completely out of the Groups root', async () => {
    const groups = await contents(groupsRoot, [
      'main.tf',
      'providers.tf',
      'variables.tf',
      'versions.tf',
    ]);
    expect(groups).not.toContain('google_firebase_project');
    expect(groups).not.toContain('google_firebase_android_app');
    expect(groups).not.toContain('google-beta');
    expect(groups).not.toContain('firebase.googleapis.com');
  });

  test('uses an independent project, backend prefix, and beta provider', async () => {
    const firebase = await contents(firebaseRoot, [
      'main.tf',
      'outputs.tf',
      'providers.tf',
      'variables.tf',
      'versions.tf',
    ]);
    const groupsVersions = await Bun.file(
      new URL('versions.tf', groupsRoot),
    ).text();
    expect(firebase).toContain('google_firebase_project');
    expect(firebase).toContain('google_firebase_android_app');
    expect(firebase).toContain('hashicorp/google-beta');
    expect(firebase).toContain('terraform/gcp/firebase-isolated');
    expect(firebase).not.toContain('terraform/gcp"');
    expect(firebase).not.toContain(
      groupsVersions.match(/bucket\s*=\s*"([^"]+)"/u)?.[1] ?? 'groups-state',
    );
  });

  test('cannot grant roster, Groups, state-bucket, or service-account authority', async () => {
    const firebase = await contents(firebaseRoot, [
      'main.tf',
      'outputs.tf',
      'providers.tf',
      'variables.tf',
      'versions.tf',
    ]);
    for (const forbidden of [
      'google_project_iam_',
      'google_service_account',
      'google_storage_bucket',
      'cloudidentity.googleapis.com',
      'admin.googleapis.com',
      'cloud-identity.groups',
      'roster-sync-reader',
    ]) {
      expect(firebase).not.toContain(forbidden);
    }
    expect(firebase).toContain('application_writes_google_groups = false');
    expect(firebase).toContain('project_iam_bindings             = []');
    expect(firebase).toContain('service_accounts                 = []');
  });

  test('registers one exact Android app and no Firebase product datastore', async () => {
    const main = await Bun.file(new URL('main.tf', firebaseRoot)).text();
    expect(
      main.match(/resource\s+"google_firebase_android_app"/gu),
    ).toHaveLength(1);
    expect(main).toContain('package_name    = var.android_package_name');
    for (const forbidden of [
      'google_firestore_',
      'google_firebase_hosting_',
      'google_storage_bucket',
      'google_firebase_database_',
    ]) {
      expect(main).not.toContain(forbidden);
    }
  });
});
