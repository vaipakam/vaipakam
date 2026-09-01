/**
 * Driven against `createLatestAttempt` — the real implementation the hook
 * wraps — rather than against a re-implementation. A test that rebuilds the
 * logic it is checking proves the test author's model and nothing about the
 * code, which is the vacuous-assertion trap #2043 spent a round on.
 *
 * `useLatestAttempt` itself is two lines of `useRef` and needs a renderer
 * this project does not have (`environment: 'node'`, no jsdom); the identity
 * stability it adds is asserted structurally in the source-placement check
 * below instead.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createLatestAttempt, useLatestAttempt } from './useLatestAttempt';

describe('createLatestAttempt — only the latest attempt may report', () => {
  it('lets a lone attempt report', () => {
    const only = createLatestAttempt().begin();
    expect(only.isCurrent()).toBe(true);
  });

  it('silences an older attempt once a newer one begins', () => {
    // The #2043 shape: two clipboard writes in flight, the older rejecting
    // last. Without ordering it overwrote a true "Copied." with "failed".
    const a = createLatestAttempt();
    const first = a.begin();
    const second = a.begin();
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  it('keeps only the newest current however many are in flight', () => {
    const a = createLatestAttempt();
    const tokens = [a.begin(), a.begin(), a.begin(), a.begin()];
    expect(tokens.map((t) => t.isCurrent())).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it('a superseded attempt stays superseded — isCurrent never recovers', () => {
    // Guards the obvious wrong implementation: comparing against a value that
    // could come back round (a boolean "busy" flag, or an id reused after a
    // reset). Once passed, an attempt is finished forever.
    const a = createLatestAttempt();
    const first = a.begin();
    a.begin();
    a.supersede();
    a.begin();
    expect(first.isCurrent()).toBe(false);
  });

  it('supersede() silences work in flight without starting an attempt', () => {
    // The mint-handler case: a new token is displayed and a settlement
    // belonging to the previous one must not label it. There is no new
    // attempt to begin — the reset itself has to invalidate.
    const a = createLatestAttempt();
    const inFlight = a.begin();
    a.supersede();
    expect(inFlight.isCurrent()).toBe(false);
    const next = a.begin();
    expect(next.isCurrent()).toBe(true);
  });

  it('ids are distinct and increasing, so rendered state can carry one', () => {
    // `Faucet` renders on `copyResult.attempt`, so two attempts must never
    // share an id — otherwise a stale result could match the live render.
    const a = createLatestAttempt();
    const ids = [a.begin().id, a.begin().id, a.begin().id];
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
  });

  it('instances are independent', () => {
    // Two components must not supersede each other. A module-level counter
    // would pass every case above and fail this one.
    const a = createLatestAttempt();
    const b = createLatestAttempt();
    const mine = a.begin();
    b.begin();
    b.begin();
    expect(mine.isCurrent()).toBe(true);
  });
});

describe('the rule has one implementation (#2044)', () => {
  it('no component hand-rolls its own attempt counter', () => {
    // The reason this hook exists: #2043 fixed the same defect four times in
    // two files, each fix subtly its own. A source check is the honest way to
    // pin "there is one of these" — the behavioural version cannot see how
    // many copies exist.
    // `grep` exits 1 on no match, which `execFileSync` throws on — and no
    // match is the PASSING case here, so the empty result has to be caught
    // rather than allowed to look like a broken test.
    let out = '';
    try {
      out = execFileSync(
        'grep',
        [
          '-rlE',
          String.raw`(copyAttempt|attemptRef|latestAttempt)\s*=\s*useRef`,
          'src',
          '--include=*.ts',
          '--include=*.tsx',
        ],
        { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      out = '';
    }
    const handRolled = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((f) => !f.includes('.test.'));
    expect(handRolled).toEqual([]);
  });

  it('is exported as a hook for components to use', () => {
    expect(typeof useLatestAttempt).toBe('function');
  });
});
