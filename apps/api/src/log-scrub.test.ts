import { describe, expect, test } from 'vitest';
import { requestId, scrubText, serializeError, serializeRequest } from './log-scrub.ts';

describe('log scrubbing', () => {
  test('SQL parameters, constraint values, emails and phone numbers never survive', () => {
    const drizzle =
      'Failed query: insert into "leads" ("phone_e_164") values ($1)\nparams: +919876543210,Priya Sharma,priya@example.com';
    const out = scrubText(drizzle);
    expect(out).not.toMatch(/9876543210|Priya|priya@/);
    expect(out).toContain('params: [redacted]');
    expect(
      scrubText('duplicate key: Key (tenant_id, phone_e_164)=(abc, +919876543210) already exists.'),
    ).toBe('duplicate key: Key (tenant_id, phone_e_164)=([redacted]) already exists.');
    expect(scrubText('call 9876543210 or mail a.b@c.in')).toBe('call [number] or mail [email]');
    // Ordinary text and timestamps stay readable.
    expect(scrubText('job 2026-10-02 22:36 failed after 3 retries')).toBe(
      'job 2026-10-02 22:36 failed after 3 retries',
    );
  });

  test('error serializer keeps type, pg code and a scrubbed cause, drops bound values', () => {
    const cause = Object.assign(new Error('Key (phone)=(+919876543210) already exists'), { code: '23505' });
    const err = Object.assign(new Error('Failed query: x\nparams: +919876543210'), { cause });
    const s = serializeError(err);
    expect(JSON.stringify(s)).not.toContain('9876543210');
    expect(s).toMatchObject({ cause: { code: '23505' } });
  });

  test('query strings of webhook and OAuth URLs are not logged', () => {
    expect(
      serializeRequest({ method: 'GET', url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=SECRET' })
        .url,
    ).toBe('/webhooks/meta');
    expect(
      serializeRequest({ method: 'GET', url: '/v1/integrations/google/callback?code=4/0AX&state=abc' }).url,
    ).toBe('/v1/integrations/google/callback');
    expect(serializeRequest({ method: 'GET', url: '/v1/slots?service=Cleaning' }).url).toBe(
      '/v1/slots?service=Cleaning',
    );
  });

  test('request ids: a sane incoming one is kept, junk is replaced', () => {
    expect(requestId('abc12345-trace')).toBe('abc12345-trace');
    expect(requestId('x'.repeat(200))).not.toBe('x'.repeat(200));
    expect(requestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
