# PSD EOC Google Cloud identity project

This Terraform root owns the Google control plane used by PSD EOC. The
application remains in AWS account `338414773271`; this project supplies Google
Auth Platform configuration and read-only Google Groups access for cached,
versioned staff rosters. Google is never called in the activation path.

Nothing here can start an incident, send a notification, issue an all-clear,
close an event, or write a Google Group. The roster-reader service account has
no direct project IAM binding from this root, uses the Workspace **Groups
Reader** role instead of domain-wide delegation, and the runtime requests only
`https://www.googleapis.com/auth/cloud-identity.groups.readonly` at runtime.

## Fixed district targets

- Project: `psd401-eoc` (`PSD EOC`)
- Organization: `482073499306`, directly under the organization like PSD Maps
- Billing account: `01760A-35A65E-94FB90`
- Region: `us-west1`
- Terraform administrator: `kjh_admin@psd401.net`
- State: `gs://psd401-eoc-terraform-state/terraform/gcp/default.tfstate`
- Web origin: `https://eoc.psd401.net`
- Web callback: `https://eoc.psd401.net/auth/callback`
- iOS bundle ID and Android package: `net.psd401.eoc`
- AWS profile/account/region: `psd401-prr-prod` / `338414773271` /
  `us-west-2`

Project and service-account deletion are blocked in both the provider and
Terraform lifecycle. State-bucket destruction is blocked by Terraform
`prevent_destroy` and `force_destroy=false`. The bucket has uniform access,
public-access prevention, and versioning; archived object versions become
eligible for deletion only after 90 days have elapsed since that version became
noncurrent. Object creation age is not used, and lifecycle execution may occur
later than the eligibility threshold. The bucket deliberately has no retention
policy because the GCS backend must delete its short-lived lock object when each
operation ends. Its authoritative bucket policy grants only the fixed human
Terraform administrator `roles/storage.objectAdmin`, the minimum role required
by the GCS backend. Legacy project Owner/Editor/Viewer convenience principals,
groups, domains, service accounts, public principals, extra roles, and
conditional bindings are not accepted in that bucket policy.

## Apply from this machine

Authenticate as the fixed district administrator. Never use a static AWS key or
a service-account credential for Terraform.

```sh
gcloud auth login kjh_admin@psd401.net --force
gcloud auth application-default login kjh_admin@psd401.net \
  --disable-quota-project \
  --scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/cloud-platform
aws sso login --profile psd401-prr-prod
```

The ordinary ADC login deliberately writes no quota project, even if another
gcloud configuration has an active project. The guarded helpers reject ADC
metadata bound to any project other than `psd401-eoc` and discard inherited
Google billing/quota/project overrides. They also reject persistent gcloud
billing/quota configuration, and every project API call names `psd401-eoc`
explicitly. After bootstrap creates the dedicated project, the main Terraform
provider pins user-project quota and billing to `psd401-eoc`; the bootstrap
provider cannot do so before that project exists.

Review formatting and validity, then run the guarded helper from this directory:

```sh
terraform fmt -check -recursive
terraform init -backend=false -input=false
terraform validate
bun scripts/apply.ts
```

The first run uses `bootstrap/` to create only the billed project, Service
Usage, Storage, Cloud Resource Manager, and Cloud Billing API prerequisites,
and the private state bucket in local bootstrap state. Cloud Resource Manager
and Cloud Billing must be enabled before the main provider charges its project
refreshes to `psd401-eoc`; enabling them in the main root would create a fresh-
project quota cycle. The helper then initializes the main GCS backend, imports
those six resources plus the authoritative bucket policy, applies the remaining
APIs/IAM/service account remotely, proves zero drift, and removes the duplicate
resource addresses from bootstrap state. Google initially creates its four
legacy project convenience bindings with a bucket. The same saved bootstrap
plan replaces them with the single administrator Object Admin binding before
the main backend is initialized. An interrupted run can adopt only that exact
known initial policy and immediately finish the replacement; any other policy
fails closed. Recovery also validates the exact organization, billing account,
labels, Owner policy, and already-enabled APIs before importing anything.

Both mutations use saved Terraform plans and a helper-owned exact confirmation;
inherited `TF_CLI_ARGS*`, `TF_WORKSPACE`, and Google credential overrides are
discarded. Every Terraform state or output read also requires the persisted
workspace to be exactly `default`; a stale `.terraform/environment` cannot
redirect a helper to another workspace. The confirmation phrases are shown only
after the complete plans. There is no auto-approve path. Do not confirm either
plan without explicit product-owner approval for the billed, retained
infrastructure described in the preview.

No private key or OAuth secret is a Terraform resource, input, or output.

Google automatically grants a new project's creator `roles/owner`. The bootstrap
preflight permits only that exact automatic grant to the fixed administrator;
any other direct Owner blocks the apply. The saved main plan first grants the
declared narrower roles, including Project Mover for project-metadata updates
and Project Billing Manager for the fixed billing association, plus Project IAM
Admin for Terraform-managed allow-policy changes, then
`google_project_iam_member_remove` removes the creator's Owner membership. The
billing-account-side permission needed to keep that association is an existing
organization prerequisite, not a project grant from this root. The final live
policy read requires no direct Owner binding, and the negative resource removes
that exact membership again if it is restored out of band.

Project IAM Admin can change the project's allow policy and therefore remains a
privilege-escalation-capable administration role. That authority is unavoidable
while this human-run root manages its own IAM bindings; it is narrower than a
standing basic Owner role and cannot be replaced by an unapproved automation
principal in this issue. This human administrator access does not grant any
role to the roster-reader service account.

## Workspace Groups Reader assignment

Google supports assigning a Workspace administrator role directly to a service
account through the Admin SDK Role Assignments API. PSD EOC resolves the
tenant-specific ID of the built-in `_GROUPS_READER_ROLE`, verifies that it is a
non-super-admin system role, assigns it to the Terraform service-account unique
ID, and reads the assignment back:

```sh
PSD_EOC_CONFIRM_WORKSPACE_ROLE_ASSIGNMENT=assign-groups-reader-to-roster-sync-reader \
  bun scripts/configure-workspace-role.ts
```

The helper is idempotent, allows only Admin SDK GETs plus the one role-assignment
POST, and refuses any other direct or indirect administrator role affecting
that service account. It requires Super Admin Application Default Credentials
with one non-Cloud scope:
`https://www.googleapis.com/auth/admin.directory.rolemanagement`. The login
also retains `openid`, `userinfo.email`, and `cloud-platform` so gcloud can
verify the fixed administrator identity and run the other guarded checks. The
ordinary Cloud-only ADC above does not contain the Workspace scope.

Google requires a separately authorized OAuth client for non-Cloud ADC scopes.
If the district already has an approved internal Desktop OAuth client for
administrator tooling, authorize it from a secure, mode-`0600` download outside
the repository:

```sh
gcloud auth application-default login kjh_admin@psd401.net \
  --client-id-file=/secure/workspace-admin-client.json \
  --scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/admin.directory.rolemanagement
```

Delete the download after authorization. The live credential verifier below
rechecks all direct and indirect role assignments, so retain this temporary ADC
only through that immediate proof. If the proof will not run immediately,
revoke it now and repeat the scoped authorization immediately before the
verifier. Supplying the same account to another login is not sufficient because
gcloud may reuse the existing refresh credential. Explicitly revoke it, then
restore the ordinary identity/Cloud-only ADC:

```sh
gcloud auth application-default revoke --quiet
gcloud auth application-default login kjh_admin@psd401.net \
  --disable-quota-project \
  --scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/cloud-platform
```

If no approved administrator-tool OAuth client exists, the exact residual
console fallback is:

1. Sign in to `admin.google.com` as a Workspace Super Admin.
2. Open **Menu → Account → Admin roles**.
3. Point to **Groups Reader**, then select **Assign admin → Assign service
   accounts**.
4. Enter `roster-sync-reader@psd401-eoc.iam.gserviceaccount.com`.
5. Do not add a condition: Workspace conditions distinguish security/locked
   labels, not the approved staff-only roster allowlist.
6. Select **Add → Assign role**.

The Role Assignments API exists; the residual is the human OAuth authorization
needed to call it as a Super Admin, not an API gap. Direct Groups Reader avoids
person impersonation and records runtime reads as the service account. The role
can read groups across the tenant, so the application-side approved staff-group
allowlist remains mandatory and is checked before every verification request.
The console fallback alone cannot satisfy the automated live-role recheck: an
approved administrator-tool OAuth client and temporary role-management ADC are
still required before the verifier can report PASS.

Workspace exposes no supported API that lists domain-wide delegation grants.
Before recording a live verification, a Super Admin must therefore open
**Menu → Security → Access and data control → API Controls → Manage Domain Wide
Delegation** and confirm that the fixed service account's OAuth 2 client ID has
no grant. Read that non-secret ID directly from the fixed live account:

```sh
gcloud iam service-accounts describe \
  roster-sync-reader@psd401-eoc.iam.gserviceaccount.com \
  --project=psd401-eoc --format='value(oauth2ClientId)'
```

Do not substitute the distinct `service_account_unique_id` from Terraform: the
Workspace role-assignment API uses that stable IAM unique ID, while credentials
and domain-wide delegation use the OAuth 2 client ID. The helpers read both from
the same fixed live service account, require its unique ID to match the guarded
Terraform output, and require every generated credential's client ID to match
the live OAuth 2 client ID. This is a negative safety check only; do not add a
grant. Record the human confirmation as PR evidence without copying any
unrelated tenant client IDs.

## Read-only Groups credential and live proof

Have the product owner identify one synthetic or otherwise explicitly approved
**staff-only** test group outside the repository and record that approval in the
issue/PR without placing the address in Git. The helper cannot certify that an
operator-supplied address is staff-only. Never use a student, guardian, or
production notification audience. The address is hashed before storage and is
never printed.

```sh
export PSD_EOC_APPROVED_TEST_GROUP='APPROVED_STAFF_TEST_GROUP@psd401.net'
bun scripts/provision-groups-credential.ts
bun scripts/verify-groups-readonly.ts
```

Provisioning presents a consequence preview and requires the exact phrase
`store-psd-eoc-readonly-groups-key` before it creates either the AWS secret or
Google key. Enter it only with explicit product-owner approval.

Provisioning verifies the Terraform output, live project IAM policy, AWS account
`338414773271`, the exact live direct/indirect Workspace role state, and absence
of any existing user-managed key. Before writing, it requires the secret's
fixed account/Region ARN and ownership tags, AWS-managed encryption, no pending
deletion, automatic rotation, replica, external owner, or resource policy; a
new placeholder is read back against the same contract. It creates
`/psd-eoc/google-groups` when absent, writes one key directly to an idempotent
Secrets Manager version, and captures gcloud's supported stdout output so the
private key is never written to a local file. A failed AWS write deletes only
the newly identified key; an ambiguous AWS result is read back before cleanup,
and ambiguous key identity is never deleted.

The project-policy check rejects the exact service-account member plus direct
project bindings to universal principals, domains, groups, project convenience
principals, Google public principal sets, and Resource Manager service-account
sets that could include it. Google does not expose group-expanded ancestor IAM
in that project-policy response. Before `live-verified`, a district
administrator must still confirm the service account is not a member of a
Google Group granted a role on an ancestor and is not otherwise covered by an
ancestor IAM binding. Record only that result, not unrelated group membership or
IAM identities. The helper and PR must not describe the direct-policy check as
proof of no effective inherited access.

The verifier binds the AWS credential back to the exact Terraform project,
service-account email and unique ID, live OAuth 2 client ID, Groups Reader role,
one OAuth scope, approved group hash, and Google's live key creation timestamp.
It rejects a key older than 30 days and requires exactly that one user-managed
key. Using the temporary administrator ADC described above, it also queries
Workspace role assignments by the service-account unique ID with indirect
assignments included and requires exactly one direct Groups Reader assignment.
It then uses a
service-account JWT with no delegated subject, performs only `groups.lookup`
and `memberships.list` GETs, requests `fields=nextPageToken` for the membership
proof, discards the response body, and prints no group, member, token, or
credential value.

### Runtime compatibility boundary

The infrastructure contract in this directory is not currently the contract
consumed by the merged production roster job.
`packages/server/lib/roster/groups-sync.ts` calls the Admin SDK Directory API
with `admin.directory.group.member.readonly`, requires
`GOOGLE_ROSTER_DELEGATED_SUBJECT`, and signs a JWT with a `sub` claim.
`packages/server/app/api/jobs/roster-sync/route.ts` uses only that adapter,
while the AWS App Runner stack does not inject `/psd-eoc/google-groups`.
[Issue #68](https://github.com/psd401/psd-eoc/issues/68) owns replacing that
path with this non-delegated Cloud Identity contract and wiring the existing
secret into the runtime.

Until issue #68 is deployed, the end-to-end Google Groups roster integration
is `blocked`. A pass from the helper in this directory proves only that this
credential has the exact live Workspace role and can perform the approved
read-only Cloud Identity calls against the approved test group; it does not
prove that the application can sync a roster. Do not add domain-wide delegation,
a delegated subject, or the broader Admin Directory scope as a workaround. Do
not enable the scheduled roster job with this credential. The application must
fail closed and retain its last complete, versioned snapshot.

### Credential rotation and revocation

Rotate the Groups key at least every 30 days and immediately after any suspected
exposure or administrator change. The deliberate one-key invariant makes this a
short fail-closed maintenance window instead of temporarily retaining two
tenant-wide credentials:

1. Pause scheduled roster sync and verify the application has an approved,
   versioned cached roster snapshot. Notifications continue to resolve only
   from that snapshot; Google is never called in the activation path.
2. With the same `PSD_EOC_APPROVED_TEST_GROUP` value, run
   `bun scripts/revoke-groups-credential.ts`. Review its preview and type
   `revoke-psd-eoc-readonly-groups-key`. It validates AWS, Terraform, the live
   key, and the group hash before revoking only the exact AWS-bound key.
3. Run `bun scripts/provision-groups-credential.ts`, review its preview, and
   type `store-psd-eoc-readonly-groups-key` to create and store the replacement.
4. Temporarily authorize the role-management ADC described above, then run
   `bun scripts/verify-groups-readonly.ts`. While issue #68 remains undeployed,
   leave this credential disconnected from scheduled roster sync. After #68 is
   deployed, re-enable sync only after both this credential proof and an
   application-level approved staff-only sync succeed. Explicitly revoke the
   role-management ADC and restore the ordinary scopes afterward. If any step
   is ambiguous or fails, leave sync paused and reconcile the key list; the
   helpers retain uncertain keys and never guess which key to delete.

The revoked credential remains encrypted in older Secrets Manager versions for
audit evidence but can no longer mint Google tokens. Never delete or bypass
version history merely to make rotation pass.

## Google Auth Platform residual steps

The supported Google Terraform providers and public Google APIs still do not
create general Google Auth Platform clients. `google_iap_client` is only for
Identity-Aware Proxy, and `google_iam_oauth_client` is for workforce identity
federation; neither represents PSD EOC sign-in. Google also requires a distinct
client for each platform. Inspect the non-secret contract with:

```sh
terraform workspace show # must print exactly: default
terraform output -json google_oauth_contract
```

Complete the supported console path in project `psd401-eoc`:

1. Open **Google Cloud console → Google Auth Platform → Branding**. Set app name
   `PSD EOC`, a monitored district support address, and authorized domain
   `psd401.net`.
2. Open **Audience** and select **Internal** for the district Workspace.
3. Open **Data Access** and configure only `openid`, `email`, and `profile` for
   the PSD EOC sign-in clients.
4. Open **Clients → Create client → Web application**. Name it `PSD EOC Web`,
   set JavaScript origin `https://eoc.psd401.net`, and redirect URI
   `https://eoc.psd401.net/auth/callback`.
5. Create **iOS** client `PSD EOC iOS` with bundle ID `net.psd401.eoc`. Native
   clients have no confidential client secret and must use the system browser
   with PKCE.
6. Download the web JSON and iOS client plist to secure paths outside the repository,
   set both to mode `0600`, and store/read them back in AWS:

   ```sh
   chmod 600 /secure/web-client.json /secure/ios-client.plist
   bun scripts/store-oauth-client.ts \
     /secure/web-client.json /secure/ios-client.plist
   ```

   The helper verifies the project, exact origin/callback, bundle ID, and AWS
   account. It also requires the same local, AWS-managed encrypted, unreplicated,
   unrotated, policy-free secret contract used for the Groups credential. It
   creates `/psd-eoc/google-oauth` when absent and preserves the existing P0.4
   secret-schema keys `clientId`/`clientSecret` while adding the public web and
   iOS client IDs. It refuses files inside this repository.
   After validation it presents a consequence preview and requires the exact
   phrase `store-psd-eoc-google-oauth` before any AWS mutation. Enter it only
   with explicit product-owner approval. Securely delete both downloads after
   the helper succeeds.

7. Create **Android** client `PSD EOC Android` with package `net.psd401.eoc`
   only after issue #40/EAS supplies the release signing certificate SHA-1. Do
   not substitute a debug fingerprint. That signing input is a genuine
   dependency, not a Terraform/API gap.

Google's per-platform client rules are documented in its OAuth policy. PSD EOC
still enforces issuer, audience, verified email, and exact `hd=psd401.net`
server-side.

## AWS ownership and truth labels

The merged P0.4 CDK defines `/psd-eoc/google-oauth` but the `PsdEoc` stack is not
deployed. Deploying the entire database/App Runner/queue baseline merely to
obtain one placeholder would exceed this issue. These scoped helpers therefore
create the two exact retained secret names when absent and verify the fixed AWS
SSO account before every read or write. Before a future first CDK deployment,
the existing `/psd-eoc/google-oauth` secret must be adopted/imported rather than
recreated; never delete a live credential to make a deployment pass.

Bare Terraform apply does not advance an integration label. The canonical
Google Groups label remains `mocked` while only synthetic data is connected. If
the Workspace role and AWS credential are configured before issue #68 is
deployed, the correct label is `blocked`, not `configured-unverified`, because
the merged production roster job cannot consume this credential. After #68 is
deployed, the integration may move to `configured-unverified` only when runtime
wiring is present and read back. Only an approved staff-only read through the
deployed roster job supports `live-verified`; the standalone verifier is
supporting credential evidence, not an end-to-end runtime test. The recorded
no-domain-wide-delegation and ancestor/group-mediated IAM checks remain required.
The current P0.4 CDK injects the whole OAuth secret as `GOOGLE_OAUTH_CONFIG`,
while the server requires separate `GOOGLE_OIDC_*` variables. If the
console-created clients are validated and stored before
[issue #69](https://github.com/psd401/psd-eoc/issues/69) fixes that runtime
wiring, Google OIDC is `blocked`, not `configured-unverified`. After #69 is
deployed, exact wiring and readback support `configured-unverified`; only an
approved exercised deployed sign-in supports `live-verified`. Neither label
authorizes a notification or provider write.

## Destroy and decommission

An ordinary `terraform destroy` intentionally fails on the project, state
bucket, and roster-reader protections. Decommissioning requires a reviewed,
product-owner-approved change:

1. Export and retain remote-state and credential-rotation evidence.
2. Disable roster sync, then unassign Groups Reader and revoke OAuth clients.
3. Verify no application assumes the service account.
4. Remove provider deletion policies and Terraform `prevent_destroy` guards in
   code.
5. Apply the reviewed change, then run `terraform destroy`.
6. Retain or separately dispose of the GCS state bucket and AWS secret versions
   according to district records and security requirements.

Never use an ad-hoc deletion to bypass the retained-state record.
