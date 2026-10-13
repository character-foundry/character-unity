import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const nativeEditorFiles = [
  'unity/**', 'lib/api.ts', 'lib/api.test.ts', 'lib/presets.ts', 'lib/presets.test.ts',
  'adapters/persistence/server-adapter.ts', 'adapters/persistence/types.ts',
  'features/editor/components/AssetsPanel.tsx', 'features/editor/components/EditPanelV2.tsx',
  'features/editor/components/DiffPanel.tsx', 'features/editor/components/LLMAssistSidebar.tsx',
  'features/wwwyzzerdd/WwwyzzerddTab.tsx', 'features/settings/panels/PresetsSettingsPanel.tsx',
  'modules/wwwyzzerdd/settings/WwwyzzerddSettings.tsx', 'store/card-store.ts', 'store/llm-store.ts', 'store/llm-store.test.ts',
  'features/editor/components/DynamicField.tsx',
];

export default [
  { ignores: ['**/dist/**', '**/runtime/**', '**/.wrangler/**', '**/worker-configuration.d.ts', '**/node_modules/**',
    // Remaining copied editor modules are cleaned incrementally; native Unity code is linted here.
    'packages/architect/src/**/*', '!packages/architect/src/**/',
    ...nativeEditorFiles.map((path) => `!packages/architect/src/${path}`), 'packages/architect-*/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  {
    files: ['apps/{architect,hub}/src/**/*.{ts,tsx}', 'packages/{api,ui,editor,assets,cards,archive-client,browser-storage}/src/**/*.{ts,tsx}', 'packages/architect/src/unity/**/*.{ts,tsx}', 'packages/blob-store/src/{index,verify,r2,maintenance}.ts', 'apps/api/src/worker.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['node:*', '@hono/node-server', '@hono/node-server/*', 'better-sqlite3', '@lancedb/*', '@character-unity/archive', '@character-unity/store/node', '@character-unity/blob-store/node', '@character-unity/blob-store/node-maintenance'], message: 'Keep local services and native drivers outside portable/browser modules.' },
        { group: ['**/apps/*/**'], message: 'Shared packages must not import application internals.' },
      ] }],
    },
  },
];
