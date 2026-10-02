import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { withTenant } from './db/client.ts';
import { consents, leads, messages } from './db/schema.ts';

let t: TestContext;
let A: string;
let cookie: string;
let url: string;

beforeAll(async () => {
  t = await createTestContext();
  A = (
    await t.ctx.system.createTenant(
      {
        slug: 'a',
        name: 'Skyline Realty',
        preset: 'real_estate',
        admin: { email: 'admin@a.test', name: 'A', password: PASSWORD },
      },
      { type: 'system' },
    )
  ).tenant.id;
  cookie = await t.signIn('admin@a.test');
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/integrations/email-in/rotate',
    headers: { cookie },
    payload: {},
  });
  url = new URL((res.json() as { email_in_url: string }).email_in_url).pathname;
});
afterAll(() => t.close());

const post = (path: string, payload: object, contentType = 'application/json') =>
  t.app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': contentType },
    payload:
      contentType === 'application/json'
        ? payload
        : new URLSearchParams(payload as Record<string, string>).toString(),
  });

describe('portal lead emails', () => {
  test('a forwarded enquiry becomes a lead with recorded consent and gets the first reply', async () => {
    const res = await post(url, {
      from: 'noreply@99acres.com',
      subject: 'New response',
      text: 'Name: Rohit Mehra\nMobile: +91 98765 43210\nEmail: rohit@example.com\nRequirement: 3 BHK Baner',
    });
    expect(res.json()).toMatchObject({ ok: true, created: true });
    await t.drainJobs();
    const [lead] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(leads).where(eq(leads.phoneE164, '+919876543210')),
    );
    expect(lead).toMatchObject({ name: 'Rohit Mehra', email: 'rohit@example.com', source: 'portal_email' });
    expect(lead!.sourceDetails).toMatchObject({ portal: '99acres', message: '3 BHK Baner' });
    const [c] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(consents).where(eq(consents.leadId, lead!.id)),
    );
    expect(c).toMatchObject({ source: 'portal_email' });
    expect(c!.noticeText).toMatch(/through 99acres/);
    const out = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(messages).where(eq(messages.leadId, lead!.id)),
    );
    expect(out.some((m) => m.templateKey === 'first_reply')).toBe(true);
  });

  test('the same enquiry twice is one lead; form-encoded posts (Mailgun style) work', async () => {
    const mail = {
      sender: 'leads@magicbricks.com',
      subject: 's',
      'body-plain': 'Customer Name: Anita\nContact No: 9876543299',
    };
    expect((await post(url, mail, 'application/x-www-form-urlencoded')).json()).toMatchObject({
      created: true,
    });
    expect((await post(url, mail, 'application/x-www-form-urlencoded')).json()).toMatchObject({
      created: false,
    });
  });

  test('no phone: acknowledged (no retries) but nothing is created; wrong key is 404; rotating kills the old address', async () => {
    expect((await post(url, { text: 'Name: X' })).json()).toMatchObject({
      ok: true,
      ignored: expect.stringMatching(/no phone/),
    });
    expect((await post('/webhooks/email-in/nope', { text: 'Mobile: 9876543210' })).statusCode).toBe(404);
    await t.app.inject({
      method: 'POST',
      url: '/v1/integrations/email-in/rotate',
      headers: { cookie },
      payload: {},
    });
    expect((await post(url, { text: 'Mobile: 9876543210' })).statusCode).toBe(404);
  });
});
