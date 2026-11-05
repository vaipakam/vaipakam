/**
 * The Worker's ABI subset (`src/abiSubset.json`) against the two things it
 * must agree with.
 *
 * 1. The READERS: the subset lists exactly the views `EXPECTED_VIEWS`
 *    names, each under its own facet. A view missing from the subset would
 *    fail `assertAbiShape` at the first tick; an extra one would be dead
 *    weight in the bundle and a view nobody shape-checks.
 * 2. The COMPILER: every entry equals the function of that name in today's
 *    compiled facet ABI under `packages/contracts/src/abis/`. This is the
 *    same check `npm run abi:check` runs before a build or deploy; running
 *    it here puts it in the CI job that every facet re-export triggers.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import abiSubset from '../src/abiSubset.json';
import { WATCHED_VIEW_FACETS } from '../src/abi';

const abiFile = (facetFile: string): string =>
  fileURLToPath(new URL(`../../../packages/contracts/src/abis/${facetFile}.json`, import.meta.url));

type Entry = { type: string; name?: string };
const subset = abiSubset as unknown as Record<string, Entry[]>;

describe('abiSubset.json', () => {
  it('lists exactly the views the readers expect, each under its own facet', () => {
    const listed = Object.entries(subset)
      .flatMap(([facetFile, entries]) => entries.map((e) => `${facetFile}.${e.name}`))
      .sort();
    const expected = WATCHED_VIEW_FACETS.map((v) => `${v.facetFile}.${v.name}`).sort();
    expect(listed).toEqual(expected);
  });

  it('copies every view verbatim from the compiled facet ABI', () => {
    for (const [facetFile, entries] of Object.entries(subset)) {
      const compiled = JSON.parse(
        readFileSync(abiFile(facetFile), 'utf8'),
      ) as Entry[];
      for (const entry of entries) {
        const matches = compiled.filter((c) => c.type === 'function' && c.name === entry.name);
        expect(matches, `${facetFile}.${entry.name}`).toHaveLength(1);
        expect(entry, `${facetFile}.${entry.name} — run \`npm run abi:write\``).toEqual(matches[0]);
      }
    }
  });

  it('holds views only — no error or event entries', () => {
    for (const entries of Object.values(subset)) {
      for (const e of entries) expect(e.type).toBe('function');
    }
  });
});
