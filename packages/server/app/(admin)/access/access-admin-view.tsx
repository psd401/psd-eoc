import type { GroupSourcePage, UserPage } from '@psd-eoc/contracts';

import { AdminMutationFields } from '../facilities/admin-form-fields';
import { AdminNavigation } from '../facilities/admin-nav';

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
    }>;

function paginationLink(
  label: string,
  parameter: 'accessGroupCursor' | 'userCursor',
  cursor: string | null,
) {
  if (cursor === null) return null;
  const parameters = new URLSearchParams({ [parameter]: cursor });
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
          notification audience, and synthetic groups cannot be access groups.
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
          Google Group ID
          <input
            autoCapitalize="none"
            autoComplete="off"
            maxLength={255}
            name="googleGroupId"
            required
            spellCheck={false}
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
            Saving replaces this group&apos;s editable configuration. Its stable
            internal ID and access-only purpose do not change.
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
          <label>
            Google Group ID
            <input
              autoCapitalize="none"
              autoComplete="off"
              defaultValue={group.googleGroupId}
              maxLength={255}
              name="googleGroupId"
              required
              spellCheck={false}
            />
          </label>
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
}: Readonly<{ page: GroupSourcePage; csrfToken: string }>) {
  const accessGroups = page.items.filter(
    (group) => group.kind === 'google-group' && group.purpose === 'access',
  );
  const omittedUnexpectedGroup = accessGroups.length !== page.items.length;

  return (
    <section aria-labelledby="access-groups-heading">
      <h2 id="access-groups-heading">Google access groups</h2>
      <p>
        Membership in at least one active designated group gates PSD EOC access.
        Google data remains untrusted until a complete server-side sync
        validates it.
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
          )
        : null}
      <CreateAccessGroupForm csrfToken={csrfToken} />
    </section>
  );
}

function facilityScopeLabel(user: UserPage['items'][number]): string {
  if (user.facilityScope.kind === 'district') return 'District-wide';
  const count = user.facilityScope.facilityIds.length;
  return `${count} ${count === 1 ? 'facility' : 'facilities'}`;
}

function RoleAssignmentForm({
  user,
  csrfToken,
}: Readonly<{ user: UserPage['items'][number]; csrfToken: string }>) {
  const staffId = `user-${user.id}-staff`;
  const adminId = `user-${user.id}-admin`;
  const helpId = `user-${user.id}-role-help`;
  const disabled = user.disabledAt !== null;

  const RoleControl = ({
    id,
    label,
    role,
  }: Readonly<{
    id: string;
    label: string;
    role: 'staff' | 'admin';
  }>) => {
    const alreadyGranted = user.roles.includes(role);
    return (
      <label htmlFor={id}>
        <input
          aria-describedby={helpId}
          defaultChecked={alreadyGranted}
          id={id}
          name="roles"
          type="checkbox"
          value={role}
        />
        {label}
      </label>
    );
  };

  return (
    <form action="/access/api" method="post">
      <AdminMutationFields csrfToken={csrfToken} />
      <input name="intent" type="hidden" value="set-user-roles" />
      <input name="userId" type="hidden" value={user.id} />
      <fieldset disabled={disabled}>
        <legend>Roles for {user.displayName}</legend>
        <p id={helpId}>
          Select the complete effective role set. Changes append grant or
          revocation facts; prior history remains immutable. Administrator
          access does not replace server-side facility scope.
        </p>
        <RoleControl id={staffId} label="Staff" role="staff" />
        <RoleControl id={adminId} label="Administrator" role="admin" />
        <button type="submit">Save roles for {user.displayName}</button>
      </fieldset>
      {disabled ? (
        <p>This account is disabled; roles cannot be changed.</p>
      ) : null}
    </form>
  );
}

function UsersAndRoles({
  page,
  csrfToken,
}: Readonly<{ page: UserPage; csrfToken: string }>) {
  return (
    <section aria-labelledby="roles-heading">
      <h2 id="roles-heading">Staff roles</h2>
      <p>
        Assign administrator access only to staff who manage district
        configuration. Facility authorization is still enforced server-side on
        every capability.
      </p>
      {page.items.length === 0 ? (
        <p role="status">No staff accounts match this view.</p>
      ) : (
        <div
          aria-label="Staff role assignments"
          className="table-region"
          role="region"
          tabIndex={0}
        >
          <table>
            <caption>Minimized staff accounts and role assignments</caption>
            <thead>
              <tr>
                <th scope="col">Staff member</th>
                <th scope="col">Email</th>
                <th scope="col">Facility scope</th>
                <th scope="col">Account</th>
                <th scope="col">Role assignment</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((user) => (
                <tr key={user.id}>
                  <th scope="row">{user.displayName}</th>
                  <td>{user.email}</td>
                  <td>{facilityScopeLabel(user)}</td>
                  <td>{user.disabledAt === null ? 'Active' : 'Disabled'}</td>
                  <td>
                    <RoleAssignmentForm csrfToken={csrfToken} user={user} />
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
      <AdminNavigation />
      <header>
        <p>Administration</p>
        <h1>Access groups and administrator roles</h1>
        <p>
          Configure the Google Groups that gate staff sign-in and assign the
          small set of staff who may administer PSD EOC. These controls never
          start an event or send a notification.
        </p>
      </header>
      {statusMessage === null ? null : (
        <p className="notice status-message" role="status">
          {statusMessage}
        </p>
      )}
      <AccessGroups csrfToken={csrfToken} page={view.accessGroups} />
      <UsersAndRoles csrfToken={csrfToken} page={view.users} />
    </main>
  );
}
