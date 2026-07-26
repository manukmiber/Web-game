import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ENGINE_DIR = fileURLToPath(new URL('.', import.meta.url));

function engineSources(dir = ENGINE_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...engineSources(path));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

function relative(path: string): string {
  return path.slice(ENGINE_DIR.length);
}

/**
 * These are the architectural constraints from ARCHITECTURE.md §2 and §9.5, enforced rather
 * than documented. They are the whole reason the engine is a separate directory:
 *
 * - The Phase 3 game runtime consumes `engine/` with no editor and no React.
 * - Chunk streaming and physics need to move into a Web Worker later, which is only possible
 *   if nothing in here reaches for `window` or `document` first.
 *
 * A violation is cheap to introduce and expensive to unpick months later, so it fails the
 * build the moment it appears.
 */
describe('engine boundary', () => {
  const files = engineSources();

  it('finds the engine sources', () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it('never imports the editor, React or the state library', () => {
    const forbidden = /from\s+['"](@editor\/|\.\.\/\.\.\/editor\/|react|react-dom|zustand)/;
    const offenders = files.filter((file) => forbidden.test(readFileSync(file, 'utf8')));

    expect(offenders.map(relative)).toEqual([]);
  });

  it('never touches the DOM, so it can run in a worker', () => {
    // Word-boundary matches on the globals themselves; `documentation` in a comment is fine.
    const forbidden = /\b(document|window|localStorage|navigator)\b\s*[.[]/;
    const offenders = files.filter((file) => {
      const source = readFileSync(file, 'utf8')
        // Strip comments so prose about the DOM doesn't trip the check.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      return forbidden.test(source);
    });

    expect(offenders.map(relative)).toEqual([]);
  });
});
