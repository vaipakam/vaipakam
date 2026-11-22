/**
 * #2409 — the shared-D1 Workers' deploy wrapper.
 *  - ONE applier (r4): the indexer's deploy applies; keeper/agent only verify.
 *  - Refuses every argument after the mode (r3 — deciding which spellings
 *    mean "do not publish" is unbounded).
 *  - The indexer publishes only after VERIFYING every required migration is
 *    recorded, never on an exit status (r3 — a declined prompt exited 0).
 *  - Keeper and agent read the record once and publish either way (#3115):
 *    a wait held the account's single build slot the indexer needed.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM script, no type declarations.
import { admit, isSettled, unapplied, verifyReport, waitsForSchema } from '../scripts/deploy-shared-d1.mjs';

const pkg = (w: string) =>
  JSON.parse(readFileSync(new URL(`../../${w}/package.json`, import.meta.url), 'utf8')).scripts;

describe('deploy-shared-d1 — one applier', () => {
  it('only the indexer (the schema owner) applies; keeper and agent verify', () => {
    expect(pkg('indexer').deploy).toMatch(/deploy-shared-d1\.mjs apply$/);
    expect(pkg('agent').deploy).toMatch(/deploy-shared-d1\.mjs verify$/);
    // #2450 — the keeper's deploy applies its PRIVATE schema (it is that
    // database's one applier) and hands the SHARED one to this script's
    // `verify` mode, never `apply`.
    expect(pkg('keeper').deploy).toBe('node scripts/deploy-keeper.mjs');
    const wrapper = readFileSync(new URL('../../keeper/scripts/deploy-keeper.mjs', import.meta.url), 'utf8');
    expect(wrapper).toMatch(/\[SHARED_DEPLOY, 'verify'\]/);
    expect(wrapper).not.toMatch(/SHARED_DEPLOY, 'apply'/);
    expect(wrapper).not.toMatch(/vaipakam-warm/);
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

describe('deploy-shared-d1 — when the verification waits', () => {
  it('the apply waits only after a failed apply (r7); verify mode never waits (#3115)', () => {
    expect(waitsForSchema(true)).toBe(false);
    // A concurrent indexer deploy may be part-way through the same
    // migrations: one re-read would abort while it finishes.
    expect(waitsForSchema(false)).toBe(true);
    // verify mode reads once and never reaches the wait: main() takes the
    // verify branch before any deadline exists.
    const src = readFileSync(new URL('../scripts/deploy-shared-d1.mjs', import.meta.url), 'utf8');
    const verifyBranch = src.slice(src.indexOf("if (gate.mode === 'verify')"), src.indexOf('} else {', src.indexOf("if (gate.mode === 'verify')")));
    expect(verifyBranch).toContain('verifyReport(readMissing(required))');
    expect(verifyBranch).not.toMatch(/sleep|deadline|fail\(|process\.exit/);
  });
});

describe('deploy-shared-d1 — what a verify deploy reports (#3115)', () => {
  it('says the schema is current only on a clean read', () => {
    expect(verifyReport([])).toEqual({
      level: 'ok',
      message: '[deploy] every migration this build carries is recorded',
    });
  });

  it('names the pending migrations and says the runtime gate holds scheduled work', () => {
    const r = verifyReport(['0084_a.sql', '0085_b.sql']);
    expect(r.level).toBe('warn');
    expect(r.message).toContain('0084_a.sql, 0085_b.sql');
    expect(r.message).toContain('d1SchemaGate');
    expect(r.message).toContain('pnpm --filter @vaipakam/indexer run deploy');
  });

  it('reports an unreadable record as UNKNOWN, never as current', () => {
    const r = verifyReport(null);
    expect(r.level).toBe('warn');
    expect(r.message).toContain('UNKNOWN');
    expect(r.message).not.toContain('every migration this build carries is recorded');
  });
});
