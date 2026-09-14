import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    '**/coverage/',
    '.cache/',
    'apps/api/src/generated/',
    'infra/',
  ]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      // Fastify route plugins are `async (app) => { app.get(...) }` by convention, with no await.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },

  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  {
    // Tests may use non-null assertions to keep arrange/assert steps readable.
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  {
    // Operator CLIs and the seed report progress on stdout/stderr.
    files: ['apps/*/scripts/**/*.ts', 'apps/*/prisma/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  {
    // Tenant isolation boundary. Application code reaches the database only through TenantDb
    // (tenant-scoped, RLS-enforced). The cross-tenant system client is reserved for the worker's
    // relay and scanners (src/jobs), and the raw PrismaClient for the db layer itself.
    files: ['apps/api/src/**/*.ts'],
    ignores: [
      'apps/api/src/db/**',
      'apps/api/src/jobs/**',
      'apps/api/src/container.ts',
      'apps/api/src/worker.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/db/system-client*'],
              message: 'Cross-tenant access is reserved for src/jobs. Use TenantDb instead.',
            },
            {
              group: ['**/generated/prisma/client*'],
              importNames: ['PrismaClient'],
              message: 'Do not create or accept a raw PrismaClient here; depend on TenantDb.',
            },
          ],
        },
      ],
    },
  },

  prettier,
);
