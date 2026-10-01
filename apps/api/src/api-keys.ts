import { createHash, randomBytes } from 'node:crypto';

// API keys are 192-bit random strings, so a fast hash is enough (no password-style KDF needed).
export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex');

export function generateApiKey() {
  const key = `il_${randomBytes(24).toString('base64url')}`;
  return { key, prefix: key.slice(0, 10), keyHash: hashApiKey(key) };
}
