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
  const role = decodeURIComponent(app.username);
  if (role !== APP_ROLE) throw new Error(`DATABASE_URL must connect as "${APP_ROLE}" (got "${role}")`);

  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const r = client.escapeIdentifier(role);
    const password = client.escapeLiteral(decodeURIComponent(app.password));
    const exists = await client.query('select 1 from pg_roles where rolname = $1', [role]);
    await client.query(
      `${exists.rowCount ? 'alter' : 'create'} role ${r} login nosuperuser nobypassrls password ${password}`,
    );

    await runMigrations(drizzle({ client }), { migrationsFolder });

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
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  const { DATABASE_OWNER_URL, DATABASE_URL } = process.env;
  if (!DATABASE_OWNER_URL || !DATABASE_URL) throw new Error('Set DATABASE_OWNER_URL and DATABASE_URL');
  await migrate(DATABASE_OWNER_URL, DATABASE_URL);
  console.log('migrations applied');
}
