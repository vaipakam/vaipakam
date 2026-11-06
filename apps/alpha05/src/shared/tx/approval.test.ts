import { describe, expect, it } from 'vitest';
import { setAllowance, type AllowanceIo } from './approval';

type Hex = `0x${string}`;
const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

/** A token whose allowance moves only when a sent step "lands". */
function token(start: bigint, opts: { zeroFirst?: boolean; land?: (amount: bigint, i: number) => boolean; refuse?: number; unreadable?: number } = {}) {
  let allowance = start;
  let sent = 0;
  const prompts: bigint[] = [];
  const io: AllowanceIo = {
    read: async () => allowance,
    accepts: async (amount) => !(opts.zeroFirst && allowance !== 0n && amount !== 0n),
    send: async (amount) => {
      if (opts.refuse === sent) throw new Error('User rejected the request.');
      prompts.push(amount);
      const i = sent++;
      if (opts.land ? opts.land(amount, i) : true) allowance = amount;
      return H(i + 1);
    },
    wait: async (hash) => {
      if (opts.unreadable !== undefined && hash === H(opts.unreadable + 1)) throw new Error('timeout');
      return 1n;
    },
  };
  return {
    io,
    prompts,
    get allowance() {
      return allowance;
    },
  };
}

describe('setAllowance', () => {
  it('approves directly when the token accepts it, and judges the step by the allowance', async () => {
    const t = token(0n);
    expect(await setAllowance(t.io, 50n)).toEqual({ ok: true });
    expect(t.prompts).toEqual([50n]);
  });
  it('goes through zero only for a token that refuses a non-zero change', async () => {
    const plain = token(10n);
    await setAllowance(plain.io, 50n);
    expect(plain.prompts).toEqual([50n]);
    const strict = token(10n, { zeroFirst: true });
    expect(await setAllowance(strict.io, 50n)).toEqual({ ok: true });
    expect(strict.prompts).toEqual([0n, 50n]);
  });
  it('reports a cancelled or replaced step as not set, from the allowance, not the receipt', async () => {
    const t = token(50n, { land: () => false });
    expect(await setAllowance(t.io, 0n)).toMatchObject({ ok: false, why: 'not-set', sent: 1, now: 50n, pending: null });
  });
  it('keeps the hash of a step whose receipt could not be read and that has not landed yet', async () => {
    const t = token(50n, { land: () => false, unreadable: 0 });
    expect(await setAllowance(t.io, 0n)).toMatchObject({ ok: false, why: 'not-set', pending: H(1) });
    const landed = token(50n, { unreadable: 0 });
    expect(await setAllowance(landed.io, 0n)).toEqual({ ok: true });
  });
  it('says how far it got when the wallet refuses a later step', async () => {
    const t = token(10n, { zeroFirst: true, refuse: 1 });
    expect(await setAllowance(t.io, 50n)).toMatchObject({ ok: false, why: 'refused', sent: 1, now: 0n, last: 0n });
  });
  it('touches nothing when the allowance is not the value expected', async () => {
    const t = token(70n);
    expect(await setAllowance(t.io, 0n, 50n)).toMatchObject({ ok: false, why: 'changed', sent: 0, now: 70n });
    expect(t.prompts).toEqual([]);
  });
  it('names only a value this call set as one a clean-up may overwrite', async () => {
    // The step to zero lands; the second is replaced by an approval for a
    // different amount. `last` stays 0 while the allowance reads 7.
    let n = 0;
    const t = token(10n, { zeroFirst: true, land: () => n++ === 0 });
    const replaced: AllowanceIo = { ...t.io, read: async () => (n > 1 ? 7n : t.allowance) };
    const res = await setAllowance(replaced, 50n);
    expect(res).toMatchObject({ ok: false, why: 'not-set', sent: 2, now: 7n, last: 0n });
    const none = token(50n, { land: () => false });
    expect(await setAllowance(none.io, 0n)).toMatchObject({ last: null });
  });
});
