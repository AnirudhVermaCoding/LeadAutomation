import { randomBytes } from 'node:crypto';
import { expect, test } from 'vitest';
import { decryptSecret, encryptSecret } from './secrets.ts';

const key = randomBytes(32);
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

test('round-trips and binds ciphertext to tenant + name', () => {
  const blob = encryptSecret(key, A, 'token', 'shh');
  expect(blob).toMatch(/^v1\./);
  expect(decryptSecret(key, A, 'token', blob)).toBe('shh');
  expect(() => decryptSecret(key, B, 'token', blob)).toThrow();
  expect(() => decryptSecret(key, A, 'other', blob)).toThrow();
  expect(() => decryptSecret(randomBytes(32), A, 'token', blob)).toThrow();
});

test('detects tampering', () => {
  const [v, iv, tag, ct = ''] = encryptSecret(key, A, 'token', 'shh').split('.');
  const flipped = Buffer.from(ct, 'base64url');
  flipped[0] = (flipped[0] ?? 0) ^ 1;
  expect(() =>
    decryptSecret(key, A, 'token', [v, iv, tag, flipped.toString('base64url')].join('.')),
  ).toThrow();
});
