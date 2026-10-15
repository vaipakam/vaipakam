/**
 * The settlement both write-capable live drivers end on (#2505). What is
 * pinned: its ORDER (browser closed, ledgers judged, nonce read last), the
 * nonce readings at both tags, the whole-record comparison, and the one rule
 * that turns a settled run into a verdict input: a suspect is NOT ESTABLISHED,
 * never a failure (#2505 r48).
 */
import { describe, expect, it } from 'vitest';
import { LOAN_BOOKKEEPING_FIELDS, Suspect, changedFields, nonceBaseline, reconcileNonce, resolveSettlement, settleRun } from './noWriteSettlement.mjs';

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
    expect((await nonceBaseline(pubWith(4, 5), W)).blocked).toMatch(/inconsistent/);
    expect(await nonceBaseline(pubWith(5), W)).toEqual({ nonce: 5 });
  });
});

describe('reconcileNonce', () => {
  it('proves no send only when both tags read the baseline', async () => {
    expect(await reconcileNonce(pubWith(7), W, 7)).toEqual({ kind: 'unchanged' });
    expect(await reconcileNonce(pubWith(8), W, 7)).toEqual({ kind: 'sent', from: 7, to: 8 });
    expect((await reconcileNonce(pubWith(6), W, 7)).kind).toBe('unknown');
    expect((await reconcileNonce(pubWith(new Error('down')), W, 7)).kind).toBe('unknown');
  });

  it('reads a mined count that moved as a send, even when pending did not (#2505 r48)', async () => {
    expect(await reconcileNonce(pubWith(7, 8), W, 7)).toEqual({ kind: 'sent', from: 7, to: 8 });
    expect(await reconcileNonce(pubWith(8, 7), W, 7)).toEqual({ kind: 'sent', from: 7, to: 8 });
  });

  it('reads a rise beside a count below the baseline as unknown, not as a send (#2505 r50)', async () => {
    expect((await reconcileNonce(pubWith(8, 6), W, 7)).kind).toBe('unknown');
    expect((await reconcileNonce(pubWith(6, 8), W, 7)).kind).toBe('unknown');
  });

  it('reads a mined count below the baseline as unknown, not as unchanged', async () => {
    const r = await reconcileNonce(pubWith(7, 6), W, 7);
    expect(r.kind).toBe('unknown');
    expect(r.why).toMatch(/7 pending and 6 mined/);
  });
});

describe('changedFields', () => {
  it('names every field that changed, addresses case-blind', () => {
    const before = { status: 0, collateralAmount: 10n, lender: '0xAbC' };
    expect(changedFields(before, { status: 0, collateralAmount: 10n, lender: '0xabc' })).toEqual([]);
    expect(changedFields(before, { status: 0, collateralAmount: 12n, lender: '0xabc' })).toEqual(['collateralAmount']);
    expect(changedFields([1n, false], [1n, true])).toEqual(['1']);
  });

  it('leaves notification bookkeeping out, and nothing else', () => {
    const before = { status: 0, lenderNotifBilled: false, borrowerNotifBilled: false, collateralAmount: 10n };
    expect(changedFields(before, { ...before, lenderNotifBilled: true }, LOAN_BOOKKEEPING_FIELDS)).toEqual([]);
    expect(changedFields(before, { ...before, lenderNotifBilled: true, collateralAmount: 11n }, LOAN_BOOKKEEPING_FIELDS)).toEqual(['collateralAmount']);
  });
});

describe('Suspect', () => {
  it('requires the check it leaves open', () => {
    expect(() => new Suspect('row missing')).toThrow(TypeError);
    expect(() => new Suspect('row missing', { row: 'r', key: 'k' })).toThrow(/names no check/);
    expect(new Suspect('row missing', { row: 'r', key: 'k', label: 'l' }).check).toEqual({ row: 'r', key: 'k', label: 'l' });
  });
});

describe('settleRun', () => {
  it('closes the browser, judges the ledgers, and reads the nonce last', async () => {
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
      pub,
      wallet: W,
      baseline: 3,
    });
    expect(order).toEqual(['close', 'ledgers', 'nonce', 'nonce']);
    expect(out).toEqual({ plan: false, nonce: { kind: 'unchanged' } });
  });

  it('stops after the ledgers when the plan sent', async () => {
    const order = [];
    const out = await settleRun({
      closeBrowser: async () => order.push('close'),
      judgeLedgers: () => order.push('ledgers'),
      wrotePlan: () => true,
      pub: pubWith(0),
      wallet: W,
      baseline: 0,
    });
    expect(order).toEqual(['close', 'ledgers']);
    expect(out).toEqual({ plan: true, closeFailed: null });
  });

  it('reads a browser that did not close as an unprovable write', async () => {
    const out = await settleRun({
      closeBrowser: async () => {
        throw new Error('gone');
      },
      judgeLedgers: () => {},
      wrotePlan: () => false,
      pub: pubWith(3),
      wallet: W,
      baseline: 3,
    });
    // Nothing the nonce shows can be trusted while the browser may still run.
    expect(out.nonce.kind).toBe('unknown');
    expect(out.nonce.why).toMatch(/could not be closed/);
  });
});

describe('resolveSettlement', () => {
  const unchanged = () => ({ plan: false, nonce: { kind: 'unchanged' } });
  const base = { held: null, stopped: null, suspect: null, findings: 0, subject: "loan 1's claim" };
  const suspect = () => new Suspect('row missing', { row: 'r', key: 'k', label: 'l', detail: 'd' });

  it('is BLOCKED for a hold on a provably write-free run', () => {
    expect(resolveSettlement({ ...base, settled: unchanged(), held: 'underfunded' }).blocked).toMatch(/^underfunded; this wallet's nonce shows no transaction/);
  });

  it('leaves a suspect NOT ESTABLISHED, never a failure, on a write-free run (#2505 r48)', () => {
    expect(resolveSettlement({ ...base, settled: unchanged(), suspect: suspect() })).toEqual({
      wrote: false,
      gateEscape: false,
      stopped: null,
      undetermined: { row: 'r', key: 'k', label: 'l', detail: 'd', why: 'row missing' },
    });
  });

  it('keeps a plain stop a failure whatever the nonce shows', () => {
    for (const settled of [unchanged(), { plan: false, nonce: { kind: 'unknown', why: 'rpc down' } }]) {
      const r = resolveSettlement({ ...base, settled, stopped: '/claims answered 503' });
      expect(r.blocked).toBeUndefined();
      expect(r.wrote).toBe(false);
      expect(r.stopped).toMatch(/^\/claims answered 503/);
    }
  });

  it('lets a failure already recorded stand over a hold, carrying a suspect beside it', () => {
    const r = resolveSettlement({ ...base, settled: unchanged(), held: 'h', findings: 1, suspect: suspect() });
    expect(r.blocked).toBeUndefined();
    expect(r.wrote).toBe(false);
    expect(r.stopped).toBe('h');
    expect(r.undetermined).toMatchObject({ row: 'r', why: 'row missing' });
  });

  it('is UNDETERMINED, never a gate escape, on a moved or unprovable nonce', () => {
    const sent = resolveSettlement({ ...base, settled: { plan: false, nonce: { kind: 'sent', from: 1, to: 2 } }, held: 'h' });
    expect(sent).toMatchObject({ wrote: true, writeUnknown: true, gateEscape: false });
    expect(sent.stopped).toMatch(/nonce moved 1 → 2 during the drive; .*inferred to be another user of the wallet/);
    const unk = resolveSettlement({ ...base, settled: { plan: false, nonce: { kind: 'unknown', why: 'rpc down' } } });
    expect(unk).toMatchObject({ wrote: true, writeUnknown: true, gateEscape: false });
    expect(unk.stopped).toMatch(/whether this wallet sent anyway cannot be established: rpc down/);
  });

  it('keeps a recorded failure a failure when the nonce cannot be read or moved', () => {
    for (const nonce of [{ kind: 'unknown', why: 'rpc down' }, { kind: 'sent', from: 1, to: 2 }]) {
      const r = resolveSettlement({ ...base, settled: { plan: false, nonce }, findings: 1 });
      expect(r.wrote).toBe(false);
      // Still a FAIL, with the uncertainty carried to the verdict line.
      expect(r.writeUnknown).toBe(true);
      expect(r.stopped).toMatch(/the plan sent nothing, but/);
    }
  });

  it('never lets a sent run pass on ledgers a still-open browser could add to', () => {
    const r = resolveSettlement({ ...base, settled: { plan: true, closeFailed: 'gone' } });
    expect(r.wrote).toBe(true);
    expect(r.stopped).toMatch(/could not be closed \(gone\)/);
  });

  it('continues a clean run to the normal verdict', () => {
    expect(resolveSettlement({ ...base, settled: unchanged() })).toEqual({ wrote: false, gateEscape: false, stopped: null, undetermined: null });
  });
});
