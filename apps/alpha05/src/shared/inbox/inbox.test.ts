import { describe, expect, it } from 'vitest';
import { NOTIF_EVENT_KIND_RECONCILED } from '@vaipakam/lib/notificationProvenance';
import { IndexerUnavailable, type IndexerClient } from '../reads/world/indexerClient';
import { INBOX_PAGE, inboxTarget, parseInboxRow, readInboxPage, unreadOf, type InboxPage } from './inbox';

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

  it.each([
    ['another network', { chainId: 1 }],
    ['another wallet', { address: '0x0000000000000000000000000000000000000001' }],
    ['no list', { notifications: undefined }],
    ['a bad cursor', { nextBefore: 'later' }],
  ])('refuses an answer for %s', async (_why, over) => {
    await expect(readInboxPage(client(answer([], null, over)), 84532, ACCOUNT)).rejects.toBeInstanceOf(IndexerUnavailable);
  });
});

describe('unreadOf', () => {
  const page = (ids: number[], nextBefore: string | null): InboxPage => ({
    rows: ids.map((id) => ({ id, kind: 'loan_matched', rawKind: 'loan_matched', loanId: 1n, createdAt: 1, entryId: null, reconciled: false })),
    nextBefore,
    unreadable: 0,
  });

  it('counts rows newer than the one seen, by id', () => {
    expect(unreadOf(page([9, 4, 12], null), 8)).toEqual({ count: 2, more: false });
    expect(unreadOf(page([3, 2], null), 8)).toEqual({ count: 0, more: false });
  });

  it('says there may be more when a whole page is new and older pages exist', () => {
    expect(unreadOf(page([9, 8], '1:0:8'), 0)).toEqual({ count: 2, more: true });
    expect(unreadOf(page([9, 8], '1:0:8'), 8)).toEqual({ count: 1, more: false });
  });
});

describe('inboxTarget', () => {
  it('opens the loan, or Claims for a reward entry', () => {
    expect(inboxTarget(parseInboxRow(row())!)).toBe('/positions/3');
    expect(inboxTarget(parseInboxRow(row({ kind: 'reward_final_notice', loanId: null, data: { entryId: '4' } }))!)).toBe('/claims');
    expect(inboxTarget(parseInboxRow(row({ kind: 'something_new', loanId: null }))!)).toBeNull();
  });
});
