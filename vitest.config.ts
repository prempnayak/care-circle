import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts'],
      exclude: ['**/*.test.ts', 'packages/core/src/index.ts'],
      thresholds: { lines: 80, statements: 80 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/**/src/**/*.test.ts', 'apps/**/server/**/*.test.ts', 'tests/voice/**/*.test.ts'],
          globalSetup: ['tests/support/dynamo-global-setup.ts'],
          testTimeout: 20_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'contract',
          include: ['tests/contract/**/*.test.ts'],
          globalSetup: ['tests/support/dynamo-global-setup.ts'],
          testTimeout: 30_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
