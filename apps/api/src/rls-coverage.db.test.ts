import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';

// Generated, not hand-listed: every table with a tenant_id column, whatever it is called, must keep tenants apart.
let t: TestContext;
let A: string;
let B: string;
let app: pg.Pool;

beforeAll(async () => {
  t = await createTestContext();
  const mk = async (slug: string) => {
    const { tenant } = await t.ctx.system.createTenant(
      {
        slug,
        name: `Clinic ${slug}`,
        preset: 'clinic_dental',
        admin: { email: `admin@${slug}.test`, name: slug, password: PASSWORD },
      },
      { type: 'system' },
    );
    const cookie = await t.signIn(`admin@${slug}.test`);
    // Real data in as many tables as the product writes: leads, messages, jobs' events, appointments, blocks, Google…
    for (let i = 0; i < 3; i++)
      await t.app.inject({
        method: 'POST',
        url: '/v1/leads',
        headers: { cookie },
        payload: { phone: `98791${slug === 'a' ? 1 : 2}000${i}`, name: 'X', consent: { granted: true } },
      });
    await t.app.inject({ method: 'POST', url: '/v1/dev/google/connect', headers: { cookie }, payload: {} });
    await t.app.inject({
      method: 'POST',
      url: '/v1/blocked-times',
      headers: { cookie },
      payload: { starts_at: '2026-12-01T05:00:00Z', ends_at: '2026-12-01T06:00:00Z' },
    });
    return tenant.id;
  };
  A = await mk('a');
  B = await mk('b');
  await t.drainJobs();
  // The runtime role, exactly as the app connects (not the owner).
  app = new pg.Pool({ connectionString: t.ctx.env.DATABASE_URL, max: 2 });
});
afterAll(async () => {
  await app.end();
  await t.close();
});

async function tenantTables() {
  const { rows } = await t.owner.query<{ table: string; rls: boolean; policies: string }>(`
    select c.relname as table, c.relrowsecurity as rls,
      (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
    from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where c.relkind = 'r' and exists (
      select 1 from information_schema.columns col
      where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'tenant_id')
    order by 1`);
  return rows;
}

test('every tenant table has RLS on and at least one policy', async () => {
  const tables = await tenantTables();
  expect(tables.length).toBeGreaterThan(20);
  expect(tables.filter((x) => !x.rls || Number(x.policies) === 0)).toEqual([]);
});

test("as the app role: no tenant context sees nothing; each tenant sees exactly its own rows; the other tenant's rows cannot be changed or deleted", async () => {
  const problems: string[] = [];
  let withRows = 0;
  for (const { table } of await tenantTables()) {
    const q = (s: string) => `select count(*)::int as n from "${table}" ${s}`;
    const owner = async (id: string) =>
      (await t.owner.query<{ n: number }>(q(`where tenant_id = '${id}'`))).rows[0]!.n;
    const [ownA, ownB] = [await owner(A), await owner(B)];
    const asTenant = async (id: string | null, sql: string) => {
      const c = await app.connect();
      try {
        await c.query('begin');
        if (id) await c.query(`select set_config('app.tenant_id', $1, true)`, [id]);
        const r = await c.query(sql);
        await c.query('rollback');
        return r;
      } catch (err) {
        await c.query('rollback');
        throw err;
      } finally {
        c.release();
      }
    };
    const none = (await asTenant(null, q(''))).rows[0].n as number;
    const seenA = (await asTenant(A, q(''))).rows[0].n as number;
    const seenB = (await asTenant(B, q(''))).rows[0].n as number;
    if (none !== 0) problems.push(`${table}: ${none} rows visible with no tenant set`);
    if (seenA !== ownA) problems.push(`${table}: tenant A sees ${seenA}, owns ${ownA}`);
    if (seenB !== ownB) problems.push(`${table}: tenant B sees ${seenB}, owns ${ownB}`);
    if (ownA + ownB > 0) withRows++;
    // B tries to reach A's rows by naming them.
    const del = await asTenant(B, `delete from "${table}" where tenant_id = '${A}'`).catch(() => ({
      rowCount: 0,
    })); // permission denied (append-only tables) is a refusal too
    const upd = await asTenant(
      B,
      `update "${table}" set tenant_id = tenant_id where tenant_id = '${A}'`,
    ).catch(() => ({ rowCount: 0 }));
    if (del.rowCount) problems.push(`${table}: B deleted ${del.rowCount} of A's rows`);
    if (upd.rowCount) problems.push(`${table}: B updated ${upd.rowCount} of A's rows`);
  }
  expect(problems).toEqual([]);
  expect(withRows).toBeGreaterThan(10); // the check above is meaningful: most tables really had data
});

test('the app role is not a superuser and cannot bypass RLS', async () => {
  const { rows } = await app.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    `select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
  );
  expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
});
