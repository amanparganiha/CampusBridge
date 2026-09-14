import pg from 'pg';
import { scramSha256Verifier } from './scram.js';

/**
 * Creates or updates the LOGIN users the application connects as, and makes them members of
 * the NOLOGIN group roles that migrations grant privileges to. Usernames and passwords come
 * from the application's own connection URLs, so those URLs are the single source of truth.
 * Idempotent: safe to run on every deploy (it also applies password rotations).
 */

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

type RoleSetting = 'statement_timeout' | 'lock_timeout' | 'idle_in_transaction_session_timeout';

interface LoginRoleSpec {
  label: string;
  url: string | undefined;
  group: 'cb_app_rw' | 'cb_system_rw';
  /** Per-role defaults so a runaway query or a forgotten transaction cannot hold resources. */
  settings: Record<RoleSetting, string>;
}

export interface BootstrapOptions {
  /** Schema owner connection (MIGRATE_DATABASE_URL). */
  ownerUrl: string;
  /** Runtime connection (DATABASE_URL): becomes a member of cb_app_rw. */
  appUrl?: string | undefined;
  /** Relay connection (SYSTEM_DATABASE_URL): becomes a member of cb_system_rw. */
  systemUrl?: string | undefined;
}

function credentialsFrom(label: string, raw: string): { username: string; password: string } {
  const url = new URL(raw);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!ROLE_NAME.test(username)) {
    throw new Error(`${label}: "${username}" is not a valid role name (${String(ROLE_NAME)})`);
  }
  if (!password) throw new Error(`${label}: a password is required`);
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
  spec: LoginRoleSpec & { url: string },
): Promise<string> {
  const { username, password } = credentialsFrom(spec.label, spec.url);

  const owner = await client.query<{ current_user: string }>('SELECT current_user');
  if (owner.rows[0]?.current_user === username) {
    throw new Error(`${spec.label} must not use the schema owner "${username}"`);
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

/** Returns one human-readable outcome line per role. */
export async function bootstrapLoginRoles(options: BootstrapOptions): Promise<string[]> {
  const specs: LoginRoleSpec[] = [
    {
      label: 'DATABASE_URL',
      url: options.appUrl,
      group: 'cb_app_rw',
      settings: {
        statement_timeout: '15s',
        lock_timeout: '5s',
        idle_in_transaction_session_timeout: '30s',
      },
    },
    {
      label: 'SYSTEM_DATABASE_URL',
      url: options.systemUrl,
      group: 'cb_system_rw',
      settings: {
        statement_timeout: '60s',
        lock_timeout: '5s',
        idle_in_transaction_session_timeout: '60s',
      },
    },
  ];

  const client = new pg.Client({
    connectionString: options.ownerUrl,
    application_name: 'campusbridge-db-bootstrap',
  });
  await client.connect();
  try {
    const outcomes: string[] = [];
    for (const spec of specs) {
      outcomes.push(
        spec.url
          ? await ensureLoginRole(client, { ...spec, url: spec.url })
          : `${spec.label} not set, skipped`,
      );
    }
    return outcomes;
  } finally {
    await client.end();
  }
}
