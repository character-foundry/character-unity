import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = dirname(fileURLToPath(import.meta.url));
const app = resolve(source, '..');
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  });
}

describe('native web application boundary', () => {
  it('keeps the browser development origin so existing IndexedDB libraries remain visible', () => {
    const manifest = JSON.parse(readFileSync(resolve(app, '../../package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(manifest.scripts['dev:browser']).toContain('VITE_UNITY_STORAGE=browser');
    expect(manifest.scripts['dev:browser']).toMatch(/--host 127\.0\.0\.1 --port 9310(?:\s|$)/);
  });

  it('does not depend on Next imports, framework directives, or replacement aliases', () => {
    const frameworkFiles = [...sources(source), join(app, 'vite.config.ts'), join(app, 'tsconfig.json')]
      .filter((path) => /(?:['"]next(?:\/|['"])|['"]use client['"]|shims\/next-)/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(app, path));
    expect(frameworkFiles).toEqual([]);
    for (const name of ['next-link.tsx', 'next-image.tsx', 'next-navigation.ts', 'sharp.ts']) {
      expect(existsSync(join(source, 'shims', name))).toBe(false);
    }
  });

  it('does not bring back unavailable CardsHub server endpoints', () => {
    const abandonedApiFiles = sources(source)
      .filter((path) => /\/api\/(?:cards|collections|users)(?:\/|['"`])/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(app, path));
    expect(abandonedApiFiles).toEqual([]);
  });
});
