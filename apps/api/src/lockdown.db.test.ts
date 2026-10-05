import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestContext, type TestContext } from '../test/context.ts';
import { lockDownDataApi } from './db/migrate.ts';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
  // What Supabase gives every new table: full access for its public REST roles.
  await t.owner.query(`do $$ begin
    if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$`);
  await t.owner.query(`grant usage on schema public to anon, authenticated`);
  await t.owner.query(`alter default privileges in schema public grant all on tables to anon, authenticated`);
  await t.owner.query(`grant all on all tables in schema public to anon, authenticated`);
});
afterAll(() => t.close());

const exposed = async () =>
  (
    await t.owner.query<{ relname: string }>(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relkind = 'r' and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))`)
  ).rows.map((r) => r.relname);

test('public REST roles lose all access to our tables, now and for tables created later; RLS is on everywhere', async () => {
  expect((await exposed()).length).toBeGreaterThan(20); // the Supabase default: everything exposed
  await lockDownDataApi(t.owner);
  expect(await exposed()).toEqual([]);
  await t.owner.query(`create table public.zz_later (id int)`);
  expect(await exposed()).toEqual([]); // default privileges no longer grant new tables
  const noRls = await t.owner.query(
    `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public' where relkind = 'r' and not relrowsecurity and relname <> 'zz_later'`,
  );
  expect(noRls.rows).toEqual([]); // accounts, sessions, verifications were the ones without
  await t.owner.query(`drop table public.zz_later`);
});

test('re-running is harmless, and the app role is unaffected', async () => {
  await lockDownDataApi(t.owner);
  await lockDownDataApi(t.owner);
  const r = await t.owner.query(
    `select has_table_privilege('instantlead_app', 'public.leads', 'select') as ok`,
  );
  expect(r.rows[0].ok).toBe(true);
});

test('the app pool sets its statement timeout by SQL, not as a startup parameter (poolers may refuse those)', async () => {
  const pool = t.ctx.db.$client;
  expect((pool.options as { statement_timeout?: unknown }).statement_timeout).toBeUndefined();
  const r = await pool.query<{ statement_timeout: string }>('show statement_timeout');
  expect(r.rows[0]!.statement_timeout).toBe('30s');
});
