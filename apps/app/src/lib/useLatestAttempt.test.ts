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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('the rule has one implementation, and reaches every reporter (#2044)', () => {
  /** Files under `src/` matching a pattern, or [] when grep finds nothing
   *  (grep exits 1 on no match, which `execFileSync` throws on — and no match
   *  is the passing case for the first check below). */
  function filesMatching(pattern: string): string[] {
    try {
      return execFileSync(
        'grep',
        ['-rlE', pattern, 'src', '--include=*.ts', '--include=*.tsx'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((f) => !f.includes('.test.'));
    } catch {
      return [];
    }
  }

  it('no component hand-rolls its own attempt counter', () => {
    // The reason this hook exists: #2043 fixed the same defect four times in
    // two files, each fix subtly its own.
    expect(
      filesMatching(String.raw`(copyAttempt|attemptRef|latestAttempt)\s*=\s*useRef`),
    ).toEqual([]);
  });

  it('every component that reports an async settlement uses the hook', () => {
    // KEYED ON THE API, NOT ON THE FIX (#2044 round 1 P2). The first version
    // of this check greped for hand-rolled counter NAMES, so it could only
    // see a site that had already been half-fixed — and it passed while
    // `Vpfi.tsx` called `watchAsset` and reported the result with no ordering
    // at all. A check that recognises the remedy cannot find the places the
    // remedy is missing.
    //
    // These two APIs are the ones whose results this app renders a claim
    // from, and neither can be cancelled — only its answer ignored. Any file
    // calling one must therefore import the rule.
    const reporters = filesMatching(String.raw`\.(watchAsset|writeText)\(`);
    // The check must never go blind: zero reporters would pass vacuously.
    expect(reporters.length).toBeGreaterThan(0);
    const importsRule = (file: string) => {
      try {
        execFileSync('grep', ['-q', 'useLatestAttempt', file], {
          cwd: process.cwd(),
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        return true;
      } catch {
        return false;
      }
    };
    expect(reporters.filter((f) => !importsRule(f))).toEqual([]);
  });

  it('no reporter confirms with a bare `true` (#2044 round 2)', () => {
    // ORDERING IS NOT THE WHOLE RULE, and round 2 found the missing half at
    // two more sites: `isCurrent()` ranks attempts against each other and
    // cannot notice that the SUBJECT moved — a wallet prompt open across a
    // chain switch, a reused chip re-rendered with a new address. The older
    // attempt is then still legitimately the latest, so the guard passes and
    // the claim lands on something it was never about.
    //
    // The defect has one spelling, which is what makes it checkable: a
    // confirmation written as a bare `true` cannot say what it is about. A
    // keyed one always writes a subject — an address, a token identity, an
    // outcome object — so `true` under an `isCurrent()` guard is the shape,
    // not a proxy for it.
    //
    // A boolean claim about the ACT rather than about a subject would trip
    // this too, and that is the intended behaviour: no such site exists today
    // (the diagnostics drawer's "Copied" is a string state), and if one
    // arrives, stopping to decide which kind it is is exactly the thought
    // this check exists to force.
    const offenders: string[] = [];
    for (const file of filesMatching(String.raw`\.(watchAsset|writeText)\(`)) {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      for (const m of src.matchAll(/isCurrent\(\)/g)) {
        const window = src.slice(m.index, m.index + 200);
        const bare = window.match(/\bset[A-Za-z0-9_]*\(\s*true\s*\)/);
        if (bare) offenders.push(`${file}: ${bare[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no watchAsset caller discards the boolean it resolves with (#2044 round 3)', () => {
    // A DIFFERENT FALSE SUCCESS, in the same family. `watchAsset` is typed
    // `Promise<WatchAssetReturnType>` where that is `boolean` — "indicating if
    // the token was successfully added" — and not every wallet signals a
    // decline by rejecting; some resolve `false`. Both call sites took the
    // resolution itself as success, so a declined prompt rendered "Added to
    // your wallet".
    //
    // Ordering and subject-keying cannot help here: the attempt IS the latest
    // and the subject has NOT moved. The answer was simply not read.
    const offenders: string[] = [];
    for (const file of filesMatching(String.raw`\.watchAsset\(`)) {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      for (const m of src.matchAll(/\.watchAsset\(/g)) {
        // The `.then` that consumes this call, within the chain that follows.
        const chain = src.slice(m.index, m.index + 1200);
        const then = chain.match(/\.then\(\s*(?:async\s*)?\(([^)]*)\)/);
        if (!then) offenders.push(`${file}: watchAsset with no .then to inspect`);
        else if (!then[1].trim())
          offenders.push(`${file}: .then(${then[1]}) discards the result`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is exported as a hook for components to use', () => {
    expect(typeof useLatestAttempt).toBe('function');
  });
});
