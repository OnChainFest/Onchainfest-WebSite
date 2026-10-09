import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      'apps/web/next-env.d.ts',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Module boundaries (ADR-0010): pure packages never import persistence or apps.
    files: [
      'packages/canonical/src/**',
      'packages/domain/src/**',
      'packages/authority/src/**',
      'packages/schemas/src/**',
    ],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['@br/persistence', '@br/testkit', 'pg', 'kysely', '../../apps/*'] },
      ],
    },
  },
);
