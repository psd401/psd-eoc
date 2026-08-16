import {
  EXPLORATION_DATABASE_LOGIN,
  EXPLORATION_DATABASE_ROLE,
} from './config';

export interface RoleStatementExecutor {
  execute(sql: string): Promise<readonly Readonly<Record<string, unknown>>[]>;
}

export interface ApplicationRoleVerification {
  readonly applicationLogin: typeof EXPLORATION_DATABASE_LOGIN;
  readonly inheritedRole: typeof EXPLORATION_DATABASE_ROLE;
  readonly directMembershipCount: 1;
  readonly privilegedFlags: false;
}

function quoteSqlLiteral(value: string): string {
  if (value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new Error('The application database password was invalid.');
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Fixed role DDL. The only dynamic SQL literal is an already schema-validated
 * generated password; its value is never returned, logged, or put in argv.
 */
export function buildApplicationRoleStatements(
  password: string,
): readonly string[] {
  const passwordLiteral = quoteSqlLiteral(password);
  return Object.freeze([
    `DO $psd_eoc_exploration$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${EXPLORATION_DATABASE_LOGIN}') THEN\n    CREATE ROLE "${EXPLORATION_DATABASE_LOGIN}" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;\n  END IF;\nEND\n$psd_eoc_exploration$`,
    `ALTER ROLE "${EXPLORATION_DATABASE_LOGIN}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${passwordLiteral}`,
    `DO $psd_eoc_exploration$\nDECLARE\n  granted_role name;\nBEGIN\n  FOR granted_role IN\n    SELECT parent.rolname\n    FROM pg_catalog.pg_auth_members AS membership\n    JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member\n    JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid\n    WHERE child.rolname = '${EXPLORATION_DATABASE_LOGIN}'\n      AND parent.rolname <> '${EXPLORATION_DATABASE_ROLE}'\n  LOOP\n    EXECUTE format('REVOKE %I FROM "${EXPLORATION_DATABASE_LOGIN}"', granted_role);\n  END LOOP;\nEND\n$psd_eoc_exploration$`,
    `GRANT "${EXPLORATION_DATABASE_ROLE}" TO "${EXPLORATION_DATABASE_LOGIN}"`,
    `REVOKE ADMIN OPTION FOR "${EXPLORATION_DATABASE_ROLE}" FROM "${EXPLORATION_DATABASE_LOGIN}"`,
  ]);
}

export const ROLE_STATE_QUERY = `SELECT
  rolname AS "roleName",
  rolcanlogin AS "canLogin",
  rolsuper AS "superuser",
  rolcreatedb AS "createDatabase",
  rolcreaterole AS "createRole",
  rolreplication AS "replication",
  rolbypassrls AS "bypassRls",
  rolinherit AS "inherits"
FROM pg_catalog.pg_roles
WHERE rolname IN ('${EXPLORATION_DATABASE_LOGIN}', '${EXPLORATION_DATABASE_ROLE}')
ORDER BY rolname`;

export const ROLE_MEMBERSHIP_QUERY = `SELECT
  parent.rolname AS "grantedRole",
  membership.admin_option AS "adminOption"
FROM pg_catalog.pg_auth_members AS membership
JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
WHERE child.rolname = '${EXPLORATION_DATABASE_LOGIN}'
ORDER BY parent.rolname`;

export const APPLICATION_LOGIN_PROBE_QUERY = `SELECT
  current_user AS "currentUser",
  session_user AS "sessionUser",
  pg_has_role(current_user, '${EXPLORATION_DATABASE_ROLE}', 'member') AS "applicationRoleMember"`;

export const DATABASE_TLS_QUERY = `SELECT
  ssl AS "ssl",
  version AS "tlsVersion"
FROM pg_catalog.pg_stat_ssl
WHERE pid = pg_backend_pid()`;

interface RoleRow {
  readonly roleName: string;
  readonly canLogin: boolean;
  readonly superuser: boolean;
  readonly createDatabase: boolean;
  readonly createRole: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
  readonly inherits: boolean;
}

function parseRoleRow(value: Readonly<Record<string, unknown>>): RoleRow {
  const result = {
    roleName: value.roleName,
    canLogin: value.canLogin,
    superuser: value.superuser,
    createDatabase: value.createDatabase,
    createRole: value.createRole,
    replication: value.replication,
    bypassRls: value.bypassRls,
    inherits: value.inherits,
  };
  if (
    typeof result.roleName !== 'string' ||
    typeof result.canLogin !== 'boolean' ||
    typeof result.superuser !== 'boolean' ||
    typeof result.createDatabase !== 'boolean' ||
    typeof result.createRole !== 'boolean' ||
    typeof result.replication !== 'boolean' ||
    typeof result.bypassRls !== 'boolean' ||
    typeof result.inherits !== 'boolean'
  ) {
    throw new Error('The database role verification result was invalid.');
  }
  return result as RoleRow;
}

/** Proves the LOGIN flags and direct memberships exactly, not approximately. */
export function assertApplicationRoleState(
  roleValues: readonly Readonly<Record<string, unknown>>[],
  membershipValues: readonly Readonly<Record<string, unknown>>[],
): ApplicationRoleVerification {
  const roles = roleValues.map(parseRoleRow);
  if (roles.length !== 2) {
    throw new Error('The database role boundary was not established.');
  }
  const applicationRole = roles.find(
    (role) => role.roleName === EXPLORATION_DATABASE_ROLE,
  );
  const applicationLogin = roles.find(
    (role) => role.roleName === EXPLORATION_DATABASE_LOGIN,
  );
  if (
    applicationRole === undefined ||
    applicationRole.canLogin ||
    applicationRole.superuser ||
    applicationRole.createDatabase ||
    applicationRole.createRole ||
    applicationRole.replication ||
    applicationRole.bypassRls ||
    !applicationRole.inherits ||
    applicationLogin === undefined ||
    !applicationLogin.canLogin ||
    applicationLogin.superuser ||
    applicationLogin.createDatabase ||
    applicationLogin.createRole ||
    applicationLogin.replication ||
    applicationLogin.bypassRls ||
    !applicationLogin.inherits
  ) {
    throw new Error('The database role boundary was not established.');
  }
  if (
    membershipValues.length !== 1 ||
    membershipValues[0]?.grantedRole !== EXPLORATION_DATABASE_ROLE ||
    membershipValues[0]?.adminOption !== false
  ) {
    throw new Error('The application LOGIN has unexpected role membership.');
  }
  return Object.freeze({
    applicationLogin: EXPLORATION_DATABASE_LOGIN,
    inheritedRole: EXPLORATION_DATABASE_ROLE,
    directMembershipCount: 1,
    privilegedFlags: false,
  });
}

/** Creates/rotates the LOGIN and then reads back all privilege invariants. */
export async function configureAndVerifyApplicationRole(input: {
  readonly executor: RoleStatementExecutor;
  readonly password: string;
}): Promise<ApplicationRoleVerification> {
  for (const statement of buildApplicationRoleStatements(input.password)) {
    await input.executor.execute(statement);
  }
  const roles = await input.executor.execute(ROLE_STATE_QUERY);
  const memberships = await input.executor.execute(ROLE_MEMBERSHIP_QUERY);
  return assertApplicationRoleState(roles, memberships);
}

/** Proves the generated application secret authenticates as only that LOGIN. */
export async function verifyApplicationLogin(input: {
  readonly executor: RoleStatementExecutor;
}): Promise<void> {
  const rows = await input.executor.execute(APPLICATION_LOGIN_PROBE_QUERY);
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.currentUser !== EXPLORATION_DATABASE_LOGIN ||
    row.sessionUser !== EXPLORATION_DATABASE_LOGIN ||
    row.applicationRoleMember !== true
  ) {
    throw new Error(
      'The application database secret could not prove its role.',
    );
  }
}

/** Proves the current native session negotiated an authenticated TLS channel. */
export async function verifyDatabaseTls(input: {
  readonly executor: RoleStatementExecutor;
}): Promise<void> {
  const rows = await input.executor.execute(DATABASE_TLS_QUERY);
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.ssl !== true ||
    typeof row.tlsVersion !== 'string' ||
    !/^TLSv1[.][23]$/u.test(row.tlsVersion)
  ) {
    throw new Error('The database session did not prove verified TLS.');
  }
}
