import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'infra/cdk.out/**', 'coverage/**', 'tests/load/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*analytics*', '*segment*', '*mixpanel*', '*amplitude*', '*google-analytics*', '*gtag*', '*posthog*'],
              message: 'No advertising or analytics SDKs (CLAUDE.md guardrail).',
            },
          ],
        },
      ],
    },
  },
);
