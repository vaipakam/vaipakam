/**
 * The Worker's ABI subset (`src/abiSubset.json`) against the two things it
 * must agree with.
 *
 * 1. The READERS: the subset lists exactly the views `EXPECTED_VIEWS`
 *    names, plus the events and the one view the event-alert pass
 *    (`src/eventAlerts.ts`) reads, each under its own ABI file. A view missing from the subset would
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
import { eventAbiProblems, WATCHED_EVENT_ENTRIES } from '../src/eventAlerts';

const abiFile = (facetFile: string): string =>
  fileURLToPath(new URL(`../../../packages/contracts/src/abis/${facetFile}.json`, import.meta.url));

type Entry = { type: string; name?: string };
const subset = abiSubset as unknown as Record<string, Entry[]>;

describe('abiSubset.json', () => {
  it('lists exactly the views the readers expect, each under its own facet', () => {
    const listed = Object.entries(subset)
      .flatMap(([facetFile, entries]) => entries.map((e) => `${facetFile}.${e.type}:${e.name}`))
      .sort();
    const expected = [
      ...WATCHED_VIEW_FACETS.map((v) => `${v.facetFile}.function:${v.name}`),
      ...WATCHED_EVENT_ENTRIES.map((e) => `${e.facetFile}.${e.type}:${e.name}`),
    ].sort();
    expect(listed).toEqual(expected);
  });

  it('copies every entry verbatim from the compiled ABI', () => {
    for (const [facetFile, entries] of Object.entries(subset)) {
      const compiled = JSON.parse(
        readFileSync(abiFile(facetFile), 'utf8'),
      ) as Entry[];
      for (const entry of entries) {
        const matches = compiled.filter((c) => c.type === entry.type && c.name === entry.name);
        expect(matches, `${facetFile}.${entry.type}:${entry.name}`).toHaveLength(1);
        expect(entry, `${facetFile}.${entry.name} — run \`npm run abi:write\``).toEqual(matches[0]);
      }
    }
  });

  it('holds views and events only — no error entries', () => {
    for (const entries of Object.values(subset)) {
      for (const e of entries) expect(['function', 'event']).toContain(e.type);
    }
  });

  it('matches the input shape every event-alert rule was written against', () => {
    expect(eventAbiProblems()).toEqual([]);
  });

  it('refuses an event whose inputs moved', () => {
    const drifted = JSON.parse(JSON.stringify(subset)) as Record<string, Entry[]>;
    const ev = drifted.SanctionsList!.find((e) => e.type === 'event' && e.name === 'ListUpdated') as unknown as {
      inputs: { name: string }[];
    };
    [ev.inputs[3], ev.inputs[4]] = [ev.inputs[4]!, ev.inputs[3]!]; // swap added / removed
    expect(eventAbiProblems(drifted as never)).toEqual([
      expect.stringContaining('SanctionsList.ListUpdated: inputs are'),
    ]);
  });
});
