/**
 * The settlement both write-capable live drivers end on (#2505). What is
 * pinned: its ORDER (browser closed, ledgers judged, facts re-read, nonce
 * read last), the three nonce readings, the whole-record comparison, and the
 * one rule that turns a settled run into a verdict input.
 */
import { describe, expect, it } from 'vitest';
import { Suspect, changedFields, nonceBaseline, reconcileNonce, resolveSettlement, settleRun } from './noWriteSettlement.mjs';

const W = '0x00000000000000000000000000000000000000aa';
const pubWith = (pending, latest = pending) => ({
  getTransactionCount: async ({ blockTag }) => {
    if (pending instanceof Error) throw pending;
    return blockTag === 'pending' ? pending : latest;
  },
});

describe('nonceBaseline', () => {
  it('refuses a wallet with a pending transaction', async () => {
    expect((await nonceBaseline(pubWith(5, 4), W)).blocked).toMatch(/1 transaction\(s\) pending/);
    expect(await nonceBaseline(pubWith(5), W)).toEqual({ nonce: 5 });
  });
});

describe('reconcileNonce', () => {
  it('proves no send only on an unchanged count', async () => {
    expect(await reconcileNonce(pubWith(7), W, 7)).toEqual({ kind: 'unchanged' });
    expect(await reconcileNonce(pubWith(8), W, 7)).toEqual({ kind: 'escaped', from: 7, to: 8 });
    expect((await reconcileNonce(pubWith(6), W, 7)).kind).toBe('unknown');
    expect((await reconcileNonce(pubWith(new Error('down')), W, 7)).kind).toBe('unknown');
  });
});

describe('changedFields', () => {
  it('names every field that changed, addresses case-blind', () => {
    const before = { status: 0, collateralAmount: 10n, lender: '0xAbC' };
    expect(changedFields(before, { status: 0, collateralAmount: 10n, lender: '0xabc' })).toEqual([]);
    expect(changedFields(before, { status: 0, collateralAmount: 12n, lender: '0xabc' })).toEqual(['collateralAmount']);
    expect(changedFields([1n, false], [1n, true])).toEqual(['1']);
  });
});

describe('settleRun', () => {
  it('closes the browser, judges the ledgers, re-reads the facts, and reads the nonce last', async () => {
    const order = [];
    const pub = {
      getTransactionCount: async () => {
        order.push('nonce');
        return 3;
      },
    };
    const out = await settleRun({
      closeBrowser: async () => order.push('close'),
      judgeLedgers: () => order.push('ledgers'),
      wrotePlan: () => false,
      factsNow: async () => {
        order.push('facts');
        return {};
      },
      pub,
      wallet: W,
      baseline: 3,
    });
    expect(order).toEqual(['close', 'ledgers', 'facts', 'nonce']);
    expect(out).toEqual({ plan: false, facts: {}, nonce: { kind: 'unchanged' } });
  });

  it('stops after the ledgers when the plan sent', async () => {
    const order = [];
    const out = await settleRun({
      closeBrowser: async () => order.push('close'),
      judgeLedgers: () => order.push('ledgers'),
      wrotePlan: () => true,
      factsNow: async () => order.push('facts'),
      pub: pubWith(0),
      wallet: W,
      baseline: 0,
    });
    expect(order).toEqual(['close', 'ledgers']);
    expect(out).toEqual({ plan: true });
  });

  it('still judges and reads the nonce when the browser fails to close', async () => {
    const out = await settleRun({
      closeBrowser: async () => {
        throw new Error('gone');
      },
      judgeLedgers: () => {},
      wrotePlan: () => false,
      factsNow: async () => ({}),
      pub: pubWith(4),
      wallet: W,
      baseline: 3,
    });
    expect(out.nonce.kind).toBe('escaped');
  });
});

describe('resolveSettlement', () => {
  const unchanged = (facts = {}) => ({ plan: false, facts, nonce: { kind: 'unchanged' } });
  const base = { held: null, stopped: null, suspect: null, findings: 0, subject: 'loan 1' };

  it('is BLOCKED for a hold on a provably write-free run', () => {
    expect(resolveSettlement({ ...base, settled: unchanged(), held: 'underfunded' }).blocked).toMatch(/^underfunded; this wallet's nonce shows no transaction/);
  });

  it('is BLOCKED for a stop or a suspect the facts may explain, with the order unknown', () => {
    const r = resolveSettlement({ ...base, settled: unchanged({ moved: 'status 2' }), stopped: 'wait ran out' });
    expect(r.blocked).toMatch(/the drive stopped \(wait ran out\), and loan 1 moved by the verdict \(status 2\); which came first is unknown/);
    const s = new Suspect('row missing', { row: 'r', key: 'k', label: 'l' });
    expect(resolveSettlement({ ...base, settled: unchanged({ unknown: 'rpc down' }), suspect: s }).blocked).toMatch(/could not be re-read/);
  });

  it('records a suspect as a failure when nothing moved', () => {
    const s = new Suspect('row missing', { row: 'r', key: 'k', label: 'l' });
    expect(resolveSettlement({ ...base, settled: unchanged(), suspect: s })).toEqual({ wrote: false, gateEscape: false, stopped: 'row missing', recordSuspect: true });
  });

  it('lets a failure already recorded stand over a hold or a move', () => {
    const r = resolveSettlement({ ...base, settled: unchanged({ moved: 'x' }), held: 'h', findings: 1 });
    expect(r.blocked).toBeUndefined();
    expect(r.wrote).toBe(false);
    expect(r.stopped).toBe('h');
  });

  it('is a gate escape on a moved nonce and UNDETERMINED on an unprovable one', () => {
    const esc = resolveSettlement({ ...base, settled: { plan: false, facts: {}, nonce: { kind: 'escaped', from: 1, to: 2 } }, held: 'h' });
    expect(esc).toMatchObject({ wrote: true, gateEscape: true });
    const unk = resolveSettlement({ ...base, settled: { plan: false, facts: {}, nonce: { kind: 'unknown', why: 'rpc down' } } });
    expect(unk.wrote).toBe(true);
    expect(unk.gateEscape).toBe(false);
    expect(unk.stopped).toMatch(/whether this wallet sent anyway cannot be established: rpc down/);
  });

  it('continues a clean, unmoved run to the normal verdict', () => {
    expect(resolveSettlement({ ...base, settled: unchanged() })).toEqual({ wrote: false, gateEscape: false, stopped: null, recordSuspect: false });
  });
});
