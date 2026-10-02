import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';

// The queries that run constantly (every inbox open, assistant turn, sweep, report) must use indexes at
// realistic volume. Seeds ~100k rows across two tenants, then reads the plans. A new full scan on a hot
// path fails here instead of in production at 3 am.
let t: TestContext;
let A: string;
let B: string;
let aLead = '';

beforeAll(async () => {
  t = await createTestContext();
  const mk = async (slug: string) =>
    (
      await t.ctx.system.createTenant(
        {
          slug,
          name: slug,
          preset: 'clinic_dental',
          admin: { email: `admin@${slug}.test`, name: slug, password: PASSWORD },
        },
        { type: 'system' },
      )
    ).tenant.id;
  A = await mk('a');
  B = await mk('b');
  const o = (sql: string, args: unknown[] = []) => t.owner.query(sql, args);
  for (const tenant of [A, B]) {
    await o(
      `insert into leads (tenant_id, phone_e_164, source, state, received_at)
       select $1, '+91' || (9000000000 + g + ($2::int * 1000000)), 'form', 'qualifying', now() - (g || ' minutes')::interval
       from generate_series(1, 10000) g`,
      [tenant, tenant === A ? 1 : 2],
    );
    await o(
      `insert into messages (tenant_id, lead_id, direction, kind, body, status, occurred_at)
       select $1, l.id, 'out', 'text', 'x', 'sent', now() - (n || ' minutes')::interval
       from (select id from leads where tenant_id = $1 limit 2000) l, generate_series(1, 10) n`,
      [tenant],
    );
    await o(
      `insert into llm_runs (tenant_id, lead_id, provider, model, latency_ms, occurred_at, cost_usd)
       select $1, l.id, 'fake', 'fake', 100, now() - (n || ' hours')::interval, 0.001
       from (select id from leads where tenant_id = $1 limit 2000) l, generate_series(1, 5) n`,
      [tenant],
    );
    await o(
      `insert into events (tenant_id, type, payload, occurred_at)
       select $1, case when g % 3 = 0 then 'appointment.booked' else 'lead.created' end, '{}', now() - (g || ' minutes')::interval
       from generate_series(1, 10000) g`,
      [tenant],
    );
  }
  // Other clinics sharing the database: a tenant is a minority of the rows, as in production.
  await o(
    `insert into tenants (slug, name) select 'other-' || g, 'Other ' || g from generate_series(1, 12) g`,
  );
  await o(
    `insert into leads (tenant_id, phone_e_164, source, state, received_at)
     select t.id, '+91' || (8000000000::bigint + g + (row_number() over ())::bigint * 100000), 'form', 'new', now() - (g || ' minutes')::interval
     from tenants t, generate_series(1, 5000) g where t.slug like 'other-%'`,
  );
  await o(`analyze leads`);
  aLead = (await o(`select id from leads where tenant_id = $1 limit 1`, [A])).rows[0].id;
  await o(
    `insert into enrollments (tenant_id, lead_id, kind, status, started_at)
     select tenant_id, id, 'followup', 'active', now() from leads where tenant_id in ($1, $2)`,
    [A, B],
  );
  await o(
    `insert into enrollment_steps (tenant_id, enrollment_id, step, action, due_at, status)
     select tenant_id, id, 1, 'message', now() + make_interval(hours => (random() * 100)::int), 'pending' from enrollments`,
  );
  for (const table of [
    'leads',
    'messages',
    'llm_runs',
    'events',
    'enrollments',
    'enrollment_steps',
    'appointments',
  ])
    await o(`analyze ${table}`);
}, 120_000);
afterAll(() => t.close());

/** Every plan node's type + relation, flattened. */
async function plan(sql: string, args: unknown[] = []) {
  const { rows } = await t.owner.query(`explain (format json) ${sql}`, args);
  const nodes: { type: string; relation?: string }[] = [];
  const walk = (n: { 'Node Type': string; 'Relation Name'?: string; Plans?: unknown[] }) => {
    nodes.push({ type: n['Node Type'], relation: n['Relation Name'] });
    for (const c of (n.Plans ?? []) as (typeof n)[]) walk(c);
  };
  walk(rows[0]['QUERY PLAN'][0].Plan);
  return nodes;
}
const noSeqScan = (nodes: { type: string; relation?: string }[], relation: string) =>
  expect(nodes.filter((n) => n.type === 'Seq Scan' && n.relation === relation)).toEqual([]);

test('inbox: newest leads of a tenant', async () => {
  noSeqScan(
    await plan(`select * from leads where tenant_id = $1 order by received_at desc limit 50`, [A]),
    'leads',
  );
});

test('a conversation: messages of one lead, in order', async () => {
  noSeqScan(
    await plan(`select * from messages where lead_id = $1 order by occurred_at`, [aLead]),
    'messages',
  );
});

test("assistant turn: this lead's AI spend and this tenant's month so far", async () => {
  noSeqScan(await plan(`select sum(cost_usd) from llm_runs where lead_id = $1`, [aLead]), 'llm_runs');
  noSeqScan(
    await plan(
      `select sum(cost_usd) from llm_runs where tenant_id = $1 and occurred_at >= now() - interval '2 hours'`,
      [A],
    ),
    'llm_runs',
  );
});

test('sequence sweep: due steps, oldest first', async () => {
  noSeqScan(
    await plan(
      `select id from enrollment_steps where status = 'pending' and due_at <= now() + interval '1 hour' order by due_at limit 200`,
    ),
    'enrollment_steps',
  );
});

test("weekly report: events of one type in a window; a lead's enrolments", async () => {
  noSeqScan(
    await plan(
      `select count(*) from events where tenant_id = $1 and type = 'appointment.booked' and occurred_at >= now() - interval '1 day'`,
      [A],
    ),
    'events',
  );
  noSeqScan(await plan(`select * from enrollments where lead_id = $1`, [aLead]), 'enrollments');
});

test("B never needs A's data: the same queries stay indexed for the second tenant", async () => {
  noSeqScan(
    await plan(`select * from leads where tenant_id = $1 order by received_at desc limit 50`, [B]),
    'leads',
  );
});
