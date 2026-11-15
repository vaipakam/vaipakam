import { describe, expect, it } from 'vitest';
import { participantKinds } from '@vaipakam/lib/activityParticipants';
import { refScopedKinds } from '@vaipakam/lib/activityRefs';
import { copyEntry, type CopyAccess, type CopyKey } from '../copy/useCopy';
import { IndexerUnavailable, type IndexerClient } from '../reads/world/indexerClient';
import { activityLines, parseActivityEvent, parseRepairEntry, readActivityPage, type ActivityEvent } from './activity';
import { amountLine } from './amountLine';
import { kindKey, namedKinds } from './useWalletActivity';

const WALLET = '0x00000000000000000000000000000000000000Aa' as const;
const TOKEN = '0x00000000000000000000000000000000000000cc' as const;
const TX_A = `0x${'a'.repeat(64)}` as `0x${string}`;
const TX_B = `0x${'b'.repeat(64)}` as `0x${string}`;

function client(body: unknown, seen: string[] = []): IndexerClient {
  return {
    origin: 'https://index.test',
    async getJson<T>(path: string): Promise<T> {
      seen.push(path);
      return body as T;
    },
  };
}

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: 84532,
    blockNumber: 10,
    logIndex: 1,
    txHash: TX_A,
    kind: 'LoanInitiated',
    loanId: 3,
    offerId: null,
    actor: WALLET.toLowerCase(),
    args: {},
    blockAt: 1_800_000_000,
    asset: null,
    assetType: null,
    amount: null,
    amountMax: null,
    tokenId: null,
    quantity: null,
    ...over,
  };
}

function ev(over: Partial<ActivityEvent> = {}): ActivityEvent {
  return { ...parseActivityEvent(raw(), true)!, ...over };
}

function answer(events: unknown[], over: Record<string, unknown> = {}) {
  return { chainId: 84532, wallet: WALLET.toLowerCase(), events, walletComplete: true, nextBefore: null, ...over };
}

const copy: CopyAccess = {
  text: (k: CopyKey) => copyEntry(k).text,
  format: (k: CopyKey, vars) => copyEntry(k).text.replace(/\{\{(\w+)\}\}/g, (_, n: string) => vars[n] ?? ''),
  entry: copyEntry,
};

describe('parseActivityEvent', () => {
  it('reads an event, its references and what it moved', () => {
    expect(parseActivityEvent(raw({ amount: '1500000', asset: TOKEN, assetType: 0, offerId: '9' }), true)).toMatchObject({
      blockNumber: 10,
      kind: 'LoanInitiated',
      loanId: 3n,
      offerId: 9n,
      amount: 1_500_000n,
      asset: TOKEN,
      final: true,
    });
  });

  it('reads zero as no loan or offer, never as an id', () => {
    expect(parseActivityEvent(raw({ loanId: 0, offerId: '0' }), true)).toMatchObject({ loanId: null, offerId: null });
  });

  it('refuses a row it cannot read rather than guessing', () => {
    expect(parseActivityEvent(raw({ amount: '1.5' }), true)).toBeNull();
    expect(parseActivityEvent(raw({ txHash: '0x12' }), true)).toBeNull();
    expect(parseActivityEvent(raw({ actor: 'someone' }), true)).toBeNull();
    expect(parseActivityEvent(raw({ kind: '' }), true)).toBeNull();
    expect(parseActivityEvent(raw({ blockAt: -1 }), true)).toBeNull();
    expect(parseActivityEvent(null, true)).toBeNull();
  });

  it('keeps an event with no time read, as a pending one has', () => {
    expect(parseActivityEvent(raw({ blockAt: null }), false)).toMatchObject({ blockAt: null, final: false });
  });
});

describe('parseRepairEntry', () => {
  it('reads a repaired ending and refuses a malformed one', () => {
    const good = { loanId: 7, observedStatus: 'repaid', observedBlock: 20, observedAt: null, feedLogIndex: 1_000_007 };
    expect(parseRepairEntry(good)).toEqual({ loanId: 7n, observedStatus: 'repaid', observedBlock: 20, observedAt: null, feedLogIndex: 1_000_007 });
    expect(parseRepairEntry({ ...good, loanId: 0 })).toBeNull();
    expect(parseRepairEntry({ ...good, observedStatus: '<b>' })).toBeNull();
  });
});

describe('readActivityPage', () => {
  it('asks for the wallet, its repaired endings and, on the first page only, the events not final yet', async () => {
    const seen: string[] = [];
    await readActivityPage(client(answer([]), seen), 84532, WALLET, null);
    await readActivityPage(client(answer([]), seen), 84532, WALLET, '10:1');
    expect(seen[0]).toContain(`wallet=${WALLET.toLowerCase()}`);
    expect(seen[0]).toContain('repairObservations=1');
    expect(seen[0]).toContain('pending=1');
    expect(seen[1]).toContain('before=10%3A1');
    expect(seen[1]).not.toContain('pending=1');
  });

  it('refuses an answer for another wallet or network', async () => {
    await expect(readActivityPage(client(answer([], { wallet: '0x00000000000000000000000000000000000000bb' })), 84532, WALLET)).rejects.toBeInstanceOf(IndexerUnavailable);
    await expect(readActivityPage(client(answer([], { chainId: 1 })), 84532, WALLET)).rejects.toBeInstanceOf(IndexerUnavailable);
    await expect(readActivityPage(client(answer([], { nextBefore: 'x' })), 84532, WALLET)).rejects.toBeInstanceOf(IndexerUnavailable);
  });

  it('counts the rows it could not read, and keeps the index’s word on completeness', async () => {
    const page = await readActivityPage(client(answer([raw(), raw({ amount: 'x' })], { walletComplete: false })), 84532, WALLET);
    expect(page.events).toHaveLength(1);
    expect(page.unreadable).toBe(1);
    expect(page.walletComplete).toBe(false);
    expect((await readActivityPage(client(answer([], { walletComplete: null })), 84532, WALLET)).walletComplete).toBeNull();
  });

  it('keeps a loan-ending read the index could not make as unknown, never as none', async () => {
    expect((await readActivityPage(client(answer([], { repairObservations: null })), 84532, WALLET)).repairsKnown).toBe(false);
    expect((await readActivityPage(client(answer([], { repairObservations: [] })), 84532, WALLET)).repairsKnown).toBe(true);
  });

  it('reads the pending lane, and says it does not know when the index does not', async () => {
    const lane = { events: [raw({ blockNumber: 99, blockAt: null })], complete: false, readAt: 5, finalThrough: 90, throughBlock: 99, latestBlock: 99 };
    const page = await readActivityPage(client(answer([], { pending: lane })), 84532, WALLET);
    expect(page.pending).toMatchObject({ complete: false, readAt: 5 });
    expect(page.pending!.events[0]).toMatchObject({ blockNumber: 99, final: false });
    expect((await readActivityPage(client(answer([], { pending: null })), 84532, WALLET)).pending).toBeNull();
    expect((await readActivityPage(client(answer([])), 84532, WALLET, '10:1')).pending).toBeUndefined();
  });
});

describe('activityLines', () => {
  it('makes one line per transaction, led by the event that says what happened', () => {
    const lines = activityLines([
      ev({ blockNumber: 10, logIndex: 5, kind: 'Transfer', txHash: TX_A }),
      ev({ blockNumber: 10, logIndex: 4, kind: 'LoanInitiated', txHash: TX_A }),
      ev({ blockNumber: 10, logIndex: 3, kind: 'LoanInitiatedDetails', txHash: TX_A }),
      ev({ blockNumber: 9, logIndex: 0, kind: 'OfferCreated', txHash: TX_B }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ kind: 'tx', lead: { kind: 'LoanInitiated' } });
    expect(lines[0]!.kind === 'tx' && lines[0]!.rest.map((e) => e.kind)).toEqual(['Transfer', 'LoanInitiatedDetails']);
    expect(lines[1]).toMatchObject({ kind: 'tx', lead: { kind: 'OfferCreated' } });
  });

  it('leads an accept with the loan it started, not the accept itself', () => {
    const lines = activityLines([
      ev({ blockNumber: 10, logIndex: 6, kind: 'OfferAccepted', txHash: TX_A }),
      ev({ blockNumber: 10, logIndex: 5, kind: 'LoanInitiated', txHash: TX_A }),
      ev({ blockNumber: 9, logIndex: 0, kind: 'OfferAccepted', txHash: TX_B }),
    ]);
    expect(lines.map((l) => l.kind === 'tx' && l.lead.kind)).toEqual(['LoanInitiated', 'OfferAccepted']);
  });

  it('keeps an event with no transaction hash on its own line', () => {
    expect(activityLines([ev({ txHash: null, logIndex: 2 }), ev({ txHash: null, logIndex: 1 })])).toHaveLength(2);
  });

  it('places a repaired ending at its position in the feed', () => {
    const repair = { loanId: 7n, observedStatus: 'repaid', observedBlock: 9, observedAt: null, feedLogIndex: 1_000_007 };
    const lines = activityLines([ev({ blockNumber: 10, txHash: TX_A }), ev({ blockNumber: 9, logIndex: 0, txHash: TX_B })], [repair]);
    expect(lines.map((l) => l.kind)).toEqual(['tx', 'repair', 'tx']);
    expect(activityLines([], [repair]).map((l) => l.kind)).toEqual(['repair']);
  });
});

describe('the event-kind catalog', () => {
  it('names every kind the index can file for a wallet', () => {
    const missing = [...new Set([...participantKinds(), ...refScopedKinds()])].filter((k) => !namedKinds().has(k));
    expect(missing).toEqual([]);
  });

  it('says so, naming the kind, when it has no words for one', () => {
    expect(kindKey('SomethingNew')).toBeNull();
    expect(kindKey('LoanRepaid')).toBe('activity.kinds.LoanRepaid');
  });
});

describe('amountLine', () => {
  it('shows what the index recorded, and says when it recorded nothing', () => {
    const meta = { [TOKEN]: { symbol: 'USDC', decimals: 6 } };
    expect(amountLine(ev({ asset: TOKEN, assetType: 0, amount: 1_500_000n }), meta, copy)).toContain('USDC');
    expect(amountLine(ev({ asset: TOKEN, assetType: 0, amountMax: 2_000_000n }), meta, copy)).toMatch(/^Up to /);
    expect(amountLine(ev({ asset: TOKEN, assetType: 1, tokenId: 4n }), meta, copy)).toBe('NFT #4 of USDC');
    expect(amountLine(ev(), meta, copy)).toBe('No amount recorded.');
  });

  it('says when a multi-copy token’s quantity was not recorded, never reading it as one copy', () => {
    const meta = { [TOKEN]: { symbol: 'USDC', decimals: 6 } };
    expect(amountLine(ev({ asset: TOKEN, assetType: 2, tokenId: 4n, quantity: null }), meta, copy)).toBe('NFT #4 of USDC, number of copies not recorded');
    expect(amountLine(ev({ asset: TOKEN, assetType: 2, tokenId: 4n, quantity: 1n }), meta, copy)).toBe('NFT #4 of USDC × 1');
  });
});
