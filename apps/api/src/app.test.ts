import { expect, test } from 'vitest';
import { buildApp } from './app.ts';

test('healthz is always up; readyz follows the database check', async () => {
  const healthy = buildApp({ logLevel: 'silent', checkDb: async () => {} });
  expect((await healthy.inject('/healthz')).statusCode).toBe(200);
  expect((await healthy.inject('/readyz')).statusCode).toBe(200);

  const dbDown = buildApp({
    logLevel: 'silent',
    checkDb: () => Promise.reject(new Error('db down')),
  });
  expect((await dbDown.inject('/healthz')).statusCode).toBe(200);
  expect((await dbDown.inject('/readyz')).statusCode).toBe(503);
});
