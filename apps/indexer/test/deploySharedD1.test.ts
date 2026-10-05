/**
 * #2409 — the shared-D1 Workers' deploy wrapper.
 *  - ONE applier (r4): the indexer's deploy applies; keeper/agent only verify.
 *  - Refuses every argument after the mode (r3 — deciding which spellings
 *    mean "do not publish" is unbounded).
 *  - Publishes only after VERIFYING every required migration is recorded,
 *    never on an exit status (r3 — a declined prompt exited 0).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM script, no type declarations.
import { admit, isSettled, unapplied } from '../scripts/deploy-shared-d1.mjs';

const pkg = (w: string) =>
  JSON.parse(readFileSync(new URL(`../../${w}/package.json`, import.meta.url), 'utf8')).scripts;

describe('deploy-shared-d1 — one applier', () => {
  it('only the indexer (the schema owner) applies; keeper and agent verify', () => {
    expect(pkg('indexer').deploy).toMatch(/deploy-shared-d1\.mjs apply$/);
    expect(pkg('keeper').deploy).toMatch(/deploy-shared-d1\.mjs verify$/);
    expect(pkg('agent').deploy).toMatch(/deploy-shared-d1\.mjs verify$/);
  });

  it('every shared-D1 Worker has a dry run that never touches the database', () => {
    for (const w of ['indexer', 'keeper', 'agent']) {
      expect(pkg(w)['deploy:dry']).toBe('wrangler deploy --dry-run');
    }
  });
});

describe('deploy-shared-d1 — admission', () => {
  it('runs with only its mode', () => {
    expect(admit(['apply'])).toEqual({ ok: true, mode: 'apply' });
    expect(admit(['verify'])).toEqual({ ok: true, mode: 'verify' });
  });

  it('refuses ANY argument after the mode, whatever its spelling', () => {
    for (const a of ['--dry-run', '--dry-run=true', '--version', '-v', '-h', '--env', 'staging']) {
      for (const mode of ['apply', 'verify']) {
        const r = admit([mode, a]);
        expect(r.ok).toBe(false);
        expect(r.message).toContain('deploy:dry');
      }
    }
  });

  it('refuses an unknown or missing mode', () => {
    expect(admit([]).ok).toBe(false);
    expect(admit(['--dry-run']).ok).toBe(false);
  });
});

describe('deploy-shared-d1 — verification', () => {
  const required = ['0001_a.sql', '0002_b.sql', '0003_c.sql'];
  const out = (names: string[]) =>
    JSON.stringify([{ results: names.map((name) => ({ name })), success: true }]);

  it('passes only when every required migration is recorded', () => {
    expect(unapplied(out(required), required)).toEqual([]);
  });

  it('names what is missing — e.g. after a declined or partial apply', () => {
    expect(unapplied(out(['0001_a.sql', '0003_c.sql']), required)).toEqual(['0002_b.sql']);
  });

  it('tolerates log text before the JSON', () => {
    expect(unapplied(`Resource location: remote\n${out(required)}`, required)).toEqual([]);
  });

  it('returns null — never "nothing missing" — for output it cannot read', () => {
    expect(unapplied('', required)).toBeNull();
    expect(unapplied('not json [ at all', required)).toBeNull();
    expect(unapplied(JSON.stringify({ error: 'x' }), required)).toBeNull();
  });
});

describe('deploy-shared-d1 — what counts as settled', () => {
  it('only a clean answer settles; an unreadable one (null) keeps waiting (r5)', () => {
    expect(isSettled([])).toBe(true);
    expect(isSettled(['0001_a.sql'])).toBe(false);
    expect(isSettled(null)).toBe(false);
  });
});
