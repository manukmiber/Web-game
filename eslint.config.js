import js from '@eslint/js';

/**
 * The load-bearing rule in this config is the `engine/**` import restriction.
 *
 * The core engine has to run in a headless game runtime (and eventually in a Web Worker),
 * so it may not reach into the editor UI layer, React, or the DOM. Everything else here is
 * ordinary linting; that one rule is what keeps the Phase 3 split a config change instead of
 * a rewrite. See ARCHITECTURE.md §2 and §9.5.
 */
export default [
  js.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      // Type-aware checks are handled by `tsc --noEmit`; ESLint here is for the boundary.
      'no-unused-vars': 'off',
      'no-undef': 'off',
    },
  },
  {
    files: ['src/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@editor/*', '**/editor/*', 'react', 'react-dom', 'zustand'],
              message:
                'engine/ must stay UI-free so the game runtime can use it without the editor. See ARCHITECTURE.md §2.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'window',
          message: 'engine/ must stay DOM-free so it can move into a Web Worker. See ARCHITECTURE.md §9.5.',
        },
        {
          name: 'document',
          message: 'engine/ must stay DOM-free so it can move into a Web Worker. See ARCHITECTURE.md §9.5.',
        },
      ],
    },
  },
];
