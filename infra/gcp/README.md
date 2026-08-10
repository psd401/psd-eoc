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
by the GCS backend. The same human intentionally holds project-level
`roles/storage.admin` so this root can create and maintain the bucket; that
broader inherited grant is not represented by the direct bucket-policy
readback. Legacy project Owner/Editor/Viewer convenience principals, groups,
domains, service accounts, public principals, extra roles, and conditional
bindings are not accepted in the direct bucket policy.
Because project grants inherit into the bucket, the guarded apply also
allowlists the entire direct project IAM policy. Recovery permits only a subset
of the declared human administrator roles, the exact automatic creator Owner,
and the exact same-project Google APIs service-agent Editor grant long enough
for the main apply to remove both basic roles. Steady state requires every
declared narrower administrator role and rejects every other role, principal,
condition, or custom grant. This prevents an unexpected principal or role from
using project inheritance to bypass the reviewed single-human boundary.

## Apply from this machine

Authenticate as the fixed district administrator. Never use a static AWS key or
a service-account credential for Terraform.

```sh
./scripts/run-guarded.sh authenticate
```

The authentication command directly parses and rejects unsafe persistent Cloud
SDK settings before its first gcloud process. AWS uses the checked-in exact
`aws.config` SSO profile instead of the ambient AWS config or shared-credentials
file; the launcher also refuses AWS aliases and model overrides. It then
performs the fixed Google user login, ordinary ADC login, AWS SSO login, and
exact identity readbacks in their sanitized child environments. Neither CLI is
allowed to launch a browser: it prints an authorization URL for the human to
open in a trusted browser. That human browser session is intentionally outside
the helpers' direct-transport boundary and never authorizes a cloud mutation by
itself. The ordinary ADC login deliberately writes no quota project, even if
another gcloud configuration has an active project.
The guarded helpers reject ADC metadata bound to any project other than
`psd401-eoc` and discard inherited Google billing/quota/project overrides. They
also reject persistent gcloud billing/quota configuration, and every project
API call names `psd401-eoc` explicitly. After bootstrap creates the dedicated
project, the main Terraform provider pins user-project quota and billing to
`psd401-eoc`; the bootstrap provider cannot do so before that project exists.

Before Bun starts, the checked-in launcher pins the fixed machine account,
home, PATH, and absolute Bun executable. It rejects every `BUN_*` variable,
`NODE_OPTIONS`, Python and dynamic-loader startup hooks, and browser command
overrides, then pins the exact checked-in Bun configuration, disables automatic
environment-file loading and package installation, and permits only the seven
reviewed TypeScript helper entrypoints. A trusted configuration preload verifies
that exact launcher contract before any helper module executes. Every TypeScript
helper invocation below uses `scripts/run-guarded.sh`; invoking a helper directly
with Bun is not a guarded path.

Before any credential-bearing child process, native fetch, or OAuth download
read, the guarded helpers reject ambient HTTP/HTTPS/all-proxy settings, custom
CA paths, TLS key logging, disabled Node TLS validation, and Bun verbose-fetch
logging. They also reject `BUN_OPTIONS`, `NODE_OPTIONS`, effective Bun inspector
variables, Node debug logging, and startup flags for environment files,
preload/import hooks, preconnects, package installation, TLS key logging,
alternate CA stores, environment proxies, verbose fetches, or the inspector.
Terraform/provider and Go/gRPC trace, external-account executable, model,
observability, and endpoint-bootstrap variables are rejected as well. Each
Terraform, gcloud, and AWS child receives a minimal allowlisted environment,
the fixed home and executable search path, and direct transport with
`NO_PROXY=*`. Gcloud is pinned to an isolated Python interpreter, with update,
telemetry, metadata, HTTP, and file logging disabled. AWS is pinned to the
checked-in SSO config, `/dev/null` shared credentials, disabled metadata,
pager, and auto-prompt paths, and every service command's fixed canonical
`--endpoint-url`; every AWS invocation also adds `--no-cli-pager`. If a district
proxy or custom CA is ever required, stop and add one explicit reviewed
endpoint/certificate contract instead of inheriting shell or operating-system
transport state.

Run the guarded helper from this directory. It initializes each Terraform root
with the pinned CLI configuration and produces a complete saved plan before it
offers either exact human confirmation:

```sh
./scripts/run-guarded.sh apply
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
fails closed. Requester Pays is explicitly disabled, and recovery rejects an
enabled or malformed Requester Pays value before treating the bucket as usable
by the backend. Bucket creation waits for all four bootstrap APIs. If an existing
managed bucket is later found with any bootstrap API missing, recovery imports
the existing bucket and policy into bootstrap state and repairs the APIs before
the main backend is initialized. Recovery also validates the exact
organization, billing account, labels, whole direct project IAM policy, and
already-enabled APIs before importing anything. If an interrupted provider
create left the fixed roster-reader service account outside Terraform state,
recovery adopts it only after a successful project-scoped account listing and
an exact identity, display-name, description, enabled-state, empty resource IAM
policy, and zero-user-managed-key check. Permission or inspection failures,
unexpected metadata, a resource binding, or any existing key fail closed.

Both mutations use saved Terraform plans and a helper-owned exact confirmation;
inherited `TF_CLI_ARGS*`, `TF_WORKSPACE`, and Google credential overrides are
discarded. The child process pins `TF_CLI_CONFIG_FILE` to the checked-in
`terraform.tfrc`, which permits only direct provider installation; a home
`.terraformrc`, legacy `TERRAFORM_CONFIG`, development override, reattached
provider, or ambient plugin cache cannot replace a locked provider.
`STORAGE_EMULATOR_HOST` and `STORAGE_EMULATOR_HOST_GRPC` are rejected rather
than discarded so an operator expecting an emulator cannot unknowingly reach
the live state bucket. Every Terraform state or output read also requires the
persisted workspace to be exactly `default`; a stale `.terraform/environment`
cannot redirect a helper to another workspace. The confirmation phrases are
shown only after the complete plans. There is no auto-approve path. Do not
confirm either plan without explicit product-owner approval for the billed,
retained infrastructure described in the preview.

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

### Firebase project isolation boundary

Do not add Firebase to `psd401-eoc` under issue #40's current same-project
wording. Firebase automatically grants its primary management service agent a
project role that can change both project IAM and bucket IAM policies. In this
project that authority could bypass the roster-reader credential boundary and
the Terraform state-bucket boundary. The project-policy guard intentionally
rejects that binding. Issue #40 must be amended either to create an isolated
Firebase project (recommended) or to own a separately reviewed isolation
design plus the provider, lockfile, helper, test, and documentation files it
needs. A plain allowlist exception is not safe.

## Workspace Groups Reader assignment

Google supports assigning a Workspace administrator role directly to a service
account through the Admin SDK Role Assignments API. PSD EOC resolves the
tenant-specific ID of the built-in `_GROUPS_READER_ROLE`, verifies that it is a
non-super-admin system role, assigns it to the Terraform service-account unique
ID, and reads the assignment back:

```sh
PSD_EOC_CONFIRM_WORKSPACE_ROLE_ASSIGNMENT=assign-groups-reader-to-roster-sync-reader \
  ./scripts/run-guarded.sh configure-workspace-role
```

The helper is idempotent, allows only Admin SDK GETs plus the one role-assignment
POST, and refuses any other direct or indirect administrator role affecting
that service account. Google has exposed the direct-assignee wire value as both
`user` and the documented enum spelling `USER`; the helper accepts only those
two exact values, normalizes them to one direct-user state, and rejects either
case of `group` plus every malformed value. Immediately before the first
assignment POST, it rechecks both IAM boundaries and requires zero user-managed
service-account keys. An existing key is treated as unowned: the helper refuses
the assignment and never deletes it. It requires Super Admin Application
Default Credentials with one non-Cloud scope:
`https://www.googleapis.com/auth/admin.directory.rolemanagement`. The login
also retains `openid`, `userinfo.email`, and `cloud-platform` so gcloud can
verify the fixed administrator identity and run the other guarded checks. The
ordinary Cloud-only ADC above does not contain the Workspace scope.

Google requires a separately authorized OAuth client for non-Cloud ADC scopes.
If the district already has an approved internal Desktop OAuth client for
administrator tooling, authorize it from a secure, mode-`0600` download outside
the repository:

```sh
./scripts/run-guarded.sh authorize-workspace-adc \
  /secure/workspace-admin-client.json
```

The helper accepts only a mode-`0600`, sub-64-KiB Desktop client outside the
repository with Google's exact authorization, token, certificate, and loopback
redirect endpoints. It never prints the client secret. Current gcloud rejects
`--no-launch-browser` when a custom client file is present, so this one flow
uses its supported `--no-browser` remote bootstrap. Copy the printed
`gcloud auth application-default login --remote-bootstrap=...` command to a
different trusted machine with gcloud and a browser, run it there, then paste
the resulting URL back into the guarded prompt. The helper still cannot launch
a browser or run that external command itself.

Delete the download after authorization. The live credential verifier below
rechecks all direct and indirect role assignments, so retain this temporary ADC
only through that immediate proof. If the proof will not run immediately,
revoke it now and repeat the scoped authorization immediately before the
verifier. Supplying the same account to another login is not sufficient because
the Cloud SDK may reuse the existing refresh credential. Explicitly revoke it,
then restore the ordinary identity/Cloud-only ADC:

```sh
./scripts/run-guarded.sh restore-adc
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
./scripts/run-guarded.sh show-groups-reader-client-id
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
./scripts/run-guarded.sh provision-groups-credential
./scripts/run-guarded.sh verify-groups-readonly
```

Provisioning presents a consequence preview and requires the exact phrase
`store-psd-eoc-readonly-groups-key` before it creates either the AWS secret or
Google key. Enter it only with explicit product-owner approval.

Provisioning verifies the Terraform output, the exact allowlisted live project
IAM policy, an empty IAM policy on the roster-reader resource, AWS account
`338414773271`, the exact live direct/indirect Workspace role state, and absence
of any existing user-managed key. Because the consequence prompt has no time
limit, it repeats the active Google/ADC identity, Terraform/live account,
Workspace role, both GCP IAM policies, zero-key, AWS caller, and secret-policy
checks after confirmation before creating the key. It rechecks Google
authorization and the exact sole key immediately before storage, repeats the
AWS boundary before every idempotent secret-write and reconciliation attempt,
and repeats both remote boundaries after exact readback before reporting
success. Before writing, it requires the secret's fixed account/Region ARN and
ownership tags, AWS-managed encryption, no pending deletion, automatic
rotation, replica, external owner, or resource policy; a new placeholder is
read back against the same contract. It creates
`/psd-eoc/google-groups` when absent, writes one key directly to an idempotent
Secrets Manager version, and captures gcloud's supported stdout output so the
private key is never written to a local file. A failed AWS write deletes only
the newly identified key; an ambiguous AWS result is read back before cleanup,
and ambiguous key identity is never deleted. After exact AWS readback marks the
credential stored, the final remote check again requires the same key to be the
sole active user-managed key with the same creation timestamp. A missing,
changed, or concurrent key fails the run but retains the AWS-bound key and any
unknown key for explicit reconciliation.

The project-policy check rejects the exact service-account member plus direct
project bindings to universal principals, domains, groups, project convenience
principals, Google public principal sets, Resource Manager service-account sets,
Token Creator, Service Account User, Workload Identity User, custom roles, and
every other unreviewed role or principal. The roster-reader's own IAM policy
must have no binding, so no principal can mint a token through a resource-level
grant. Google does not expose group-expanded ancestor IAM in either response.
Before `live-verified`, a district administrator must still confirm the service
account is not covered by ancestor token-minting, signing, `actAs`, key-creation,
or project-role authority and is not a member of a Google Group granted such
authority. Record only that result, not unrelated group membership or IAM
identities. The helper and PR must not describe the direct-policy checks as
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
2. Temporarily authorize the role-management ADC described above and retain it
   only through the immediate revoke, provision, and verification steps below.
   If that authorization cannot be obtained, leave the existing credential in
   place and keep sync paused.
3. With the same `PSD_EOC_APPROVED_TEST_GROUP` value, run
   `./scripts/run-guarded.sh revoke-groups-credential`. Review its preview and type
   `revoke-psd-eoc-readonly-groups-key`. It revalidates the retained secret's
   complete AWS ownership/encryption/policy contract before reading it, then
   validates Terraform, both live IAM policies, the exact key, and the group
   hash. The preview check is discarded. After the unbounded confirmation it
   repeats the gcloud and ADC identities, fresh Terraform/live service-account
   contract, both IAM policies, AWS caller/secret metadata/resource policy on
   both sides of secret readback, sole key and creation timestamp, and group
   hash; only that fresh result supplies the key ID used for deletion. It then
   proves that no user-managed key remains.
4. Run `./scripts/run-guarded.sh provision-groups-credential`, review its preview, and
   type `store-psd-eoc-readonly-groups-key` to create and store the replacement.
5. Run `./scripts/run-guarded.sh verify-groups-readonly` with the same temporary
   role-management ADC. While issue #68 remains undeployed,
   leave this credential disconnected from scheduled roster sync. After #68 is
   deployed, re-enable sync only after both this credential proof and an
   application-level approved staff-only sync succeed.
6. Explicitly revoke the role-management ADC and restore the ordinary scopes.
   If any step is ambiguous or fails, leave sync paused, revoke the temporary
   role-management ADC, and reconcile the key list; the helpers retain
   uncertain keys and never guess which key to delete.

The revoked credential remains encrypted in older Secrets Manager versions for
audit evidence but can no longer mint Google tokens. Never delete or bypass
version history merely to make rotation pass.

## Google Auth Platform residual steps

The supported Google Terraform providers and public Google APIs still do not
create general Google Auth Platform clients. `google_iap_client` is only for
Identity-Aware Proxy, and `google_iam_oauth_client` is for workforce identity
federation; neither represents PSD EOC sign-in. Google also requires a distinct
client for each platform. The exact non-secret client contract is committed as
the `google_oauth_contract` output in `outputs.tf`; do not bypass the guarded
launcher with a direct Terraform output command.

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
   ./scripts/run-guarded.sh store-oauth-client \
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
   with explicit product-owner approval. After that unbounded prompt, it
   re-reads the Terraform project identity and revalidates the AWS caller plus
   complete secret contract. It repeats the AWS check immediately before every
   idempotent write/reconciliation attempt and around exact readback. Securely
   delete both downloads after the helper succeeds.

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

Direct destruction is intentionally unsupported by this issue, and the project,
state-bucket, and roster-reader protections make an ordinary attempt fail.
Decommissioning requires a reviewed, product-owner-approved change:

1. Export and retain remote-state and credential-rotation evidence.
2. Disable roster sync, then unassign Groups Reader and revoke OAuth clients.
3. Verify no application assumes the service account.
4. Remove provider deletion policies and Terraform `prevent_destroy` guards in
   code.
5. Add and use a dedicated guarded decommission workflow that pins the same
   transport, identity, CLI-configuration, provider, preview, and human-
   confirmation boundaries. A direct Terraform destroy remains unsupported.
6. Retain or separately dispose of the GCS state bucket and AWS secret versions
   according to district records and security requirements.

Never use an ad-hoc deletion to bypass the retained-state record.
