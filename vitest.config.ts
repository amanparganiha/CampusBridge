import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'api-unit',
          root: './apps/api',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Real PostgreSQL via Testcontainers (requires Docker).
        test: {
          name: 'api-integration',
          root: './apps/api',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['./test/integration/setup/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      // Globs resolve against each project's root (e.g. apps/api), not the repo root.
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**'],
    },
  },
});
