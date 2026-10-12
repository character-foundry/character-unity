import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/dist/**', '**/runtime/**', '**/.wrangler/**', '**/worker-configuration.d.ts', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  {
    files: ['apps/{architect,hub}/src/**/*.{ts,tsx}', 'packages/{api,ui,editor,assets,cards,archive-client,browser-storage}/src/**/*.{ts,tsx}', 'packages/blob-store/src/{index,verify,r2,maintenance}.ts', 'apps/api/src/worker.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['node:*', '@hono/node-server', '@hono/node-server/*', 'better-sqlite3', '@lancedb/*', '@character-unity/archive', '@character-unity/store/node', '@character-unity/blob-store/node', '@character-unity/blob-store/node-maintenance'], message: 'Keep local services and native drivers outside portable/browser modules.' },
        { group: ['**/apps/*/**'], message: 'Shared packages must not import application internals.' },
      ] }],
    },
  },
];
