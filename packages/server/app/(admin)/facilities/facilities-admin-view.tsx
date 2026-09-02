import type {
  Facility,
  FacilityPage,
  GroupSource,
  GroupSourcePage,
  Neighborhood,
  NeighborhoodPage,
} from '@psd-eoc/contracts';

import { AdminMutationFields } from './admin-form-fields';

/** A denied view cannot carry configuration that might accidentally render. */
export const NON_ADMIN_FACILITIES_VIEW = Object.freeze({
  kind: 'forbidden' as const,
});

export type FacilitiesAdminViewModel =
  | typeof NON_ADMIN_FACILITIES_VIEW
  | Readonly<{
      kind: 'authorized';
      facilities: FacilityPage;
      neighborhoods: NeighborhoodPage;
      buildingGroups: GroupSourcePage;
      othersGroups: GroupSourcePage;
      facilityOptions: readonly Facility[];
      neighborhoodOptions: readonly Neighborhood[];
      buildingGroupOptions: readonly GroupSource[];
      othersGroupOptions: readonly GroupSource[];
      currentCursors: Readonly<{
        buildingGroupCursor: string | null;
        facilityCursor: string | null;
        neighborhoodCursor: string | null;
        othersGroupCursor: string | null;
      }>;
    }>;

type FacilitiesAdminViewProps =
  | Readonly<{
      view: typeof NON_ADMIN_FACILITIES_VIEW;
      csrfToken?: never;
      statusMessage?: never;
    }>
  | Readonly<{
      view: Exclude<FacilitiesAdminViewModel, typeof NON_ADMIN_FACILITIES_VIEW>;
      csrfToken: string;
      statusMessage?: string | null;
    }>;

type FacilitiesAdminCursorState = Readonly<{
  buildingGroupCursor: string | null;
  facilityCursor: string | null;
  neighborhoodCursor: string | null;
  othersGroupCursor: string | null;
}>;

type FacilitiesAdminCursorParameter = keyof FacilitiesAdminCursorState;

const CURSOR_PARAMETERS = Object.freeze([
  'facilityCursor',
  'neighborhoodCursor',
  'buildingGroupCursor',
  'othersGroupCursor',
] as const satisfies readonly FacilitiesAdminCursorParameter[]);

function nextPageLink(
  label: string,
  parameter: FacilitiesAdminCursorParameter,
  cursor: string | null,
  currentCursors: FacilitiesAdminCursorState,
) {
  if (cursor === null) return null;
  const parameters = new URLSearchParams();
  for (const cursorParameter of CURSOR_PARAMETERS) {
    const value =
      cursorParameter === parameter ? cursor : currentCursors[cursorParameter];
    if (value !== null) parameters.set(cursorParameter, value);
  }
  return <a href={`/facilities?${parameters.toString()}`}>{label}</a>;
}

function FacilityEditor({
  csrfToken,
  facility,
}: Readonly<{ csrfToken: string; facility: Facility }>) {
  return (
    <details>
      <summary>Edit {facility.name}</summary>
      <form action="/facilities/api" method="post">
        <AdminMutationFields csrfToken={csrfToken} />
        <input name="intent" type="hidden" value="update-facility" />
        <input name="facilityId" type="hidden" value={facility.id} />
        <fieldset>
          <legend>Facility settings</legend>
          <p id={`facility-${facility.id}-help`}>
            The stable facility ID does not change. Deactivation preserves all
            historical references.
          </p>
          <label>
            Short code
            <input
              aria-describedby={`facility-${facility.id}-help`}
              autoCapitalize="characters"
              autoComplete="off"
              defaultValue={facility.code}
              maxLength={32}
              name="code"
              pattern="[A-Z0-9-]+"
              required
              spellCheck={false}
            />
          </label>
          <label>
            Facility name
            <input
              autoComplete="organization"
              defaultValue={facility.name}
              maxLength={160}
              name="name"
              required
            />
          </label>
          <label>
            Status
            <select defaultValue={String(facility.active)} name="active">
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
          </label>
          <button type="submit">Save {facility.name}</button>
        </fieldset>
      </form>
    </details>
  );
}

function FacilitiesSection({
  csrfToken,
  currentCursors,
  page,
}: Readonly<{
  csrfToken: string;
  currentCursors: FacilitiesAdminCursorState;
  page: FacilityPage;
}>) {
  return (
    <section aria-labelledby="facilities-heading">
      <h2 id="facilities-heading">Facilities</h2>
      <p>
        Facility records use stable IDs. Names, short codes, and active state
        may change without rewriting historical events.
      </p>
      {page.items.length === 0 ? (
        <p role="status">No facilities are configured.</p>
      ) : (
        <>
          <div
            aria-label="Configured facilities"
            className="table-region"
            role="region"
            tabIndex={0}
          >
            <table>
              <caption>District facilities available to PSD EOC</caption>
              <thead>
                <tr>
                  <th scope="col">Short code</th>
                  <th scope="col">Facility</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((facility) => (
                  <tr key={facility.id}>
                    <th scope="row">{facility.code}</th>
                    <td>{facility.name}</td>
                    <td>{facility.active ? 'Active' : 'Inactive'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div aria-label="Edit facilities" role="group">
            {page.items.map((facility) => (
              <FacilityEditor
                csrfToken={csrfToken}
                facility={facility}
                key={facility.id}
              />
            ))}
          </div>
        </>
      )}
      {page.pageInfo.hasMore
        ? nextPageLink(
            'Next page of facilities',
            'facilityCursor',
            page.pageInfo.nextCursor,
            currentCursors,
          )
        : null}
      <form action="/facilities/api" method="post">
        <AdminMutationFields csrfToken={csrfToken} />
        <input name="intent" type="hidden" value="create-facility" />
        <fieldset>
          <legend>Add a facility</legend>
          <p id="new-facility-help">
            Add the site first, then configure its immutable building source
            below.
          </p>
          <label>
            Short code
            <input
              aria-describedby="new-facility-help"
              autoCapitalize="characters"
              autoComplete="off"
              maxLength={32}
              name="code"
              pattern="[A-Z0-9-]+"
              required
              spellCheck={false}
            />
          </label>
          <label>
            Facility name
            <input
              autoComplete="organization"
              maxLength={160}
              name="name"
              required
            />
          </label>
          <button type="submit">Add facility</button>
        </fieldset>
      </form>
    </section>
  );
}

function GoogleGroupFields({
  defaultDisplayName,
  helpId,
}: Readonly<{ defaultDisplayName?: string; helpId: string }>) {
  return (
    <>
      <label>
        Display name
        <input
          aria-describedby={helpId}
          autoComplete="off"
          defaultValue={defaultDisplayName}
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
    </>
  );
}

function BuildingGroupForm({
  csrfToken,
  facilities,
}: Readonly<{
  csrfToken: string;
  facilities: readonly Facility[];
}>) {
  const activeFacilities = facilities.filter((facility) => facility.active);
  const helpId = 'new-google-building-group-help';
  return (
    <form action="/facilities/api" method="post">
      <AdminMutationFields csrfToken={csrfToken} />
      <input name="intent" type="hidden" value="create-google-building-group" />
      <fieldset disabled={activeFacilities.length === 0}>
        <legend>Add a Google building source</legend>
        <p id={helpId}>
          Google Groups data is untrusted and is used only after a complete
          validated roster sync.
        </p>
        <label>
          Facility
          <select name="facilityId" required>
            <option value="">Select a facility</option>
            {activeFacilities.map((facility) => (
              <option key={facility.id} value={facility.id}>
                {facility.code} — {facility.name}
              </option>
            ))}
          </select>
        </label>
        <GoogleGroupFields helpId={helpId} />
        <button type="submit">Add Google building source</button>
      </fieldset>
      {activeFacilities.length === 0 ? (
        <p role="status">Add an active facility before its building source.</p>
      ) : null}
    </form>
  );
}

function ManualBuildingGroupForm({
  csrfToken,
  facilities,
}: Readonly<{
  csrfToken: string;
  facilities: readonly Facility[];
}>) {
  const activeFacilities = facilities.filter((facility) => facility.active);
  const helpId = 'new-manual-building-group-help';
  return (
    <form action="/facilities/api" method="post">
      <AdminMutationFields csrfToken={csrfToken} />
      <input name="intent" type="hidden" value="create-manual-building-group" />
      <fieldset disabled={activeFacilities.length === 0}>
        <legend>Add a manual building source</legend>
        <p id={helpId}>
          A manual source notifies only the people an administrator adds to it,
          for a site where not every staff member is enrolled. Creating the
          source does not add anyone; add people to it afterwards.
        </p>
        <label>
          Facility
          <select aria-describedby={helpId} name="facilityId" required>
            <option value="">Select a facility</option>
            {activeFacilities.map((facility) => (
              <option key={facility.id} value={facility.id}>
                {facility.code} — {facility.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Display name
          <input maxLength={160} name="displayName" required type="text" />
        </label>
        <button type="submit">Add manual building source</button>
      </fieldset>
      {activeFacilities.length === 0 ? (
        <p role="status">Add an active facility before its building source.</p>
      ) : null}
    </form>
  );
}

/**
 * Replaces the people a manual building source reaches.
 *
 * The whole list is stated rather than edited one address at a time, so an
 * administrator can read back exactly who a site will notify before saving.
 * Saving changes who a later activation would reach; it notifies nobody.
 */
function ManualMembersForm({
  csrfToken,
  group,
}: Readonly<{ csrfToken: string; group: GroupSource }>) {
  if (group.kind !== 'manual' || !group.active) {
    return null;
  }
  const helpId = `manual-members-help-${group.id}`;
  return (
    <form action="/facilities/api" method="post">
      <AdminMutationFields csrfToken={csrfToken} />
      <input name="intent" type="hidden" value="set-manual-roster-members" />
      <input name="sourceId" type="hidden" value={group.id} />
      <fieldset>
        <legend>People notified by {group.displayName}</legend>
        <p id={helpId}>
          One staff address per line. Saving replaces the whole list and
          publishes a new roster snapshot in the same step; if the publication
          is refused, the page says why and the saved people stay saved. This
          does not notify anyone.
        </p>
        <label>
          Staff addresses
          <textarea aria-describedby={helpId} name="emails" rows={6} />
        </label>
        <button type="submit">Save people</button>
      </fieldset>
    </form>
  );
}

/**
 * Publishes a roster snapshot from the current sources.
 *
 * Saving who a manual source reaches only stores a list. An activation reads a
 * snapshot, so the roster has to be published before the change takes effect.
 * Publishing notifies nobody.
 */
function RosterPublishForm({ csrfToken }: Readonly<{ csrfToken: string }>) {
  const helpId = 'roster-publish-help';
  return (
    <form action="/facilities/api" method="post">
      <AdminMutationFields csrfToken={csrfToken} />
      <input name="intent" type="hidden" value="publish-roster-snapshot" />
      <fieldset>
        <legend>Publish the roster</legend>
        <p id={helpId}>
          Reads every configured source and publishes a new immutable snapshot,
          including the devices currently registered for push. Saving a manual
          source&apos;s people already does this; use it after a Google Group
          changes or if an automatic publish reported a failure. This does not
          start an event or notify anyone.
        </p>
        <button aria-describedby={helpId} type="submit">
          Publish roster snapshot
        </button>
      </fieldset>
    </form>
  );
}

function OthersGroupForm({
  csrfToken,
}: Readonly<{
  csrfToken: string;
}>) {
  const helpId = 'new-google-others-group-help';
  return (
    <form action="/facilities/api" method="post">
      <AdminMutationFields csrfToken={csrfToken} />
      <input name="intent" type="hidden" value="create-google-others-group" />
      <fieldset>
        <legend>Add a Google others source</legend>
        <p id={helpId}>
          An others source reaches its people at every event, at every facility.
          Every active others source is included the next time the roster is
          published; nothing has to be selected.
        </p>
        <GoogleGroupFields helpId={helpId} />
        <button type="submit">Add Google others source</button>
      </fieldset>
    </form>
  );
}

/**
 * A district-level list curated here, without a Google Group.
 *
 * This is where the people who belong at every event go: the responders who
 * must be reached whichever facility an event starts at. One list, maintained
 * in one place, instead of the same names repeated in every building source.
 */
function ManualOthersGroupForm({
  csrfToken,
}: Readonly<{
  csrfToken: string;
}>) {
  const helpId = 'new-manual-others-group-help';
  return (
    <form action="/facilities/api" method="post">
      <AdminMutationFields csrfToken={csrfToken} />
      <input name="intent" type="hidden" value="create-manual-others-group" />
      <fieldset>
        <legend>Add a manual others source</legend>
        <p id={helpId}>
          A manual others source notifies the people an administrator adds to it
          at every event, at every facility, without a Google Group. Use it for
          the district-wide responder list. Creating the source does not add
          anyone; add people to it afterwards, and saving them publishes the
          roster or says why it could not.
        </p>
        <label>
          Display name
          <input
            aria-describedby={helpId}
            maxLength={160}
            name="displayName"
            required
            type="text"
          />
        </label>
        <button type="submit">Add manual others source</button>
      </fieldset>
    </form>
  );
}

function groupSourceIdentity(group: GroupSource): string {
  if (group.kind === 'google-group') {
    return `${group.googleGroupId} (${group.email})`;
  }
  if (group.kind === 'synthetic') {
    return group.fixtureKey;
  }
  // A manual source carries no external identifier; its members are curated here.
  return 'Curated in PSD EOC';
}

function GroupSourceReplacementForm({
  csrfToken,
  group,
}: Readonly<{ csrfToken: string; group: GroupSource }>) {
  if (
    group.kind !== 'google-group' ||
    group.purpose === 'access' ||
    !group.active
  ) {
    return null;
  }
  const helpId = `replace-group-${group.id}-help`;
  const intent = `replace-google-${group.purpose}-group`;
  return (
    <details>
      <summary>Replace {group.displayName}</summary>
      <form action="/facilities/api" method="post">
        <AdminMutationFields csrfToken={csrfToken} />
        <input name="intent" type="hidden" value={intent} />
        <input name="sourceId" type="hidden" value={group.id} />
        {group.purpose === 'building' ? (
          <input name="facilityId" type="hidden" value={group.facilityId} />
        ) : null}
        <fieldset>
          <legend>New immutable source</legend>
          <p id={helpId}>
            Saving creates a new source row and appends a roster configuration
            version. The current row and every historical configuration remain
            unchanged. A stale replacement is refused.
          </p>
          <GoogleGroupFields
            defaultDisplayName={group.displayName}
            helpId={helpId}
          />
          <button type="submit">Replace {group.displayName}</button>
        </fieldset>
      </form>
    </details>
  );
}

function GroupSourceTable({
  facilitiesById,
  groups,
  label,
}: Readonly<{
  facilitiesById: ReadonlyMap<string, Facility>;
  groups: readonly GroupSource[];
  label: string;
}>) {
  if (groups.length === 0) {
    return (
      <p role="status">No {label.toLowerCase()} sources are configured.</p>
    );
  }
  return (
    <div
      aria-label={`Configured ${label.toLowerCase()} sources`}
      className="table-region"
      role="region"
      tabIndex={0}
    >
      <table>
        <caption>{label} roster sources</caption>
        <thead>
          <tr>
            <th scope="col">Display name</th>
            <th scope="col">Kind</th>
            <th scope="col">Facility binding</th>
            <th scope="col">Source identity</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.id}>
              <th scope="row">{group.displayName}</th>
              <td>{group.kind}</td>
              <td>
                {group.facilityId === null
                  ? 'District-wide'
                  : (facilitiesById.get(group.facilityId)?.name ??
                    'Unavailable facility')}
              </td>
              <td>
                <code>{groupSourceIdentity(group)}</code>
              </td>
              <td>{group.active ? 'Active' : 'Inactive'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupSourcesSection({
  buildingPage,
  csrfToken,
  currentCursors,
  facilities,
  othersPage,
}: Readonly<{
  buildingPage: GroupSourcePage;
  csrfToken: string;
  currentCursors: FacilitiesAdminCursorState;
  facilities: readonly Facility[];
  othersPage: GroupSourcePage;
}>) {
  const buildingGroups = buildingPage.items.filter(
    (group) => group.purpose === 'building',
  );
  const othersGroups = othersPage.items.filter(
    (group) => group.purpose === 'others',
  );
  const omittedUnexpected =
    buildingGroups.length !== buildingPage.items.length ||
    othersGroups.length !== othersPage.items.length;
  const facilitiesById = new Map(
    facilities.map((facility) => [facility.id, facility]),
  );
  return (
    <section aria-labelledby="group-sources-heading">
      <h2 id="group-sources-heading">Building and others group sources</h2>
      <p>
        Building and others group sources are immutable. Replacing one creates a
        new source and appends a roster configuration version; the old source
        and historical configuration versions remain unchanged.
      </p>
      {omittedUnexpected ? (
        <p role="alert">
          Some source data was not displayed because its purpose did not match
          this administration surface.
        </p>
      ) : null}
      <h3>Building sources</h3>
      <GroupSourceTable
        facilitiesById={facilitiesById}
        groups={buildingGroups}
        label="Building"
      />
      <div aria-label="Replace active building sources" role="group">
        {buildingGroups.map((group) => (
          <GroupSourceReplacementForm
            csrfToken={csrfToken}
            group={group}
            key={group.id}
          />
        ))}
      </div>
      <div aria-label="People notified by manual building sources" role="group">
        {buildingGroups.map((group) => (
          <ManualMembersForm
            csrfToken={csrfToken}
            group={group}
            key={group.id}
          />
        ))}
      </div>
      <RosterPublishForm csrfToken={csrfToken} />
      {buildingPage.pageInfo.hasMore
        ? nextPageLink(
            'Next page of building sources',
            'buildingGroupCursor',
            buildingPage.pageInfo.nextCursor,
            currentCursors,
          )
        : null}
      <BuildingGroupForm csrfToken={csrfToken} facilities={facilities} />
      <ManualBuildingGroupForm csrfToken={csrfToken} facilities={facilities} />
      <h3>Optional others sources</h3>
      <GroupSourceTable
        facilitiesById={facilitiesById}
        groups={othersGroups}
        label="Others"
      />
      <div aria-label="Replace active others sources" role="group">
        {othersGroups.map((group) => (
          <GroupSourceReplacementForm
            csrfToken={csrfToken}
            group={group}
            key={group.id}
          />
        ))}
      </div>
      <div aria-label="People notified by manual others sources" role="group">
        {othersGroups.map((group) => (
          <ManualMembersForm
            csrfToken={csrfToken}
            group={group}
            key={group.id}
          />
        ))}
      </div>
      {othersPage.pageInfo.hasMore
        ? nextPageLink(
            'Next page of others sources',
            'othersGroupCursor',
            othersPage.pageInfo.nextCursor,
            currentCursors,
          )
        : null}
      <OthersGroupForm csrfToken={csrfToken} />
      <ManualOthersGroupForm csrfToken={csrfToken} />
    </section>
  );
}

function NeighborhoodForm({
  csrfToken,
  facilities,
  neighborhood,
}: Readonly<{
  csrfToken: string;
  facilities: readonly Facility[];
  neighborhood: Neighborhood | null;
}>) {
  const identity = neighborhood?.id ?? 'new';
  const helpId = `neighborhood-${identity}-help`;
  return (
    <form action="/facilities/api" method="post">
      <AdminMutationFields csrfToken={csrfToken} />
      <input name="intent" type="hidden" value="create-neighborhood-version" />
      {neighborhood === null ? null : (
        <input name="neighborhoodId" type="hidden" value={neighborhood.id} />
      )}
      <fieldset disabled={facilities.length === 0}>
        <legend>
          {neighborhood === null
            ? 'Add a neighborhood'
            : `Append a version of ${neighborhood.name}`}
        </legend>
        <p id={helpId}>
          Saving creates an immutable version. Earlier membership remains
          available to events that already pin it.
        </p>
        <label>
          Neighborhood name
          <input
            aria-describedby={helpId}
            autoComplete="off"
            defaultValue={neighborhood?.name}
            maxLength={160}
            name="name"
            required
          />
        </label>
        <fieldset>
          <legend>Member facilities</legend>
          <p>Select at least one facility.</p>
          {facilities.map((facility) => {
            const inputId = `neighborhood-${identity}-facility-${facility.id}`;
            return (
              <label
                className="checkbox-label"
                htmlFor={inputId}
                key={facility.id}
              >
                <input
                  defaultChecked={
                    neighborhood?.facilityIds.includes(facility.id) ?? false
                  }
                  id={inputId}
                  name="facilityIds"
                  type="checkbox"
                  value={facility.id}
                />
                <span>
                  {facility.code} — {facility.name}
                  {facility.active ? '' : ' (inactive)'}
                </span>
              </label>
            );
          })}
        </fieldset>
        <button type="submit">
          {neighborhood === null
            ? 'Add neighborhood'
            : `Create version ${neighborhood.version + 1}`}
        </button>
      </fieldset>
      {facilities.length === 0 ? (
        <p role="status">Add a facility before defining a neighborhood.</p>
      ) : null}
    </form>
  );
}

function NeighborhoodsSection({
  csrfToken,
  currentCursors,
  facilities,
  page,
}: Readonly<{
  csrfToken: string;
  currentCursors: FacilitiesAdminCursorState;
  facilities: readonly Facility[];
  page: NeighborhoodPage;
}>) {
  const facilityNames = new Map(
    facilities.map((facility) => [facility.id, facility.name]),
  );
  return (
    <section aria-labelledby="neighborhoods-heading">
      <h2 id="neighborhoods-heading">Neighborhoods</h2>
      <p>
        A neighborhood is a versioned set of geographically co-located
        facilities. An event that reaches beyond its own building pins an exact
        membership version.
      </p>
      {page.items.length === 0 ? (
        <p role="status">No neighborhoods are configured.</p>
      ) : (
        <div
          aria-label="Latest neighborhood versions"
          className="table-region"
          role="region"
          tabIndex={0}
        >
          <table>
            <caption>Latest immutable neighborhood definitions</caption>
            <thead>
              <tr>
                <th scope="col">Neighborhood</th>
                <th scope="col">Version</th>
                <th scope="col">Facilities</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((neighborhood) => (
                <tr key={neighborhood.id}>
                  <th scope="row">{neighborhood.name}</th>
                  <td>{neighborhood.version}</td>
                  <td>
                    {neighborhood.facilityIds
                      .map(
                        (facilityId) =>
                          facilityNames.get(facilityId) ??
                          'Unavailable facility',
                      )
                      .join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.pageInfo.hasMore
        ? nextPageLink(
            'Next page of neighborhoods',
            'neighborhoodCursor',
            page.pageInfo.nextCursor,
            currentCursors,
          )
        : null}
      <div aria-label="Create neighborhood versions" role="group">
        {page.items.map((neighborhood) => (
          <details key={neighborhood.id}>
            <summary>Version {neighborhood.name}</summary>
            <NeighborhoodForm
              csrfToken={csrfToken}
              facilities={facilities}
              neighborhood={neighborhood}
            />
          </details>
        ))}
      </div>
      <NeighborhoodForm
        csrfToken={csrfToken}
        facilities={facilities}
        neighborhood={null}
      />
    </section>
  );
}

/** Pure facilities administration presentation; all reads and writes stay upstream. */
export function FacilitiesAdminView(props: FacilitiesAdminViewProps) {
  if (props.view.kind === 'forbidden') {
    return (
      <main id="main-content" tabIndex={-1}>
        <section aria-labelledby="facilities-forbidden-heading">
          <h1 id="facilities-forbidden-heading">
            Administrator access required
          </h1>
          <p role="alert">
            Your PSD EOC session is active, but only district administrators can
            manage facilities, roster sources, and neighborhoods.
          </p>
          <p>No facility configuration was displayed.</p>
        </section>
      </main>
    );
  }

  const csrfToken = props.csrfToken;
  if (csrfToken === undefined) {
    throw new Error('Authorized facilities administration requires CSRF data.');
  }

  return (
    <main
      aria-labelledby="facilities-admin-heading"
      id="main-content"
      tabIndex={-1}
    >
      <header>
        <p>Administration</p>
        <h1 id="facilities-admin-heading">
          Facilities, neighborhoods, and group sources
        </h1>
        <p className="lede">
          Configure a site from start to finish without code changes. These
          controls change configuration only; they cannot start an event, send a
          notification, issue an all-clear, or close an event.
        </p>
      </header>
      {props.statusMessage === null ||
      props.statusMessage === undefined ? null : (
        <p className="notice status-message" role="status">
          {props.statusMessage}
        </p>
      )}
      <FacilitiesSection
        csrfToken={csrfToken}
        currentCursors={props.view.currentCursors}
        page={props.view.facilities}
      />
      <GroupSourcesSection
        buildingPage={props.view.buildingGroups}
        csrfToken={csrfToken}
        currentCursors={props.view.currentCursors}
        facilities={props.view.facilityOptions}
        othersPage={props.view.othersGroups}
      />
      <NeighborhoodsSection
        csrfToken={csrfToken}
        currentCursors={props.view.currentCursors}
        facilities={props.view.facilityOptions}
        page={props.view.neighborhoods}
      />
    </main>
  );
}
