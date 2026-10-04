import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // apps/web keeps `jsx: preserve` for Next; tests need the JSX compiled.
        oxc: { jsx: { runtime: 'automatic' } },
        test: {
          name: 'unit',
          include: [
            'packages/*/src/**/*.test.ts',
            'apps/*/src/**/*.test.ts',
            // The web has no src/: its server-component tests live next to the pages (BRT-10 Step 12).
            'apps/web/app/**/*.test.tsx',
          ],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/src/**/*.int.test.ts', 'apps/*/src/**/*.int.test.ts'],
          environment: 'node',
          globalSetup: ['./tooling/vitest.integration-setup.ts'],
          env: { BR_DATABASE_NAME: 'bragging_rights_test' },
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
