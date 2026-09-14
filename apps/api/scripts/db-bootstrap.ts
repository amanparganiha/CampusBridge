/**
 * Creates or updates the LOGIN users the application connects as, and makes them members of
 * the NOLOGIN group roles that migrations grant privileges to:
 *
 *   DATABASE_URL         -> member of cb_app_rw     (API + job handlers; RLS always applies)
 *   SYSTEM_DATABASE_URL  -> member of cb_system_rw  (worker outbox relay and scanners)
 *
 * Usernames and passwords are taken from those URLs, so the connection strings the app uses are
 * the single source of truth. Runs as the schema owner (MIGRATE_DATABASE_URL) after migrations,
 * and is idempotent: run it on every deploy to apply password rotations.
 */
import pg from 'pg';
import { scramSha256Verifier } from '../src/db/scram.js';

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

interface LoginRoleSpec {
  urlVariable: 'DATABASE_URL' | 'SYSTEM_DATABASE_URL';
  group: 'cb_app_rw' | 'cb_system_rw';
  /** Per-role defaults so a runaway query or a forgotten transaction cannot hold resources. */
  settings: Record<
    'statement_timeout' | 'lock_timeout' | 'idle_in_transaction_session_timeout',
    string
  >;
}

const LOGIN_ROLES: readonly LoginRoleSpec[] = [
  {
    urlVariable: 'DATABASE_URL',
    group: 'cb_app_rw',
    settings: {
      statement_timeout: '15s',
      lock_timeout: '5s',
      idle_in_transaction_session_timeout: '30s',
    },
  },
  {
    urlVariable: 'SYSTEM_DATABASE_URL',
    group: 'cb_system_rw',
    settings: {
      statement_timeout: '60s',
      lock_timeout: '5s',
      idle_in_transaction_session_timeout: '60s',
    },
  },
];

function credentialsFrom(urlVariable: string): { username: string; password: string } | undefined {
  const raw = process.env[urlVariable];
  if (!raw) return undefined;

  const url = new URL(raw);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!ROLE_NAME.test(username)) {
    throw new Error(
      `${urlVariable}: "${username}" is not a valid role name (${String(ROLE_NAME)})`,
    );
  }
  if (!password) {
    throw new Error(`${urlVariable}: a password is required`);
  }
  return { username, password };
}

/** Quotes identifiers/literals server-side with format(), so no SQL is built by concatenation. */
async function execFormatted(
  client: pg.Client,
  template: string,
  ...args: string[]
): Promise<void> {
  const placeholders = args.map((_, index) => `$${String(index + 2)}::text`).join(', ');
  const { rows } = await client.query<{ sql: string }>(
    `SELECT format($1::text, ${placeholders}) AS sql`,
    [template, ...args],
  );
  const statement = rows[0]?.sql;
  if (!statement) throw new Error(`format() returned nothing for: ${template}`);
  await client.query(statement);
}

async function ensureLoginRole(
  client: pg.Client,
  spec: LoginRoleSpec,
): Promise<string | undefined> {
  const credentials = credentialsFrom(spec.urlVariable);
  if (!credentials) return undefined;
  const { username, password } = credentials;

  const owner = await client.query<{ current_user: string }>('SELECT current_user');
  if (owner.rows[0]?.current_user === username) {
    throw new Error(`${spec.urlVariable} must not use the schema owner "${username}"`);
  }

  const group = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [spec.group]);
  if (group.rowCount === 0) {
    throw new Error(`Group role ${spec.group} does not exist. Run the migrations first.`);
  }

  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [username]);
  const verb = exists.rowCount === 0 ? 'CREATE' : 'ALTER';
  await execFormatted(
    client,
    `${verb} ROLE %I WITH LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L`,
    username,
    scramSha256Verifier(password),
  );
  await execFormatted(client, 'GRANT %I TO %I', spec.group, username);
  for (const [setting, value] of Object.entries(spec.settings)) {
    await execFormatted(client, `ALTER ROLE %I SET ${setting} = %L`, username, value);
  }
  return `${verb === 'CREATE' ? 'created' : 'updated'} ${username} (member of ${spec.group})`;
}

async function main(): Promise<void> {
  const ownerUrl = process.env.MIGRATE_DATABASE_URL;
  if (!ownerUrl) throw new Error('MIGRATE_DATABASE_URL is required');

  const client = new pg.Client({
    connectionString: ownerUrl,
    application_name: 'campusbridge-db-bootstrap',
  });
  await client.connect();
  try {
    for (const spec of LOGIN_ROLES) {
      const outcome = await ensureLoginRole(client, spec);
      console.log(
        outcome ? `db-bootstrap: ${outcome}` : `db-bootstrap: ${spec.urlVariable} not set, skipped`,
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('db-bootstrap failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
