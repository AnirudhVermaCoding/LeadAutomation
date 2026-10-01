import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['packages/*/src/**/*.test.ts'] } },
      {
        test: {
          name: 'api',
          include: ['apps/api/src/**/*.test.ts'],
          exclude: ['**/*.db.test.ts', '**/node_modules/**'],
        },
      },
      {
        // Needs Docker: one Postgres testcontainer per run, a cloned database per test file.
        test: {
          name: 'db',
          include: ['apps/api/src/**/*.db.test.ts'],
          globalSetup: ['apps/api/test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
