import { expect, test } from 'vitest';
import { loadEnv } from './env.ts';

test('env errors name the bad variable', () => {
  expect(() => loadEnv({ DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  expect(loadEnv({ DATABASE_URL: 'postgres://u:p@h/db' }).PORT).toBe(3000);
});
