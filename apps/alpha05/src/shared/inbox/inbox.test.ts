import { describe, expect, it } from 'vitest';
import { NOTIF_EVENT_KIND_RECONCILED } from '@vaipakam/lib/notificationProvenance';
import { IndexerUnavailable, type IndexerClient } from '../reads/world/indexerClient';
import { INBOX_PAGE, inboxTarget, parseInboxRow, readInboxNewer, readInboxPage } from './inbox';

const ACCOUNT = '0x00000000000000000000000000000000000000Aa' as const;

function client(body: unknown, seen: string[] = []): IndexerClient {
  return {
    origin: 'https://index.test',
    async getJson<T>(path: string): Promise<T> {
      seen.push(path);
      return body as T;
    },
  };
}

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 7, kind: 'loan_repaid', loanId: 3, offerId: null, eventKind: 'LoanRepaid', data: null, createdAt: 1_800_000_000, blockNumber: 10, logIndex: 1, ...over };
}

function answer(notifications: unknown[], nextBefore: string | null = null, over: Record<string, unknown> = {}) {
  return { chainId: 84532, address: ACCOUNT.toLowerCase(), notifications, nextBefore, ...over };
}

describe('parseInboxRow', () => {
  it('reads a loan row and a reward row', () => {
    expect(parseInboxRow(row())).toEqual({ id: 7, kind: 'loan_repaid', rawKind: 'loan_repaid', loanId: 3n, createdAt: 1_800_000_000, entryId: null, reconciled: false });
    expect(parseInboxRow(row({ kind: 'reward_expired', loanId: null, data: { entryId: 12 } }))?.entryId).toBe('12');
  });

  it('marks a row a check found, rather than an event announced', () => {
    expect(parseInboxRow(row({ kind: 'loan_ended', eventKind: NOTIF_EVENT_KIND_RECONCILED }))?.reconciled).toBe(true);
    expect(parseInboxRow(row({ eventKind: null }))?.reconciled).toBe(false);
  });

  it('keeps a kind it has no words for, naming it', () => {
    expect(parseInboxRow(row({ kind: 'offer_matched', loanId: null }))).toMatchObject({ kind: null, rawKind: 'offer_matched' });
  });

  it.each([
    ['no id', { id: undefined }],
    ['a fractional id', { id: 1.5 }],
    ['no time', { createdAt: null }],
    ['a time past any date', { createdAt: 9e12 }],
    ['an empty kind', { kind: '' }],
    ['a loan row with no loan', { loanId: null }],
    ['a bad loan id', { loanId: 'x' }],
    ['a reward row with no entry', { kind: 'reward_final_notice', loanId: null, data: {} }],
  ])('refuses %s', (_why, over) => {
    expect(parseInboxRow(row(over))).toBeNull();
  });
});

describe('readInboxPage', () => {
  it('asks for the wallet lowercased, on the network, a page at a time', async () => {
    const seen: string[] = [];
    await readInboxPage(client(answer([]), seen), 84532, ACCOUNT, '10:1:7');
    expect(seen[0]).toBe(`/notifications/${ACCOUNT.toLowerCase()}?chainId=84532&limit=${INBOX_PAGE}&before=10%3A1%3A7`);
  });

  it('counts unreadable rows instead of dropping them in silence', async () => {
    const p = await readInboxPage(client(answer([row(), row({ id: 'x' }), row({ id: 8, kind: 'hf_alert' })], '9:0:6')), 84532, ACCOUNT);
    expect(p.rows.map((r) => r.id)).toEqual([7, 8]);
    expect(p.unreadable).toBe(1);
    expect(p.nextBefore).toBe('9:0:6');
  });

  it('keeps the id of an unreadable row when the id itself reads, so a new row it cannot show is still placed', async () => {
    const p = await readInboxPage(client(answer([row({ id: 12, createdAt: null }), row({ id: 'x' }), row({ id: 8, kind: 'hf_alert' })], null)), 84532, ACCOUNT);
    expect(p.unreadable).toBe(2);
    expect(p.unreadableIds).toEqual([12]);
  });

  it.each([
    ['another network', { chainId: 1 }],
    ['another wallet', { address: '0x0000000000000000000000000000000000000001' }],
    ['no list', { notifications: undefined }],
    ['a bad cursor', { nextBefore: 'later' }],
  ])('refuses an answer for %s', async (_why, over) => {
    await expect(readInboxPage(client(answer([], null, over)), 84532, ACCOUNT)).rejects.toBeInstanceOf(IndexerUnavailable);
  });
});

describe('readInboxNewer', () => {
  it('asks the index to count rows written after the one seen', async () => {
    const seen: string[] = [];
    const r = await readInboxNewer(client(answer([], null, { newerThan: { id: 8, count: 3, capped: false, newestId: 14 } }), seen), 84532, ACCOUNT, 8);
    expect(seen[0]).toBe(`/notifications/${ACCOUNT.toLowerCase()}?chainId=84532&limit=1&newerThan=8`);
    expect(r).toEqual({ count: 3, capped: false, newestId: 14 });
  });

  it.each([
    ['no count (an index that predates it)', {}],
    ['a count for another id', { newerThan: { id: 7, count: 3, capped: false, newestId: 14 } }],
    ['a bad count', { newerThan: { id: 8, count: -1, capped: false, newestId: 14 } }],
    ['no cap flag', { newerThan: { id: 8, count: 1, newestId: 14 } }],
    ['another wallet', { address: '0x0000000000000000000000000000000000000001', newerThan: { id: 8, count: 1, capped: false, newestId: 14 } }],
  ])('refuses an answer with %s', async (_why, over) => {
    await expect(readInboxNewer(client(answer([], null, over)), 84532, ACCOUNT, 8)).rejects.toBeInstanceOf(IndexerUnavailable);
  });
});

describe('inboxTarget', () => {
  it('opens the loan, or Claims for a reward entry', () => {
    expect(inboxTarget(parseInboxRow(row())!)).toBe('/positions/3');
    expect(inboxTarget(parseInboxRow(row({ kind: 'reward_final_notice', loanId: null, data: { entryId: '4' } }))!)).toBe('/claims');
    expect(inboxTarget(parseInboxRow(row({ kind: 'something_new', loanId: null }))!)).toBeNull();
  });
});
