// Flat config. Type-aware rules + directory import boundaries (core, main, preload, renderer, shared, cli).
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

const childProcessBan = {
  paths: [
    { name: 'child_process', message: 'Only src/core/proc/** may spawn processes.' },
    { name: 'node:child_process', message: 'Only src/core/proc/** may spawn processes.' },
  ],
}

/** @param {string[]} patterns @param {string} message */
const ban = (patterns, message) => ({ group: patterns, message })

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      'out/',
      'dist/',
      'coverage/',
      'docs/',
      'tests/.bin/',
      'tests/fixtures/',
      'src/core/adapters/*/protocol/**',
      'pnpm-lock.yaml',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  // ---- import boundaries -------------------------------------------------
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...childProcessBan,
          patterns: [
            ban(['node:*', 'fs', 'path', 'os', 'crypto'], 'src/shared must not import Node built-ins.'),
            ban(['electron', 'react', 'react-dom'], 'src/shared must stay host-agnostic.'),
            ban(
              ['@core/*', '@main/*', '@renderer/*', '../core/*', '../main/*', '../renderer/*'],
              'src/shared must not import other layers.',
            ),
          ],
        },
      ],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    ignores: ['src/core/proc/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...childProcessBan,
          patterns: [
            ban(['electron', 'react', 'react-dom'], 'src/core is pure Node.'),
            ban(['@main/*', '@renderer/*'], 'src/core must not import host layers.'),
          ],
        },
      ],
    },
  },
  {
    files: ['src/core/proc/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ban(['electron', 'react', 'react-dom', '@main/*', '@renderer/*'], 'src/core is pure Node.'),
          ],
        },
      ],
    },
  },
  {
    files: ['src/cli/**/*.ts', 'src/dev/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...childProcessBan,
          patterns: [ban(['electron', '@main/*', '@renderer/*'], 'CLI must not import Electron layers.')],
        },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...childProcessBan,
          patterns: [
            ban(['node:*', 'fs', 'path', 'os'], 'The renderer has no Node access.'),
            ban(
              ['electron', '@core/*', '@main/*', '**/core/*', '**/main/*', '**/preload/*'],
              'The renderer talks to main only through window.harpoon.',
            ),
          ],
        },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'tests/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...childProcessBan,
          patterns: [
            ban(['react', 'react-dom', '@renderer/*'], 'Main and preload never import the renderer.'),
          ],
        },
      ],
    },
  },
)
