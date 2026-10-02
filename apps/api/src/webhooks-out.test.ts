import { createHmac } from 'node:crypto';
import { expect, test } from 'vitest';
import { assertPublicUrl, signWebhook } from './webhooks-out.ts';

test('webhook URLs on private, loopback, link-local or metadata addresses are refused', async () => {
  for (const url of [
    'https://127.0.0.1/x',
    'https://10.1.2.3/x',
    'https://172.20.0.5/x',
    'https://192.168.1.1/x',
    'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/x',
    'https://[::1]/x',
    'https://[fd00::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://[::ffff:10.0.0.1]/x',
    'https://[::ffff:a9fe:a9fe]/x', // metadata address, hex-mapped (what URL normalises to)
    'https://[::]/x',
    'https://0.0.0.0/x',
  ])
    await expect(assertPublicUrl(url), url).rejects.toThrow(/not a public address/);
  await expect(assertPublicUrl('https://8.8.8.8/hook')).resolves.toBeUndefined();
});

test('signature is t=<unix>,v1=HMAC-SHA256(secret, "<t>.<body>")', () => {
  const expected = createHmac('sha256', 'whsec_x').update('1700000000.{"a":1}').digest('hex');
  expect(signWebhook('whsec_x', '{"a":1}', 1_700_000_000)).toBe(`t=1700000000,v1=${expected}`);
});
