import { describe, expect, it } from 'vitest';
import { QUEUE_PAGE_LIMIT, SAFE_EXECUTION_FAILURE, SAFE_EXECUTION_SUCCESS, SAFE_GATEWAY, accountExecution, awaitAccountTx, nextQueuePage, readQueuedTo, safeStatus, queuedTo, walletKindFromCode, type AccountTxStatus } from './accountWallet';

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

describe('walletKindFromCode', () => {
  it('reads no code as a key wallet, a 7702 delegation as a key wallet, and other code as a contract', () => {
    expect(walletKindFromCode(undefined)).toBe('key');
    expect(walletKindFromCode('0x')).toBe('key');
    expect(walletKindFromCode(`0xef0100${'ab'.repeat(20)}`)).toBe('delegated-key');
    expect(walletKindFromCode('0x608060405234')).toBe('contract');
    expect(walletKindFromCode(`0xef0100${'ab'.repeat(21)}`)).toBe('contract');
  });
});

describe('queuedTo', () => {
  const D = '0x00000000000000000000000000000000000000dd' as const;
  it('keeps the queued transactions that call the target, with their approvals', () => {
    const page = {
      results: [
        { type: 'LABEL', label: 'Next' },
        { type: 'TRANSACTION', transaction: { id: 'a', txInfo: { to: { value: D.toUpperCase().replace('0X', '0x') } }, executionInfo: { confirmationsSubmitted: 1, confirmationsRequired: 2 } } },
        { type: 'TRANSACTION', transaction: { id: 'b', txInfo: { to: { value: '0x00000000000000000000000000000000000000ee' } } } },
        { type: 'TRANSACTION', transaction: { id: 'c', txInfo: { to: { value: D } } } },
      ],
    };
    expect(queuedTo(page, D)).toEqual([
      { id: 'a', confirmed: 1, required: 2 },
      { id: 'c', confirmed: null, required: null },
    ]);
  });
  it('refuses a shape it does not know rather than reading it as empty', () => {
    expect(() => queuedTo({}, D)).toThrow();
  });
});

describe('readQueuedTo (following the queue pages)', () => {
  const D = '0x00000000000000000000000000000000000000dd' as const;
  const S = '0x00000000000000000000000000000000000000aa' as const;
  const tx = (id: string) => ({ type: 'TRANSACTION', transaction: { id, txInfo: { to: { value: D } } } });
  const respond = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  it('follows next pages on the gateway and counts every entry', async () => {
    const pages = [
      { results: [tx('a')], next: `${SAFE_GATEWAY}/page2` },
      { results: [tx('b'), tx('c')], next: null },
    ];
    let i = 0;
    const read = await readQueuedTo(1, S, D, (async () => respond(pages[i++])) as unknown as typeof fetch);
    expect(read).toEqual({ entries: [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' }), expect.objectContaining({ id: 'c' })], partial: false });
  });
  it('says partial when it stops at the page limit', async () => {
    let calls = 0;
    const read = await readQueuedTo(1, S, D, (async () => {
      calls++;
      return respond({ results: [tx(String(calls))], next: `${SAFE_GATEWAY}/more` });
    }) as unknown as typeof fetch);
    expect(calls).toBe(QUEUE_PAGE_LIMIT);
    expect(read.partial).toBe(true);
    expect(read.entries).toHaveLength(QUEUE_PAGE_LIMIT);
  });
  it('never follows a next page off the gateway, and says partial', async () => {
    const urls: string[] = [];
    const read = await readQueuedTo(1, S, D, (async (u: string) => {
      urls.push(u);
      return respond({ results: [tx('a')], next: 'https://elsewhere.example/page2' });
    }) as unknown as typeof fetch);
    expect(urls).toHaveLength(1);
    expect(read.partial).toBe(true);
    expect(nextQueuePage({ next: 7 })).toBe('foreign');
    expect(nextQueuePage({})).toBe(null);
  });
});

describe('accountExecution (the call inside a mined wallet transaction)', () => {
  const SAFE = ('0x' + '5a'.repeat(20)) as `0x${string}`;
  const OTHER = ('0x' + '0b'.repeat(20)) as `0x${string}`;
  const pay = '0'.repeat(64);
  const unindexed = (topic: string, id: string, address: string = SAFE) => ({ address, topics: [topic], data: id + pay });
  it('reads a logged success as ran and a logged failure as failed, from the data word', () => {
    expect(accountExecution([unindexed(SAFE_EXECUTION_SUCCESS, ID)], SAFE, ID)).toBe('ran');
    expect(accountExecution([unindexed(SAFE_EXECUTION_FAILURE, ID)], SAFE, ID)).toBe('failed');
  });
  it('reads the id from the topic where a wallet indexes it', () => {
    expect(accountExecution([{ address: SAFE, topics: [SAFE_EXECUTION_FAILURE, ID], data: '0x' + pay }], SAFE, ID)).toBe('failed');
  });
  it('ignores another call, another emitter and other events; none of them is the call’s record', () => {
    const other = ('0x' + 'e'.repeat(64)) as `0x${string}`;
    expect(accountExecution([unindexed(SAFE_EXECUTION_SUCCESS, other)], SAFE, ID)).toBe('unrecorded');
    expect(accountExecution([unindexed(SAFE_EXECUTION_SUCCESS, ID, OTHER)], SAFE, ID)).toBe('unrecorded');
    expect(accountExecution([{ address: SAFE, topics: ['0x' + '1'.repeat(64)], data: ID }], SAFE, ID)).toBe('unrecorded');
    expect(accountExecution([], SAFE, ID)).toBe('unrecorded');
  });
});
