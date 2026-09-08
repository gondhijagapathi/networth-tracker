import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/build/**', '**/coverage/**', 'data/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // Money is handled as integer paise. Guard against float drift creeping in.
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'Money is integer paise — use the helpers in @networth/shared/money.',
        },
      ],
    },
  },
  /*
   * The two files in this repository that are not TypeScript.
   *
   * `typescript-eslint` turns `no-undef` off for TS because the compiler already answers
   * that question better than a linter can; plain JavaScript gets it back, and then needs to
   * be told which globals its runtime actually has. A service worker runs in neither the
   * window nor Node, so it is listed on its own rather than lumped in with the browser.
   */
  {
    files: ['apps/web/public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { Buffer: 'readonly', process: 'readonly' },
    },
  },
  prettier,
);
