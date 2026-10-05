/**
 * #2409 — the shared-D1 Workers' deploy wrapper: refuses every argument
 * (r3 — deciding which spellings mean "do not publish" is unbounded), and
 * publishes only after VERIFYING every required migration is recorded,
 * rather than trusting the apply's exit status (r3 — a declined prompt
 * exited 0 having applied nothing).
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM script, no type declarations.
import { admit, unapplied } from '../scripts/migrate-then-deploy.mjs';

describe('migrate-then-deploy — admission', () => {
  it('runs with no arguments', () => {
    expect(admit([]).ok).toBe(true);
  });

  it('refuses ANY argument, whatever its spelling, and points at deploy:dry', () => {
    for (const a of ['--dry-run', '--dry-run=true', '--version', '-v', '-h', '--env', 'staging', '--keep-vars']) {
      const r = admit([a]);
      expect(r.ok).toBe(false);
      expect(r.message).toContain('deploy:dry');
    }
  });
});

describe('migrate-then-deploy — verification', () => {
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
