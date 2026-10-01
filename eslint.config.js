import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/node_modules/**', '**/dist/**', 'apps/api/drizzle/**', 'coverage/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Domain code takes time from an injected Clock so demos/tests can fast-forward.
    files: ['packages/core/src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/clock.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Use the injected Clock.',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'Use the injected Clock.',
        },
      ],
    },
  },
  {
    // systemDb bypasses RLS: only system/ code, scripts and tests may touch it.
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/system/**', '**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/system/db.ts'], message: 'systemDb bypasses RLS; use withTenant().' }] },
      ],
    },
  },
);
