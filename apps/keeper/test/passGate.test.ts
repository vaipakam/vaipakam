/**
 * Pass arming is observable (#1475).
 *
 * The property under test is not "the gate returns the right boolean" — it
 * already did. It is that **every outcome emits a line naming its cause**.
 * Before this, an armed pass with nothing to do and a pass whose flag read
 * false both produced silence, and since the arming flags are `secret_text`
 * bindings whose values cannot be read back, silence meant a misconfigured
 * flag was undetectable by any means.
 *
 * So each case asserts the emitted text, not just the return value: a test
 * that only checked the boolean would pass against the silent version this
 * replaces, which is exactly the bug.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { isKeeperEnabled, passIsArmed } from '../src/keeper';

/** Only the fields the gate reads; the rest of `Env` is irrelevant here. */
function env(over: Partial<Env> = {}): Env {
  return {
    KEEPER_ENABLED: 'true',
    KEEPER_PRIVATE_KEY: `0x${'a'.repeat(64)}`,
    ...over,
  } as Env;
}

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('passIsArmed — an armed pass announces itself', () => {
  it('reports an unset pass flag rather than staying silent', () => {
    // The default env has the keeper armed but no pass flag — the case that
    // used to be indistinguishable from "ran, found nothing".
    expect(passIsArmed(env(), 'remitAck', 'REWARD_REMIT_ENABLED')).toBe(false);
    expect(lines).toEqual([
      '[keeper] remitAck skipped: REWARD_REMIT_ENABLED unset',
    ]);
  });

  it('logs a start line once the pass flag is on', () => {
    const on = env({ REWARD_REMIT_ENABLED: 'true' });
    expect(passIsArmed(on, 'remitAck', 'REWARD_REMIT_ENABLED')).toBe(true);
    expect(lines).toEqual(['[keeper] remitAck start']);
  });

  it('accepts a pass with no arming flag of its own', () => {
    expect(passIsArmed(env(), 'autoLifecycle')).toBe(true);
    expect(lines).toEqual(['[keeper] autoLifecycle start']);
  });
});

describe('passIsArmed — a skipped pass names the binding that stopped it', () => {
  it('distinguishes an unset keeper flag from a false one', () => {
    passIsArmed(env({ KEEPER_ENABLED: undefined }), 'p');
    expect(lines).toEqual(['[keeper] p skipped: KEEPER_ENABLED unset']);
  });

  it('separates the two causes isKeeperEnabled collapses', () => {
    // Both make `isKeeperEnabled` false; only the log tells them apart, and
    // both bindings are unreadable — so without this an operator cannot tell
    // which one to fix.
    const flagOff = env({ KEEPER_ENABLED: 'false' });
    const noKey = env({ KEEPER_PRIVATE_KEY: undefined });
    expect(isKeeperEnabled(flagOff)).toBe(false);
    expect(isKeeperEnabled(noKey)).toBe(false);

    passIsArmed(flagOff, 'p');
    passIsArmed(noKey, 'p');
    expect(lines).toEqual([
      '[keeper] p skipped: KEEPER_ENABLED off (explicitly disabled)',
      '[keeper] p skipped: KEEPER_PRIVATE_KEY unset',
    ]);
  });

  it('reports a deliberate kill-switch as OFF, not as a typo', () => {
    // `false` is the documented way to disable the keeper. Calling that
    // `unrecognised (5 chars)` told an operator their intentional shutdown
    // looked like a mistake — during a shutdown, which is when a spurious
    // configuration warning is most expensive.
    for (const off of ['false', 'False', 'FALSE', '0']) {
      lines = [];
      passIsArmed(env({ KEEPER_ENABLED: off }), 'liquidator');
      expect(lines).toEqual([
        '[keeper] liquidator skipped: KEEPER_ENABLED off (explicitly disabled)',
      ]);
    }
    // Same for a pass flag, which is also routinely left deliberately off.
    lines = [];
    passIsArmed(env({ REWARD_REMIT_ENABLED: 'false' }), 'remitAck', 'REWARD_REMIT_ENABLED');
    expect(lines).toEqual([
      '[keeper] remitAck skipped: REWARD_REMIT_ENABLED off (explicitly disabled)',
    ]);
  });

  it('still refuses to arm on an off value', () => {
    // The classification is a label, never a decision.
    expect(isKeeperEnabled(env({ KEEPER_ENABLED: 'false' }))).toBe(false);
    expect(
      passIsArmed(env({ REWARD_REMIT_ENABLED: '0' }), 'p', 'REWARD_REMIT_ENABLED'),
    ).toBe(false);
  });

  it('distinguishes a deliberate off from a mistyped one', () => {
    lines = [];
    passIsArmed(env({ KEEPER_ENABLED: ' false ' }), 'p');
    passIsArmed(env({ KEEPER_ENABLED: 'flase' }), 'p');
    expect(lines).toEqual([
      '[keeper] p skipped: KEEPER_ENABLED off (explicitly disabled), with surrounding whitespace',
      '[keeper] p skipped: KEEPER_ENABLED unrecognised (5 chars)',
    ]);
  });

  it('reports BOTH keeper-level causes when both apply', () => {
    // Sequentially they would cost two ticks to discover.
    passIsArmed(env({ KEEPER_ENABLED: undefined, KEEPER_PRIVATE_KEY: undefined }), 'p');
    expect(lines).toEqual([
      '[keeper] p skipped: KEEPER_ENABLED unset; KEEPER_PRIVATE_KEY unset',
    ]);
  });

  it('names the FORM of each failure mode without echoing the value', () => {
    // The failure modes named in #1475, each classified rather than quoted.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['ture', 'unrecognised (4 chars)'],
      ['True', 'wrong case — these flags require lowercase `true`'],
      ['true\n', 'has surrounding whitespace (otherwise correct — re-enter without it)'],
      [' true', 'has surrounding whitespace (otherwise correct — re-enter without it)'],
      ['', 'empty'],
      [' ture ', 'has surrounding whitespace and is unrecognised (6 chars)'],
    ];
    for (const [bad, expected] of cases) {
      lines = [];
      const e = env({ REWARD_COMMIT_ENABLED: bad });
      expect(passIsArmed(e, 'commitmentReport', 'REWARD_COMMIT_ENABLED')).toBe(
        false,
      );
      expect(lines).toEqual([
        `[keeper] commitmentReport skipped: REWARD_COMMIT_ENABLED ${expected}`,
      ]);
    }
  });

  it('never writes a flag value into the log', () => {
    // These bindings are `secret_text` on the live Worker, and the case this
    // diagnostic exists for is the value being wrong — which is exactly how
    // a pasted credential arrives. Echoing it would defeat the no-readback
    // protection precisely when it matters.
    const pasted = 'sk-live-4f8a2c9e1b7d6a3f0e5c8b2d9a4f7e1c';
    for (const e of [
      env({ KEEPER_ENABLED: pasted }),
      env({ REWARD_REMIT_ENABLED: pasted }),
    ]) {
      lines = [];
      passIsArmed(e, 'p', 'REWARD_REMIT_ENABLED');
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain(pasted);
      // Still diagnostic: the length says "you pasted something long here".
      expect(lines[0]).toContain(`(${pasted.length} chars)`);
    }
  });

  it('reports a malformed signing key instead of claiming the pass is armed', () => {
    // A non-empty but unusable key used to pass the gate: every gated pass
    // logged `start`, then produced nothing when `buildKeeperContext`
    // rejected it per chain. The one-tick diagnosis reported the healthy
    // state for a broken key, which is the worst direction to be wrong in.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['0xabc', 'malformed (5 chars, expected 66)'],
      ['a'.repeat(63), 'malformed (65 chars, expected 66)'],
      ['0x' + 'z'.repeat(64), 'malformed (not hexadecimal)'],
      // Right length, right alphabet, still not a scalar on the curve —
      // zero and values at/above the secp256k1 order. A syntax-only check
      // passed these and the pass then announced `start` before viem threw.
      ['0x' + '0'.repeat(64), 'malformed (not a valid signing key)'],
      ['0x' + 'f'.repeat(64), 'malformed (not a valid signing key)'],
    ];
    for (const [key, expected] of cases) {
      lines = [];
      expect(passIsArmed(env({ KEEPER_PRIVATE_KEY: key }), 'liquidator')).toBe(
        false,
      );
      expect(lines).toEqual([
        `[keeper] liquidator skipped: KEEPER_PRIVATE_KEY ${expected}`,
      ]);
      expect(lines[0]).not.toContain(key);
    }
  });

  it('accepts a well-formed key with or without the 0x prefix', () => {
    for (const key of [
      '0x' + 'a'.repeat(64),
      'a'.repeat(64),
      ' 0x' + 'A'.repeat(64) + ' ',
    ]) {
      lines = [];
      expect(passIsArmed(env({ KEEPER_PRIVATE_KEY: key }), 'liquidator')).toBe(
        true,
      );
      expect(lines).toEqual(['[keeper] liquidator start']);
    }
  });

  it('never echoes the signing key', () => {
    const secret = '0xdead' + 'b'.repeat(60);
    passIsArmed(env({ KEEPER_ENABLED: 'nope', KEEPER_PRIVATE_KEY: secret }), 'p');
    passIsArmed(env({ KEEPER_PRIVATE_KEY: undefined }), 'p');
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines[1]).toBe('[keeper] p skipped: KEEPER_PRIVATE_KEY unset');
  });

  it('names every applicable blocker on the one line', () => {
    // An earlier version stopped at the first, which meant fixing one
    // binding and waiting a tick to discover the next — not what a
    // single-cycle diagnosis is worth having for.
    const e = env({ KEEPER_ENABLED: undefined, REWARD_REMIT_ENABLED: 'ture' });
    expect(passIsArmed(e, 'rewardBudgetRemit', 'REWARD_REMIT_ENABLED')).toBe(
      false,
    );
    expect(lines).toEqual([
      '[keeper] rewardBudgetRemit skipped: KEEPER_ENABLED unset; ' +
        'REWARD_REMIT_ENABLED unrecognised (4 chars)',
    ]);
  });

  it('names all three when the keeper and the pass flag are all wrong', () => {
    const e = env({
      KEEPER_ENABLED: undefined,
      KEEPER_PRIVATE_KEY: undefined,
      REWARD_REMIT_ENABLED: 'True',
    });
    passIsArmed(e, 'remitAck', 'REWARD_REMIT_ENABLED');
    expect(lines).toEqual([
      '[keeper] remitAck skipped: KEEPER_ENABLED unset; ' +
        'KEEPER_PRIVATE_KEY unset; ' +
        'REWARD_REMIT_ENABLED wrong case — these flags require lowercase `true`',
    ]);
  });
});

describe('isKeeperEnabled — unchanged, and tied to the reason', () => {
  it('accepts the documented truthy spellings', () => {
    for (const v of ['true', 'TRUE', 'True', '1']) {
      expect(isKeeperEnabled(env({ KEEPER_ENABLED: v }))).toBe(true);
    }
  });

  it('rejects everything else, including a key-less true', () => {
    expect(isKeeperEnabled(env({ KEEPER_ENABLED: 'yes' }))).toBe(false);
    expect(isKeeperEnabled(env({ KEEPER_ENABLED: '' }))).toBe(false);
    expect(isKeeperEnabled(env({ KEEPER_PRIVATE_KEY: undefined }))).toBe(false);
  });

  it('agrees with passIsArmed on every keeper-level input', () => {
    // The delegation is the guarantee that the boolean and the reason cannot
    // drift; this pins it rather than trusting the one-line body to stay.
    for (const KEEPER_ENABLED of [undefined, '', 'true', 'True', '1', 'ture']) {
      for (const KEEPER_PRIVATE_KEY of [undefined, `0x${'a'.repeat(64)}`]) {
        const e = env({ KEEPER_ENABLED, KEEPER_PRIVATE_KEY });
        lines = [];
        expect(passIsArmed(e, 'p')).toBe(isKeeperEnabled(e));
      }
    }
  });
});

describe('the key is constructed in exactly one place', () => {
  const srcDir = new URL('../src/', import.meta.url);
  const srcFiles = () =>
    readdirSync(srcDir).filter((f) => f.endsWith('.ts'));

  /** Every `privateKeyToAccount(` CALL in src/, as `file:line`. The import
   *  and the prose references lack the paren and are not calls. */
  function constructionSites(): string[] {
    return srcFiles()
      .flatMap((f) =>
        readFileSync(new URL(f, srcDir), 'utf8')
          .split('\n')
          .map((line, i) => ({ line, n: i + 1 }))
          .filter(({ line }) => line.includes('privateKeyToAccount('))
          .map(({ n }) => `${f}:${n}`),
      )
      .sort();
  }

  it('only keeper.ts can reach viem/accounts, and unaliased', () => {
    // Scanning for the call TEXT is only sound if the spelling is pinned.
    // `import { privateKeyToAccount as makeAccount }`, or a namespace
    // import, would let a new construction sit outside the protected try
    // while the call-text scan below still saw one site (#1540 r10).
    //
    // Pinning the IMPORT closes that at the source: you cannot call what
    // you have not imported, so no alias and no namespace form can appear
    // in another module, and inside keeper.ts the local name is fixed.
    const importers = srcFiles().filter((f) =>
      readFileSync(new URL(f, srcDir), 'utf8').includes('viem/accounts'),
    );
    expect(importers).toEqual(['keeper.ts']);

    // EVERY matching declaration, not the first one found (#1540 r11).
    // `.find` validated only the existing import, so an ADDITIVE second
    // declaration — `import { privateKeyToAccount as makeAccount } …` — kept
    // `importers` at ['keeper.ts'] and left the original spelling intact for
    // the call scan, reopening the path. Asserting over a sample instead of
    // the whole set is the same mistake in miniature.
    const src = readFileSync(new URL('keeper.ts', srcDir), 'utf8');
    const decls = src.split('\n').filter((l) => l.includes('viem/accounts'));
    expect(decls).toHaveLength(1);
    const [line] = decls;
    // Named, unaliased, no `* as`.
    expect(line).not.toMatch(/\*\s+as\s/);
    expect(line).not.toMatch(/privateKeyToAccount\s+as\s/);
    expect(line).toMatch(/\bprivateKeyToAccount\b/);
  });

  it('there is exactly ONE construction site, and it is the resolver', () => {
    // The leak this pins (#1540 r6): `dailyOracleSnapshot` had its own copy
    // of normalise-and-check and built the account OUTSIDE a try, so an
    // invalid scalar threw and `index.ts` logged the error — and viem's
    // message for that case contains the rejected scalar, from which the
    // key is recoverable.
    //
    // The first version of this test excluded `keeper.ts` and so enforced
    // "no call outside keeper.ts" — a second construction added INSIDE that
    // file would have passed while the README and release note claim a
    // single site (#1540 r7). Count everywhere instead.
    const sites = constructionSites();
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatch(/^keeper\.ts:\d+$/);
  });

  it('that site is inside the resolver\'s try/catch, not merely in the file', () => {
    // Three properties, each strictly stronger than the last, and each
    // added because the previous one let the real bug through:
    //
    //   1. not in another module      — `dailyOracleSnapshot` had a copy;
    //   2. inside `resolveKeeperAccount` — being in the right file is not it;
    //   3. inside its `try` block     — THIS one. A call moved above the
    //      `try` while staying in the function satisfies (1) and (2), and
    //      viem's error escapes to be logged with the key in it. That is
    //      not hypothetical: construction-outside-the-try is exactly what
    //      `dailyOracleSnapshot` did (#1540 r6/r8).
    const src = readFileSync(new URL('../src/keeper.ts', import.meta.url), 'utf8');
    const from = src.indexOf('export function resolveKeeperAccount');
    expect(from).toBeGreaterThan(-1);
    const body = src.slice(from, src.indexOf('\n}\n', from));

    const tryAt = body.indexOf('try {');
    const catchAt = body.indexOf('} catch', tryAt);
    expect(tryAt).toBeGreaterThan(-1);
    expect(catchAt).toBeGreaterThan(tryAt);
    const guarded = body.slice(tryAt, catchAt);

    expect(guarded).toContain('privateKeyToAccount(');
    // ...and nowhere else at all — not elsewhere in the resolver, not
    // elsewhere in the file.
    const unguarded =
      src.slice(0, from) +
      body.slice(0, tryAt) +
      body.slice(catchAt) +
      src.slice(from + body.length);
    expect(unguarded).not.toContain('privateKeyToAccount(');
  });

  it('the catch binds no error and returns exactly the bounded literal', () => {
    // Wrapping the call only protects if what comes OUT of the catch is
    // bounded. Checking that the literal merely OCCURS is not enough:
    //   catch (err) { return { problem: '…not a valid signing key' + String(err) } }
    // contains the literal, calls no logger and throws nothing — and both
    // `passIsArmed` and `dailyOracleSnapshot` then log `resolved.problem`,
    // restoring the exact disclosure this test exists to prevent (#1540 r9).
    //
    // So: the catch takes NO binding — with no `err` in scope there is
    // nothing to interpolate — and its return is the literal and nothing
    // else.
    const src = readFileSync(new URL('../src/keeper.ts', import.meta.url), 'utf8');
    const from = src.indexOf('export function resolveKeeperAccount');
    const body = src.slice(from, src.indexOf('\n}\n', from));
    const tail = body.slice(body.indexOf('} catch'));

    expect(tail).toMatch(/^\} catch \{/);
    expect(tail).not.toMatch(/\} catch\s*\(/);
    expect(tail).not.toMatch(/console\.(log|warn|error)/);
    expect(tail).not.toMatch(/\bthrow\b/);

    // Exactly one return, and it is the bounded literal — no concatenation,
    // no interpolation, no second field.
    const returns = tail.match(/return[^;]*;/g) ?? [];
    expect(returns).toEqual([
      "return { problem: 'malformed (not a valid signing key)' };",
    ]);
  });
});
