import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['packages/*/src/**/*.test.ts'] } },
      { test: { name: 'api', include: ['apps/api/src/**/*.test.ts'] } },
    ],
  },
});
