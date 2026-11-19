import { describe, expect, it } from 'vitest';
import { awaitAccountTx, safeStatus, type AccountTxStatus } from './accountWallet';

const CHAIN = ('0x' + 'c'.repeat(64)) as `0x${string}`;
const ID = ('0x' + 'd'.repeat(64)) as `0x${string}`;

describe('safeStatus', () => {
  it('reads approvals collected so far against those required', () => {
    expect(safeStatus({ txStatus: 'AWAITING_CONFIRMATIONS', detailedExecutionInfo: { type: 'MULTISIG', confirmationsRequired: 3, confirmations: [{}, {}] } })).toEqual({
      kind: 'awaiting',
      confirmed: 2,
      required: 3,
    });
  });
  it('says nothing it was not told', () => {
    expect(safeStatus({ txStatus: 'AWAITING_EXECUTION' })).toEqual({ kind: 'awaiting', confirmed: null, required: null });
  });
  it('follows the chain hash once executed, even if the wallet marks it failed', () => {
    expect(safeStatus({ txStatus: 'SUCCESS', txHash: CHAIN })).toEqual({ kind: 'executed', hash: CHAIN });
    expect(safeStatus({ txStatus: 'FAILED', txHash: CHAIN })).toEqual({ kind: 'executed', hash: CHAIN });
  });
  it('ends a rejected or failed transaction that never reached the chain', () => {
    expect(safeStatus({ txStatus: 'CANCELLED' })).toEqual({ kind: 'ended', reason: 'cancelled' });
    expect(safeStatus({ txStatus: 'FAILED', txHash: null })).toEqual({ kind: 'ended', reason: 'failed' });
  });
});

describe('awaitAccountTx', () => {
  it('reports each wait and returns once executed', async () => {
    const answers: AccountTxStatus[] = [
      { kind: 'awaiting', confirmed: 1, required: 2 },
      { kind: 'awaiting', confirmed: 2, required: 2 },
      { kind: 'executed', hash: CHAIN },
    ];
    const seen: unknown[] = [];
    const end = await awaitAccountTx({ status: async () => answers.shift()! }, ID, (s) => seen.push(s), () => {}, async () => {});
    expect(end).toEqual({ kind: 'executed', hash: CHAIN });
    expect(seen).toEqual([
      { kind: 'awaiting', confirmed: 1, required: 2 },
      { kind: 'awaiting', confirmed: 2, required: 2 },
    ]);
  });
  it('keeps waiting through a failed read and says so', async () => {
    let calls = 0;
    const unread: unknown[] = [];
    const status = async (): Promise<AccountTxStatus> => {
      calls += 1;
      if (calls === 1) throw new Error('down');
      return { kind: 'executed', hash: CHAIN };
    };
    const end = await awaitAccountTx({ status }, ID, () => {}, (e) => unread.push(e), async () => {});
    expect(end).toEqual({ kind: 'executed', hash: CHAIN });
    expect(unread).toHaveLength(1);
  });
});
