import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Read the actual append-only migration list, including its imported SQL arrays.
// Rehearsals must not silently keep asserting an old hardcoded version number.
const result = await build({ entryPoints: [fileURLToPath(new URL('../packages/store/src/schema.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', target: 'node24', write: false });
const { migrations } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
export const schemaVersion = migrations.at(-1).version;
