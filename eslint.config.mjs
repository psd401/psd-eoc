import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      // Agent worktrees are checkouts of this repository. Linting into them
      // reports the same files twice, under a path nobody edits.
      '.claude/worktrees/**',
      '**/coverage/**',
      '**/dist/**',
      '**/drizzle/meta/**',
      'packages/server/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      '@next/next': nextPlugin,
    },
  },
  {
    files: [
      'eslint.config.mjs',
      'packages/server/**/*.{js,mjs,ts,tsx}',
      'packages/mcp/**/*.{js,mjs,ts,tsx}',
      'workers/**/*.{js,mjs,ts,tsx}',
      'infra/**/*.{js,mjs,ts,tsx}',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['packages/mobile/**/*.{js,mjs,ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ['packages/server/**/*.{js,mjs,ts,tsx}'],
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      '@next/next/no-html-link-for-pages': ['error', 'packages/server/app'],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
