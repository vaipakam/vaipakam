/**
 * #3922 — the route words the service error record keeps (`src/routeWords.json`)
 * are exactly the words this Worker's own routing code names. Any other path
 * segment is recorded as a placeholder, so a missing word only makes a record
 * less specific; this test keeps the list from falling behind the routes.
 * Regenerate by writing the extracted list below into the JSON file.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractRouteWords, routePattern } from '@vaipakam/lib/serviceErrors';
import words from '../src/routeWords.json';

const SRC = join(__dirname, '..', 'src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(readFileSync(p, 'utf8'));
  }
  return out;
}

describe('route words (agent)', () => {
  it('match the words the routing code names', () => {
    expect(words).toEqual(extractRouteWords(sources(SRC)));
  });

  it('never let a caller-chosen segment through', () => {
    const set = new Set(words);
    expect(routePattern('/telegram/alice-smith', set)).toBe('/telegram/:x');
    expect(routePattern('/x/0x1234567890abcdef1234567890abcdef12345678', set)).toBe('/:x/:hex');
  });
});
