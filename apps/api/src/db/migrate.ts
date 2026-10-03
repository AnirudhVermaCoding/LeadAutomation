import { fileURLToPath } from 'node:url';
import { TEMPLATE_KEYS, TEMPLATE_LANGUAGES, TEMPLATES } from '@instantlead/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as runMigrations } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createBoss, ensureQueues } from '../jobs.ts';
import { APP_ROLE } from './schema.ts';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * 1. Ensure the RLS-bound app role exists (credentials taken from the app's DATABASE_URL).
 * 2. Run drizzle migrations as the owner, then add rows for any new template keys to existing tenants.
 * 3. Install the pg-boss schema and queues (owner-owned).
 * 4. Grant the app role CRUD, except: audit_log is append-only and auth tables are owner-only.
 *    The app role may also enqueue jobs (inside its own transactions) in the pgboss schema.
 */
export async function migrate(ownerUrl: string, appUrl: string): Promise<void> {
  const app = new URL(appUrl);
  const login = decodeURIComponent(app.username);
  // Supabase's pooler logs in as "<role>.<project ref>"; the role itself is still instantlead_app.
  const role = login.split('.')[0];
  if (role !== APP_ROLE) throw new Error(`DATABASE_URL must connect as "${APP_ROLE}" (got "${login}")`);

  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const r = client.escapeIdentifier(role);
    const password = client.escapeLiteral(decodeURIComponent(app.password));
    const exists = await client.query('select 1 from pg_roles where rolname = $1', [role]);
    await client.query(
      `${exists.rowCount ? 'alter' : 'create'} role ${r} login nosuperuser nobypassrls password ${password}`,
    );

    // One migrator at a time (two containers starting together, a deploy script plus a restart), and never
    // wait on a table lock for ever: a migration that can't get its lock fails fast instead of queueing every query behind it.
    await client.query('select pg_advisory_lock(727274)');
    await client.query(`set lock_timeout = '10s'`);
    try {
      await runMigrations(drizzle({ client }), { migrationsFolder });
    } finally {
      await client.query('reset lock_timeout');
      await client.query('select pg_advisory_unlock(727274)');
    }

    // Template keys added in a release reach existing clinics too (never overwriting their approval status).
    for (const key of TEMPLATE_KEYS)
      for (const language of TEMPLATE_LANGUAGES)
        await client.query(
          `insert into templates (tenant_id, key, language, provider_name, category)
           select id, $1, $2, $3, $4 from tenants
           on conflict (tenant_id, key, language) do nothing`,
          [key, language, TEMPLATES[key].providerName, TEMPLATES[key].category],
        );

    const boss = createBoss(ownerUrl);
    await boss.start();
    try {
      await ensureQueues(boss);
    } finally {
      await boss.stop({ graceful: false });
    }

    await client.query(`
      grant usage on schema public to ${r};
      grant select, insert, update, delete on all tables in schema public to ${r};
      grant usage, select on all sequences in schema public to ${r};
      revoke update, delete on audit_log from ${r};
      revoke all on sessions, accounts, verifications from ${r};
      grant usage on schema pgboss to ${r};
      grant select, insert, update, delete on all tables in schema pgboss to ${r};
      grant usage, select on all sequences in schema pgboss to ${r};
      grant execute on all functions in schema pgboss to ${r};
      alter default privileges in schema pgboss grant select, insert, update, delete on tables to ${r};
    `);
    await lockDownDataApi(client);
  } finally {
    await client.end();
  }
}

/**
 * Supabase (and anything else with PostgREST roles): a new table in `public` is readable by `anon` and
 * `authenticated`, i.e. by anyone holding the project's public anon key, through the auto-generated REST API.
 * Our tables are reached only by the app role over a direct connection, so: take every privilege away from those
 * roles (now and for future tables), and turn row-level security on for any table that still lacks it (deny by
 * default). No-op on a plain Postgres, where those roles don't exist. Safe to re-run.
 */
export async function lockDownDataApi(client: { query(sql: string): Promise<unknown> }) {
  await client.query(`
    do $$
    declare r record; roles text[] := array(select rolname::text from pg_roles where rolname in ('anon', 'authenticated'));
    begin
      if cardinality(roles) > 0 then
        execute format('revoke all on all tables in schema public from %s', array_to_string(roles, ', '));
        execute format('revoke all on all sequences in schema public from %s', array_to_string(roles, ', '));
        execute format('revoke all on all functions in schema public from %s', array_to_string(roles, ', '));
        execute format('alter default privileges in schema public revoke all on tables from %s', array_to_string(roles, ', '));
        execute format('alter default privileges in schema public revoke all on sequences from %s', array_to_string(roles, ', '));
        execute format('alter default privileges in schema public revoke all on functions from %s', array_to_string(roles, ', '));
        -- Supabase also creates objects as its own admin role; cover its defaults when we are allowed to.
        begin
          execute format('alter default privileges for role postgres in schema public revoke all on tables from %s', array_to_string(roles, ', '));
        exception when others then null;
        end;
      end if;
      for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity loop
        execute format('alter table public.%I enable row level security', r.relname);
      end loop;
    end $$;
  `);
}

if (import.meta.main) {
  const { DATABASE_OWNER_URL, DATABASE_URL } = process.env;
  if (!DATABASE_OWNER_URL || !DATABASE_URL) throw new Error('Set DATABASE_OWNER_URL and DATABASE_URL');
  await migrate(DATABASE_OWNER_URL, DATABASE_URL);
  console.log('migrations applied');
}
