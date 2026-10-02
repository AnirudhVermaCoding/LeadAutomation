import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';

let t: TestContext;
let agency: string;

beforeAll(async () => {
  t = await createTestContext();
  const { tenant } = await t.ctx.system.createTenant(
    { slug: 'a', name: 'Smile Dental', preset: 'clinic_dental' },
    { type: 'system' },
  );
  void tenant;
  await t.ctx.system.createUser({
    email: 'agency@x.test',
    name: 'Agency',
    password: PASSWORD,
    role: 'agency_admin',
    tenantId: null,
  });
  agency = await t.signIn('agency@x.test');
});
afterAll(() => t.close());

const call = (method: 'GET' | 'POST', url: string) =>
  t.app.inject({ method, url, headers: { cookie: agency }, ...(method === 'POST' ? { payload: {} } : {}) });

async function deadJob(data: object) {
  await t.ctx.boss.send('staff-alert', data, { retryLimit: 0 });
  const [job] = await t.ctx.boss.fetch('staff-alert');
  await t.ctx.boss.fail('staff-alert', job!.id, { message: 'boom' });
  const list = (await call('GET', '/v1/admin/monitoring')).json() as {
    deadLetters: { id: string; source_name: string; data: unknown }[];
  };
  return list.deadLetters.find(
    (d) => (d.data as { reason: string }).reason === (data as { reason: string }).reason,
  )!;
}

test('a dead-lettered job can be retried (back on its original queue) or discarded', async () => {
  const d = await deadJob({ tenantId: 'x', leadId: 'y', reason: 'retry me', at: '2026-10-05T00:00:00Z' });
  expect(d.source_name).toBe('staff-alert');
  expect((await call('POST', `/v1/admin/dead-letter/${d.id}/retry`)).json()).toEqual({ requeued: true });
  const back = await t.ctx.boss.fetch('staff-alert');
  expect(back[0]?.data).toMatchObject({ reason: 'retry me' });
  expect(
    ((await call('GET', '/v1/admin/monitoring')).json() as { deadLetters: unknown[] }).deadLetters,
  ).toHaveLength(0);

  const e = await deadJob({ tenantId: 'x', leadId: 'y', reason: 'drop me', at: '2026-10-05T00:00:01Z' });
  expect((await call('POST', `/v1/admin/dead-letter/${e.id}/discard`)).json()).toEqual({ discarded: true });
  expect(await t.ctx.boss.fetch('staff-alert')).toHaveLength(0);
  expect((await call('POST', `/v1/admin/dead-letter/${e.id}/discard`)).statusCode).toBe(404);
});

test('only the agency can touch dead letters', async () => {
  const r = await t.app.inject({
    method: 'POST',
    url: '/v1/admin/dead-letter/00000000-0000-4000-8000-000000000000/retry',
    payload: {},
  });
  expect([401, 403]).toContain(r.statusCode);
});
