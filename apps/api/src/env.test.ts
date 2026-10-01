import { expect, test } from 'vitest';
import { loadEnv } from './env.ts';

const valid = {
  DATABASE_URL: 'postgres://instantlead_app:p@h/db',
  DATABASE_OWNER_URL: 'postgres://instantlead:p@h/db',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  SECRETS_KEY: Buffer.alloc(32, 1).toString('base64'),
};

test('env errors name the bad variable', () => {
  expect(() => loadEnv({ ...valid, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  expect(() => loadEnv({ ...valid, SECRETS_KEY: 'short' })).toThrow(/SECRETS_KEY/);
  expect(loadEnv(valid).PORT).toBe(3000);
});

test('dev-only secrets from .env.example are refused in production', () => {
  const dev = { ...valid, BETTER_AUTH_SECRET: 'dev-only-auth-secret-change-me-0000000000' };
  expect(loadEnv(dev).NODE_ENV).toBe('development');
  expect(() => loadEnv({ ...dev, NODE_ENV: 'production' })).toThrow(/BETTER_AUTH_SECRET/);
  const devKey = Buffer.from('dev-only-secrets-key-32-bytes!!!').toString('base64');
  expect(() => loadEnv({ ...valid, SECRETS_KEY: devKey, NODE_ENV: 'production' })).toThrow(/SECRETS_KEY/);
});
