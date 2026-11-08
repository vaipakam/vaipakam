/**
 * #3205 (#3318 Codex r4) — a match slice's loan takes FRESH position tokens on
 * both sides; the posting side's is minted to whoever holds the offer's token
 * at the match. Those tokens never equal the offer's own token, so the loan
 * row's initial holders come from the mints in the loan's own transaction
 * (`NFTMinted`), not from token-id reuse.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import type { Env } from '../src/env';
import { processLoanLogs } from '../src/chainIndexer';
import { createSqliteD1 } from './helpers/sqliteD1';

const DIR = new URL('../migrations/', import.meta.url);
const migrations = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, DIR), 'utf8'));

const CHAIN = 84532;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as const;
const LENDER = '0x000000000000000000000000000000000000000a';
const BORROWER = '0x000000000000000000000000000000000000000b';
const RECEIVED = '0x00000000000000000000000000000000000000c3';
const client = {
  readContract: async () => {
    throw new Error('no read in this fixture');
  },
} as unknown as PublicClient;

const envelope = { blockNumber: 100n, transactionHash: `0x${'ab'.repeat(32)}` };
const logs = [
  { ...envelope, logIndex: 0, eventName: 'NFTMinted', args: { tokenId: 21n, owner: LENDER, role: 'Lender' } },
  // The posting borrower's offer NFT moved before the match: the slice's
  // borrower token is minted to the wallet holding it now.
  { ...envelope, logIndex: 1, eventName: 'NFTMinted', args: { tokenId: 22n, owner: RECEIVED, role: 'Borrower' } },
  {
    ...envelope,
    logIndex: 2,
    eventName: 'LoanInitiated',
    args: { loanId: 5n, offerId: 9n, lender: LENDER, borrower: BORROWER, principal: 1000n, collateralAmount: 1500n },
  },
  {
    ...envelope,
    logIndex: 3,
    eventName: 'LoanInitiatedDetails',
    args: {
      loanId: 5n,
      details: {
        lenderTokenId: 21n,
        borrowerTokenId: 22n,
        assetType: 0,
        collateralAssetType: 0,
        principalAsset: '0x00000000000000000000000000000000000000e1',
        collateralAsset: '0x00000000000000000000000000000000000000e2',
        durationDays: 30n,
        tokenId: 0n,
        collateralTokenId: 0n,
        interestRateBps: 500n,
        allowsPartialRepay: false,
        periodicInterestCadence: 0,
      },
    },
  },
];

describe('a match slice seeds its holders from the mints', () => {
  it('the posting side belongs to the mint recipient, not the origination party', async () => {
    const h = createSqliteD1(migrations);
    await processLoanLogs(logs as never, { DB: h.d1 } as unknown as Env, CHAIN, new Map([[100n, 1_700_000_000]]), client, DIAMOND);
    const row = h.db
      .prepare('SELECT lender_current_owner AS l, borrower_current_owner AS b FROM loans WHERE chain_id = ? AND loan_id = 5')
      .get(CHAIN) as { l: string; b: string };
    expect(row).toEqual({ l: LENDER, b: RECEIVED });
    const participants = h.db
      .prepare('SELECT wallet, role FROM loan_participants WHERE chain_id = ? AND loan_id = 5 ORDER BY role')
      .all(CHAIN);
    expect(participants).toEqual([
      { wallet: RECEIVED, role: 'borrower' },
      { wallet: LENDER, role: 'lender' },
    ]);
  });
});
