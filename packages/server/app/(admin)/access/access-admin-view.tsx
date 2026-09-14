import type {
  AdmittedAccount,
  Facility,
  GroupSourcePage,
  UserPage,
} from '@psd-eoc/contracts';

import { AdminMutationFields } from '../facilities/admin-form-fields';
import type { AccessAdminCursorState } from './access-page-state';

/** A non-admin view carries no configuration data that could be rendered. */
export const NON_ADMIN_ACCESS_VIEW = Object.freeze({
  kind: 'forbidden' as const,
});

export type AccessAdminViewModel =
  | typeof NON_ADMIN_ACCESS_VIEW
  | Readonly<{
      kind: 'authorized';
      accessGroups: GroupSourcePage;
      users: UserPage;
      /** Active facilities, for limiting a person to some of them. */
      facilities: readonly Facility[];
      /** Addresses admitted without a group, current and revoked. */
      admittedAccounts: readonly AdmittedAccount[];
      cursors: AccessAdminCursorState;
    }>;

function paginationLink(
  label: string,
  parameter: 'accessGroupCursor' | 'userCursor',
  cursor: string | null,
  current: AccessAdminCursorState,
) {
  if (cursor === null) return null;
  const parameters = new URLSearchParams();
  if (current.accessGroupCursor !== null) {
    parameters.set('accessGroupCursor', current.accessGroupCursor);
  }
  if (current.userCursor !== null) {
    parameters.set('userCursor', current.userCursor);
  }
  parameters.set(parameter, cursor);
  return <a href={`/access?${parameters.toString()}`}>{label}</a>;
}

function CreateAccessGroupForm({ csrfToken }: Readonly<{ csrfToken: string }>) {
  return (
    <form action="/access/api" method="post">
      <AdminMutationFields csrfToken={csrfToken} />
      <input name="intent" type="hidden" value="create-access-group" />
      <fieldset>
        <legend>Add a Google access group</legend>
        <p id="new-access-group-help">
          Access groups permit staff sign-in. They do not add anyone to a
          notification audience. Only designated Google Groups, or an address
          admitted below, can grant PSD EOC access. Enter the group&apos;s
          address; its Google Group ID is looked up from Google when you save.
        </p>
        <label>
          Display name
          <input
            aria-describedby="new-access-group-help"
            autoComplete="off"
            maxLength={160}
            name="displayName"
            required
          />
        </label>
        <label>
          Google Group email
          <input
            autoCapitalize="none"
            autoComplete="off"
            inputMode="email"
            maxLength={320}
            name="email"
            required
            spellCheck={false}
            type="email"
          />
        </label>
        <label>
          Role granted to every member
          <select
            aria-describedby="new-access-group-role-help"
            defaultValue="staff"
            name="grantedRole"
            required
          >
            <option value="staff">Staff</option>
            <option value="admin">Administrator</option>
          </select>
        </label>
        <p id="new-access-group-role-help">
          Staff can sign in and take part in events. Administrator also
          configures facilities, rosters, and integrations. Every member of the
          group receives this role.
        </p>
        <button type="submit">Add access group</button>
      </fieldset>
    </form>
  );
}

function AccessGroupEditor({
  group,
  csrfToken,
}: Readonly<{
  group: GroupSourcePage['items'][number];
  csrfToken: string;
}>) {
  if (group.kind !== 'google-group' || group.purpose !== 'access') {
    return null;
  }
  const helpId = `access-group-${group.id}-help`;
  return (
    <details>
      <summary>Edit {group.displayName}</summary>
      <form action="/access/api" method="post">
        <AdminMutationFields csrfToken={csrfToken} />
        <input name="intent" type="hidden" value="update-access-group" />
        <input name="id" type="hidden" value={group.id} />
        <fieldset>
          <legend>Google access group settings</legend>
          <p id={helpId}>
            Changing only the display name or status retains this source&apos;s
            internal ID. Correcting a provider locator creates a new source ID
            while the proven source and its replacement remain active until a
            new access snapshot proves the replacement and the old source can be
            retired. A locator replacement must be submitted as Active. An email
            correction is looked up from Google when you save and takes the
            Google Group ID Google holds for the new address. Its access-only
            purpose never changes.
          </p>
          <label>
            Display name
            <input
              aria-describedby={helpId}
              autoComplete="off"
              defaultValue={group.displayName}
              maxLength={160}
              name="displayName"
              required
            />
          </label>
          <p>
            Google Group ID <code>{group.googleGroupId}</code>, as Google
            resolved it from the address.
          </p>
          <label>
            Google Group email
            <input
              autoCapitalize="none"
              autoComplete="off"
              defaultValue={group.email}
              inputMode="email"
              maxLength={320}
              name="email"
              required
              spellCheck={false}
              type="email"
            />
          </label>
          <label>
            Role granted to every member
            <select
              defaultValue={group.grantedRole}
              name="grantedRole"
              required
            >
              <option value="staff">Staff</option>
              <option value="admin">Administrator</option>
            </select>
          </label>
          <label>
            Status
            <select defaultValue={String(group.active)} name="active">
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
          </label>
          <button type="submit">Save access group</button>
        </fieldset>
      </form>
    </details>
  );
}

function AccessGroups({
  page,
  csrfToken,
  cursors,
}: Readonly<{
  page: GroupSourcePage;
  csrfToken: string;
  cursors: AccessAdminCursorState;
}>) {
  const accessGroups = page.items.filter(
    (group) => group.kind === 'google-group' && group.purpose === 'access',
  );
  const omittedUnexpectedGroup = accessGroups.length !== page.items.length;

  return (
    <section aria-labelledby="access-groups-heading">
      <h2 id="access-groups-heading">Google access groups</h2>
      <p>
        Membership in at least one active designated group, or an admission
        below, gates PSD EOC access. Google data remains untrusted until a
        complete server-side sync validates it.
      </p>
      {omittedUnexpectedGroup ? (
        <p role="alert">
          Some group data was not displayed because it was not Google access
          configuration.
        </p>
      ) : null}
      {accessGroups.length === 0 ? (
        <p role="status">No Google access groups are configured.</p>
      ) : (
        <>
          <div
            aria-label="Configured Google access groups"
            className="table-region"
            role="region"
            tabIndex={0}
          >
            <table>
              <caption>
                Designated Google Groups that permit staff sign-in
              </caption>
              <thead>
                <tr>
                  <th scope="col">Display name</th>
                  <th scope="col">Google Group ID</th>
                  <th scope="col">Group email</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {accessGroups.map((group) => (
                  <tr key={group.id}>
                    <th scope="row">{group.displayName}</th>
                    <td>
                      <code>{group.googleGroupId}</code>
                    </td>
                    <td>{group.email}</td>
                    <td>{group.active ? 'Active' : 'Inactive'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div aria-label="Edit Google access groups" role="group">
            {accessGroups.map((group) => (
              <AccessGroupEditor
                csrfToken={csrfToken}
                group={group}
                key={group.id}
              />
            ))}
          </div>
        </>
      )}
      {page.pageInfo.hasMore
        ? paginationLink(
            'Next page of access groups',
            'accessGroupCursor',
            page.pageInfo.nextCursor,
            cursors,
          )
        : null}
      <CreateAccessGroupForm csrfToken={csrfToken} />
    </section>
  );
}

function admissionStatus(account: AdmittedAccount): string {
  return account.revokedAt === null
    ? 'Admitted'
    : `Revoked ${account.revokedAt.slice(0, 10)}`;
}

function AdmittedAccounts({
  accounts,
  csrfToken,
}: Readonly<{
  accounts: readonly AdmittedAccount[];
  csrfToken: string;
}>) {
  return (
    <section aria-labelledby="admitted-accounts-heading">
      <h2 id="admitted-accounts-heading">Admitted accounts</h2>
      <p>
        An admitted address may sign in as staff without being in any Google
        access group. Use it for an account no group should hold, such as the
        one an app store reviewer signs in with. Admission never grants
        administrator, and a revoked admission refuses the next sign-in.
        Revocations stay listed as the record of who was let in and when it
        ended.
      </p>
      <div
        aria-label="Admitted accounts"
        className="table-region"
        role="region"
        tabIndex={0}
      >
        <table>
          <caption>Addresses admitted to sign in without a group</caption>
          <thead>
            <tr>
              <th scope="col">Address</th>
              <th scope="col">Note</th>
              <th scope="col">Admitted</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 ? (
              <tr>
                <td colSpan={4}>No address has been admitted.</td>
              </tr>
            ) : (
              accounts.map((account) => (
                <tr key={account.id}>
                  <th scope="row">{account.email}</th>
                  <td>{account.note}</td>
                  <td>{account.admittedAt.slice(0, 10)}</td>
                  <td>{admissionStatus(account)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div aria-label="Revoke admissions" role="group">
        {accounts
          .filter((account) => account.revokedAt === null)
          .map((account) => (
            <form action="/access/api" key={account.id} method="post">
              <AdminMutationFields csrfToken={csrfToken} />
              <input
                name="intent"
                type="hidden"
                value="revoke-admitted-account"
              />
              <input
                name="admittedAccountId"
                type="hidden"
                value={account.id}
              />
              <button type="submit">Revoke {account.email}</button>
            </form>
          ))}
      </div>
      <form action="/access/api" method="post">
        <AdminMutationFields csrfToken={csrfToken} />
        <input name="intent" type="hidden" value="admit-account" />
        <fieldset aria-describedby="admit-account-help">
          <legend>Admit an account</legend>
          <p className="field-help" id="admit-account-help">
            The address signs in with Google like everyone else; admission only
            replaces the group membership check. It takes effect at the next
            sign-in.
          </p>
          <label>
            Google account address
            <input
              autoCapitalize="none"
              autoComplete="off"
              inputMode="email"
              maxLength={320}
              name="email"
              required
              spellCheck={false}
              type="email"
            />
          </label>
          <label>
            Note
            <input
              autoComplete="off"
              maxLength={240}
              name="note"
              placeholder="Why this address is admitted"
              type="text"
            />
          </label>
          <button type="submit">Admit account</button>
        </fieldset>
      </form>
    </section>
  );
}

function facilityScopeLabel(user: UserPage['items'][number]): string {
  if (user.facilityScope.kind === 'district') return 'District-wide';
  const count = user.facilityScope.facilityIds.length;
  return `${count} ${count === 1 ? 'facility' : 'facilities'}`;
}

function FacilityScopeForm({
  user,
  facilities,
  csrfToken,
}: Readonly<{
  user: UserPage['items'][number];
  facilities: readonly Facility[];
  csrfToken: string;
}>) {
  const limited = user.facilityScope.kind === 'facilities';
  const selected = new Set(limited ? user.facilityScope.facilityIds : []);
  const helpId = `scope-help-${user.id}`;
  return (
    <details>
      <summary>Limit to facilities</summary>
      <form action="/access/api" method="post">
        <AdminMutationFields csrfToken={csrfToken} />
        <input name="intent" type="hidden" value="set-user-facility-scope" />
        <input name="userId" type="hidden" value={user.id} />
        <fieldset aria-describedby={helpId}>
          <legend>Where {user.displayName} may act</legend>
          <p className="field-help" id={helpId}>
            District-wide is every facility. Limiting a person to facilities
            means they see, start, and join events only there. It applies to
            their next request and is enforced on every capability, not just in
            the pages they see. Roles are unchanged. An administrator is always
            district-wide and cannot be limited.
          </p>
          <label>
            <input
              defaultChecked={!limited}
              name="scopeKind"
              type="radio"
              value="district"
            />{' '}
            District-wide
          </label>
          <label>
            <input
              defaultChecked={limited}
              name="scopeKind"
              type="radio"
              value="facilities"
            />{' '}
            Only these facilities
          </label>
          {facilities.map((facility) => (
            <label key={facility.id}>
              <input
                defaultChecked={selected.has(facility.id)}
                name="facilityIds"
                type="checkbox"
                value={facility.id}
              />{' '}
              {facility.code} — {facility.name}
              {facility.isolated ? ' (isolated)' : ''}
            </label>
          ))}
          <button type="submit">Save facility scope</button>
        </fieldset>
      </form>
    </details>
  );
}

function UsersAndRoles({
  page,
  facilities,
  cursors,
  csrfToken,
}: Readonly<{
  page: UserPage;
  facilities: readonly Facility[];
  cursors: AccessAdminCursorState;
  csrfToken: string;
}>) {
  return (
    <section aria-labelledby="roles-heading">
      <h2 id="roles-heading">Staff roles</h2>
      <p>
        Roles are read from trusted-group membership at every request and are
        not editable here: move somebody between groups to change what they may
        do. Facility authorization is still enforced server-side on every
        capability; where a person may act is set below.
      </p>
      {page.items.length === 0 ? (
        <p role="status">No staff accounts match this view.</p>
      ) : (
        <div
          aria-label="Staff accounts and granted roles"
          className="table-region"
          role="region"
          tabIndex={0}
        >
          <table>
            <caption>
              Minimized staff accounts and the roles their groups grant
            </caption>
            <thead>
              <tr>
                <th scope="col">Staff member</th>
                <th scope="col">Email</th>
                <th scope="col">Facility scope</th>
                <th scope="col">Account</th>
                <th scope="col">Roles</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((user) => (
                <tr key={user.id}>
                  <th scope="row">{user.displayName}</th>
                  <td>{user.email}</td>
                  <td>
                    {facilityScopeLabel(user)}
                    <FacilityScopeForm
                      csrfToken={csrfToken}
                      facilities={facilities}
                      user={user}
                    />
                  </td>
                  <td>{user.disabledAt === null ? 'Active' : 'Disabled'}</td>
                  <td>
                    {user.roles.length === 0
                      ? 'None'
                      : [...user.roles].sort().join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.pageInfo.hasMore
        ? paginationLink(
            'Next page of staff accounts',
            'userCursor',
            page.pageInfo.nextCursor,
            cursors,
          )
        : null}
    </section>
  );
}

/** Pure access-administration presentation; authorization and writes stay upstream. */
export function AccessAdminView({
  view,
  csrfToken = '',
  statusMessage = null,
}: Readonly<{
  view: AccessAdminViewModel;
  csrfToken?: string;
  statusMessage?: string | null;
}>) {
  if (view.kind === 'forbidden') {
    return (
      <main id="main-content" tabIndex={-1}>
        <section aria-labelledby="access-forbidden-heading">
          <h1 id="access-forbidden-heading">Administrator access required</h1>
          <p role="alert">
            Your PSD EOC session is active, but only administrators can manage
            access groups and staff roles.
          </p>
          <p>No access group or staff-account configuration was displayed.</p>
        </section>
      </main>
    );
  }

  return (
    <main id="main-content" tabIndex={-1}>
      <header>
        <p>Administration</p>
        <h1>Access groups and the roles they grant</h1>
        <p>
          Configure the Google Groups that gate staff sign-in. Each group grants
          a role, so who administers PSD EOC is decided by who is in the
          administrator group. These controls never start an event or send a
          notification.
        </p>
      </header>
      {statusMessage === null ? null : (
        <p className="notice status-message" role="status">
          {statusMessage}
        </p>
      )}
      <AccessGroups
        csrfToken={csrfToken}
        cursors={view.cursors}
        page={view.accessGroups}
      />
      <AdmittedAccounts
        accounts={view.admittedAccounts}
        csrfToken={csrfToken}
      />
      <UsersAndRoles
        csrfToken={csrfToken}
        cursors={view.cursors}
        facilities={view.facilities}
        page={view.users}
      />
    </main>
  );
}
