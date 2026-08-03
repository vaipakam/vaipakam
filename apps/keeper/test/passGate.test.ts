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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { isKeeperEnabled, passIsArmed } from '../src/keeper';

/** Only the fields the gate reads; the rest of `Env` is irrelevant here. */
function env(over: Partial<Env> = {}): Env {
  return {
    KEEPER_ENABLED: 'true',
    KEEPER_PRIVATE_KEY: '0xkey',
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
    // both bindings are unreadable secrets — so without this an operator
    // cannot tell which one to fix.
    const flagOff = env({ KEEPER_ENABLED: 'false' });
    const noKey = env({ KEEPER_PRIVATE_KEY: undefined });
    expect(isKeeperEnabled(flagOff)).toBe(false);
    expect(isKeeperEnabled(noKey)).toBe(false);

    passIsArmed(flagOff, 'p');
    passIsArmed(noKey, 'p');
    expect(lines).toEqual([
      '[keeper] p skipped: KEEPER_ENABLED not true (got "false")',
      '[keeper] p skipped: KEEPER_PRIVATE_KEY unset',
    ]);
  });

  it('echoes the raw value so a typo is visible rather than suspected', () => {
    // The failure modes named in #1475: a misspelling, wrong casing on a
    // flag that does not accept it, and a trailing newline — each of which
    // leaves the pass dark and looking healthy.
    for (const bad of ['ture', 'True', 'true\n', ' true', '']) {
      lines = [];
      const e = env({ REWARD_COMMIT_ENABLED: bad });
      expect(passIsArmed(e, 'commitmentReport', 'REWARD_COMMIT_ENABLED')).toBe(
        false,
      );
      expect(lines).toEqual([
        `[keeper] commitmentReport skipped: REWARD_COMMIT_ENABLED not true (got ${JSON.stringify(bad)})`,
      ]);
      // The quoting is the point: these are indistinguishable unquoted.
      expect(lines[0]).toContain(JSON.stringify(bad));
    }
  });

  it('never echoes the signing key', () => {
    const secret = '0xdeadbeefcafe';
    passIsArmed(env({ KEEPER_ENABLED: 'nope', KEEPER_PRIVATE_KEY: secret }), 'p');
    passIsArmed(env({ KEEPER_PRIVATE_KEY: undefined }), 'p');
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines[1]).toBe('[keeper] p skipped: KEEPER_PRIVATE_KEY unset');
  });

  it('stops at the first failing gate, so the line names one cause', () => {
    // Keeper-level gates are checked before the pass flag: a Worker with
    // neither set should be told to fix the keeper first, not handed two
    // lines to reconcile.
    const e = env({ KEEPER_ENABLED: undefined, REWARD_REMIT_ENABLED: 'ture' });
    expect(passIsArmed(e, 'rewardBudgetRemit', 'REWARD_REMIT_ENABLED')).toBe(
      false,
    );
    expect(lines).toEqual([
      '[keeper] rewardBudgetRemit skipped: KEEPER_ENABLED unset',
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
      for (const KEEPER_PRIVATE_KEY of [undefined, '0xkey']) {
        const e = env({ KEEPER_ENABLED, KEEPER_PRIVATE_KEY });
        lines = [];
        expect(passIsArmed(e, 'p')).toBe(isKeeperEnabled(e));
      }
    }
  });
});
