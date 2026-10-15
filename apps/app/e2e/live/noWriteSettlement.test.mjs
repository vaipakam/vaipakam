/**
 * The settlement both write-capable live drivers end on (#2505). What is
 * pinned: its ORDER (browser closed, ledgers judged, facts re-read, nonce
 * read last), the three nonce readings, the whole-record comparison, and the
 * one rule that turns a settled run into a verdict input.
 */
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem';
import { LOAN_BOOKKEEPING_FIELDS, Suspect, changedFields, loanActivity, mergeFacts, nonceBaseline, reconcileNonce, resolveSettlement, settleRun } from './noWriteSettlement.mjs';

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
  it('proves no send only on an unchanged count', async () => {
    expect(await reconcileNonce(pubWith(7), W, 7)).toEqual({ kind: 'unchanged' });
    expect(await reconcileNonce(pubWith(8), W, 7)).toEqual({ kind: 'sent', from: 7, to: 8 });
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

  it('leaves notification bookkeeping out, and nothing else', () => {
    const before = { status: 0, lenderNotifBilled: false, borrowerNotifBilled: false, collateralAmount: 10n };
    expect(changedFields(before, { ...before, lenderNotifBilled: true }, LOAN_BOOKKEEPING_FIELDS)).toEqual([]);
    expect(changedFields(before, { ...before, lenderNotifBilled: true, collateralAmount: 11n }, LOAN_BOOKKEEPING_FIELDS)).toEqual(['collateralAmount']);
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
    expect(out).toEqual({ plan: true, closeFailed: null });
  });

  it('reads a browser that did not close as an unprovable write', async () => {
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
    // Nothing the nonce shows can be trusted while the browser may still run.
    expect(out.nonce.kind).toBe('unknown');
    expect(out.nonce.why).toMatch(/could not be closed/);
  });
});

describe('resolveSettlement', () => {
  const unchanged = (facts = {}) => ({ plan: false, facts, nonce: { kind: 'unchanged' } });
  const base = { held: null, stopped: null, suspect: null, findings: 0, subject: "loan 1's claim" };

  it('is BLOCKED for a hold on a provably write-free run', () => {
    expect(resolveSettlement({ ...base, settled: unchanged(), held: 'underfunded' }).blocked).toMatch(/^underfunded; this wallet's nonce shows no transaction/);
  });

  it('is BLOCKED for a suspect the facts may explain, with the order unknown', () => {
    const s = new Suspect('row missing', { row: 'r', key: 'k', label: 'l' });
    const r = resolveSettlement({ ...base, settled: unchanged({ moved: 'status 2' }), suspect: s });
    expect(r.blocked).toMatch(/the drive stopped \(row missing\), and what loan 1's claim rests on changed by the verdict \(status 2\); which came first is unknown/);
    expect(resolveSettlement({ ...base, settled: unchanged({ unknown: 'rpc down' }), suspect: s }).blocked).toMatch(/could not be re-read/);
    expect(resolveSettlement({ ...base, settled: unchanged({ moved: 'status 2' }) }).blocked).toMatch(/^what loan 1's claim rests on changed/);
  });

  it('keeps a plain stop a failure whatever moved or the nonce shows', () => {
    for (const settled of [unchanged({ moved: 'status 2' }), unchanged({ unknown: 'rpc down' }), { plan: false, facts: {}, nonce: { kind: 'unknown', why: 'rpc down' } }]) {
      const r = resolveSettlement({ ...base, settled, stopped: '/claims answered 503' });
      expect(r.blocked).toBeUndefined();
      expect(r.wrote).toBe(false);
      expect(r.stopped).toMatch(/^\/claims answered 503/);
    }
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

  it('is UNDETERMINED, never a gate escape, on a moved or unprovable nonce', () => {
    const sent = resolveSettlement({ ...base, settled: { plan: false, facts: {}, nonce: { kind: 'sent', from: 1, to: 2 } }, held: 'h' });
    expect(sent).toMatchObject({ wrote: true, writeUnknown: true, gateEscape: false });
    expect(sent.stopped).toMatch(/nonce moved 1 → 2 during the drive; .*inferred to be another user of the wallet/);
    const unk = resolveSettlement({ ...base, settled: { plan: false, facts: {}, nonce: { kind: 'unknown', why: 'rpc down' } } });
    expect(unk).toMatchObject({ wrote: true, writeUnknown: true, gateEscape: false });
    expect(unk.stopped).toMatch(/whether this wallet sent anyway cannot be established: rpc down/);
  });

  it('keeps a recorded failure a failure when the nonce cannot be read or moved', () => {
    for (const nonce of [{ kind: 'unknown', why: 'rpc down' }, { kind: 'sent', from: 1, to: 2 }]) {
      const r = resolveSettlement({ ...base, settled: { plan: false, facts: {}, nonce }, findings: 1 });
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

  it('continues a clean, unmoved run to the normal verdict', () => {
    expect(resolveSettlement({ ...base, settled: unchanged() })).toEqual({ wrote: false, gateEscape: false, stopped: null, recordSuspect: false });
  });
});

describe('loanActivity', () => {
  const abi = parseAbi([
    'event LoanRepaid(uint256 indexed loanId, uint256 amount)',
    'event OfferCreated(uint256 indexed offerId)',
    'event InternalMatchExecuted(uint256 indexed loanIdA, uint256 indexed loanIdB)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'event Paused(address account)',
    'event NotificationFeeBilled(uint256 indexed loanId, bool lenderSide)',
  ]);
  const D = '0x00000000000000000000000000000000000000d1';
  const log = (eventName, args, data = '0x', block = 10n) => ({
    topics: encodeEventTopics({ abi, eventName, args }),
    data,
    transactionHash: `0x${'ab'.repeat(32)}`,
    blockNumber: block,
  });
  const pubOf = (logs) => ({ getBlockNumber: async () => 12n, getLogs: async () => logs });
  const run = (logs) => loanActivity({ pub: pubOf(logs), diamond: D, abi, fromBlock: 5n, loanId: 21n, tokenIds: [41n, 42n] });

  it('counts what touched this loan, its positions or a gate, and nothing else', async () => {
    expect(await run([log('OfferCreated', { offerId: 21n }), log('Transfer', { from: D, to: D, tokenId: 7n })])).toEqual({});
    expect(await run([log('NotificationFeeBilled', { loanId: 21n }, encodeAbiParameters([{ type: 'bool' }], [true]))])).toEqual({});
    expect((await run([log('Transfer', { from: D, to: D, tokenId: 41n }), log('Transfer', { from: D, to: D, tokenId: 41n })])).moved).toMatch(/^2 event\(s\) since startup block 5/);
    expect((await run([log('InternalMatchExecuted', { loanIdA: 9n, loanIdB: 21n })])).moved).toMatch(/InternalMatchExecuted/);
    expect((await run([log('Paused', {}, encodeAbiParameters([{ type: 'address' }], [D]))])).moved).toMatch(/Paused/);
    expect((await run([log('LoanRepaid', { loanId: 21n }, encodeAbiParameters([{ type: 'uint256' }], [1n]))])).moved).toMatch(/LoanRepaid/);
  });

  it('is unknown, never clean, when the events cannot be read', async () => {
    const pub = { getBlockNumber: async () => 12n, getLogs: async () => { throw new Error('range too large'); } };
    expect((await loanActivity({ pub, diamond: D, abi, fromBlock: 5n, loanId: 21n })).unknown).toMatch(/could not read the Diamond's events/);
  });

  it('merges with the endpoint reading: a move either shows wins', () => {
    expect(mergeFacts({}, { moved: 'a' })).toEqual({ moved: 'a' });
    expect(mergeFacts({ unknown: 'u' }, { moved: 'a' })).toEqual({ moved: 'a' });
    expect(mergeFacts({ unknown: 'u' }, {})).toEqual({ unknown: 'u' });
    expect(mergeFacts({}, {})).toEqual({});
  });
});
