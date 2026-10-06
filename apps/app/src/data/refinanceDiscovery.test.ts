/** #2391 — refinance requests are found on chain, within a bounded scan,
 *  and an incomplete or failed scan is unknown, never "none". */
import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, type PublicClient } from 'viem';
import {
  DISCOVERY_MAX_PAGES,
  DISCOVERY_PAGE,
  candidateIds,
  discoverRefinanceRequest,
  fromRecord,
  isUntakeable,
  leftoverFrom,
  resolveScan,
  selectRequest,
  type OfferFacts,
} from './refinanceDiscovery';

const HOLDER = '0x00000000000000000000000000000000000000Aa';
const OTHER = '0x00000000000000000000000000000000000000bb';
const NOW = 1_000n;
const req = (id: bigint, over: Partial<OfferFacts> = {}): OfferFacts => ({
  id,
  creator: HOLDER,
  accepted: false,
  refinanceTargetLoanId: 7n,
  expiresAt: 0n,
  ...over,
});

describe('selectRequest', () => {
  it('finds the newest open request for the loan made by the current holder', () => {
    expect(selectRequest(7n, HOLDER.toLowerCase(), [req(3n), req(9n), req(5n)], NOW)).toEqual({
      kind: 'found',
      offerId: '9',
      open: true,
    });
  });
  it('prefers an OPEN request over a newer expired one (r1)', () => {
    expect(
      selectRequest(7n, HOLDER, [req(4n), req(9n, { expiresAt: NOW - 1n })], NOW),
    ).toEqual({ kind: 'found', offerId: '4', open: true });
  });
  it('returns an expired request when no open one exists, so it can be cancelled', () => {
    expect(selectRequest(7n, HOLDER, [req(9n, { expiresAt: NOW })], NOW)).toEqual({
      kind: 'found',
      offerId: '9',
      open: false,
    });
  });
  it('ignores other loans, accepted or cancelled offers, and other creators', () => {
    expect(
      selectRequest(
        7n,
        HOLDER,
        [
          req(1n, { refinanceTargetLoanId: 8n }),
          req(2n, { refinanceTargetLoanId: 0n }),
          req(3n, { accepted: true }),
          req(4n, { creator: '0x0000000000000000000000000000000000000000' }),
          // A previous holder's request: the contract will not settle it.
          req(5n, { creator: OTHER }),
        ],
        NOW,
      ),
    ).toEqual({ kind: 'none' });
  });
});

/** A fake offer index: ids 1..total in creation order. */
function index(total: number) {
  const ids = Array.from({ length: total }, (_, i) => BigInt(i + 1));
  const reads: [bigint, bigint][] = [];
  return {
    reads,
    readTotal: async () => BigInt(total),
    readPage: async (offset: bigint, limit: bigint) => {
      reads.push([offset, limit]);
      return ids.slice(Number(offset), Number(offset + limit));
    },
  };
}

describe('candidateIds — bounded, newest-first, stops at the loan (r1)', () => {
  it('returns only offers newer than the loan, reading one page when the boundary is on it', async () => {
    const ix = index(250);
    expect(await candidateIds(ix.readTotal, ix.readPage, 240n)).toEqual({
      ids: Array.from({ length: 10 }, (_, i) => BigInt(241 + i)),
      complete: true,
    });
    expect(ix.reads).toEqual([[150n, 100n]]);
  });
  it('pages further back until it crosses the boundary', async () => {
    const ix = index(250);
    const { ids, complete } = await candidateIds(ix.readTotal, ix.readPage, 120n);
    expect(ids).toHaveLength(130);
    expect(complete).toBe(true);
    expect(ix.reads).toEqual([
      [150n, 100n],
      [50n, 100n],
    ]);
  });
  it('is complete when it reaches the start of the index', async () => {
    const ix = index(30);
    expect(await candidateIds(ix.readTotal, ix.readPage, 0n)).toMatchObject({ complete: true });
    expect((await candidateIds(ix.readTotal, ix.readPage, 0n)).ids).toHaveLength(30);
  });
  it('is marked INCOMPLETE — never a partial list passed off as whole — when the page cap is hit first', async () => {
    const cap = DISCOVERY_PAGE * DISCOVERY_MAX_PAGES;
    const ix = index(cap + 50);
    const r = await candidateIds(ix.readTotal, ix.readPage, 10n);
    expect(r.complete).toBe(false);
    // …and what WAS read is the newest offers, kept as evidence (r7).
    expect(r.ids).toHaveLength(cap);
    expect(r.ids).toContain(BigInt(cap + 50));
    expect(r.ids).not.toContain(50n);
    expect(ix.reads).toHaveLength(DISCOVERY_MAX_PAGES);
  });
  it('is an empty, complete list for a holder with no offers', async () => {
    const ix = index(0);
    expect(await candidateIds(ix.readTotal, ix.readPage, 5n)).toEqual({ ids: [], complete: true });
  });
});

describe('resolveScan (r7) — an incomplete scan still counts what it read', () => {
  it('a complete scan returns its selection as is', () => {
    expect(resolveScan(7n, HOLDER, [req(4n, { expiresAt: NOW - 1n })], NOW, true)).toEqual({
      kind: 'found',
      offerId: '4',
      open: false,
    });
    expect(resolveScan(7n, HOLDER, [], NOW, true)).toEqual({ kind: 'none' });
  });
  it('an OPEN request among the newest offers is conclusive even when the scan was capped', () => {
    expect(resolveScan(7n, HOLDER, [req(400n)], NOW, false)).toEqual({
      kind: 'found',
      offerId: '400',
      open: true,
    });
  });
  it('a capped scan that found only an expired request, or nothing, is capped', () => {
    expect(resolveScan(7n, HOLDER, [req(400n, { expiresAt: NOW - 1n })], NOW, false)).toEqual({
      kind: 'unknown',
      reason: 'capped',
    });
    expect(resolveScan(7n, HOLDER, [], NOW, false)).toEqual({ kind: 'unknown', reason: 'capped' });
  });
});


// ─── #2425 — the protocol's record first ───────────────────────────────

describe('fromRecord', () => {
  const offer = (over: Partial<Omit<OfferFacts, 'expiresAt' | 'id'>> = {}) => ({
    creator: HOLDER,
    accepted: false,
    refinanceTargetLoanId: 7n,
    ...over,
  });
  it('a standing record is the open request', () => {
    expect(fromRecord(7n, HOLDER, { offerId: 9n, live: true }, null)).toEqual({
      kind: 'found',
      offerId: '9',
      open: true,
    });
  });
  it("a lapsed record that is still the holder's own uncancelled request is expired", () => {
    expect(fromRecord(7n, HOLDER.toLowerCase(), { offerId: 9n, live: false }, offer())).toEqual({
      kind: 'found',
      offerId: '9',
      open: false,
    });
  });
  it('leaves everything else to the leftover scan', () => {
    const lapsed = { offerId: 9n, live: false };
    expect(fromRecord(7n, HOLDER, { offerId: 0n, live: false }, null)).toBeNull();
    expect(fromRecord(7n, HOLDER, lapsed, offer({ accepted: true }))).toBeNull();
    expect(fromRecord(7n, HOLDER, lapsed, offer({ creator: OTHER }))).toBeNull();
    expect(fromRecord(7n, HOLDER, lapsed, offer({ creator: '0x0000000000000000000000000000000000000000' }))).toBeNull();
    expect(fromRecord(7n, HOLDER, lapsed, offer({ refinanceTargetLoanId: 8n }))).toBeNull();
  });
});

describe('leftoverFrom', () => {
  it('marks a found leftover untakeable, and an unanswered scan as none', () => {
    expect(leftoverFrom({ kind: 'found', offerId: '4', open: true })).toEqual({
      kind: 'found',
      offerId: '4',
      open: true,
      untakeable: true,
    });
    expect(leftoverFrom({ kind: 'unknown', reason: 'failed' })).toEqual({ kind: 'none' });
    expect(leftoverFrom({ kind: 'unknown', reason: 'capped' })).toEqual({ kind: 'none' });
    expect(leftoverFrom({ kind: 'none' })).toEqual({ kind: 'none' });
  });
});

describe('discoverRefinanceRequest — record first', () => {
  const fnMissing = () => {
    const inner = new ContractFunctionRevertedError({ abi: [], functionName: 'getRefinanceRequest' });
    inner.signature = '0xa9ad62f8';
    const outer = new BaseError('reverted');
    outer.walk = () => inner;
    return outer;
  };
  /** A fake client: `record` answers getRefinanceRequest; the holder has one
   *  offer (id 9, for loan 7) when `holderOffer` is set. */
  function client(record: () => readonly [bigint, boolean], holderOffer?: Partial<OfferFacts>) {
    const ids = holderOffer ? [9n] : [];
    return {
      readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
        if (functionName === 'getRefinanceRequest') return record();
        if (functionName === 'getUserOffersPaginated') {
          return args[2] === 0n ? [[], BigInt(ids.length)] : [ids, BigInt(ids.length)];
        }
        if (functionName === 'getOfferDetails') return { ...req(9n), ...holderOffer };
        throw new Error(`unexpected read ${functionName}`);
      },
      multicall: async () => ids.map(() => ({ ...req(9n), ...holderOffer })),
      getBlock: async () => ({ timestamp: NOW }),
    } as unknown as PublicClient;
  }
  const run = (c: PublicClient) =>
    discoverRefinanceRequest({
      client: c,
      diamond: '0x00000000000000000000000000000000000000dd',
      loanId: 7n,
      sinceOfferId: 1n,
      holder: HOLDER,
    });

  it('a standing record answers without a scan', async () => {
    expect(await run(client(() => [9n, true]))).toEqual({ kind: 'found', offerId: '9', open: true });
  });
  it('with no record, a request the scan finds is a leftover the protocol will never take', async () => {
    expect(await run(client(() => [0n, false], {}))).toEqual({
      kind: 'found',
      offerId: '9',
      open: true,
      untakeable: true,
    });
  });
  it('on a deployment without the record, the scan alone decides, as before', async () => {
    expect(
      await run(
        client(() => {
          throw fnMissing();
        }, {}),
      ),
    ).toEqual({ kind: 'found', offerId: '9', open: true });
  });
  it('any other failed read of the record is unknown, never none', async () => {
    expect(
      await run(
        client(() => {
          throw new Error('fetch failed');
        }),
      ),
    ).toEqual({ kind: 'unknown', reason: 'failed' });
  });
});

describe('isUntakeable', () => {
  it('is untakeable only when the protocol records a different request, or none', () => {
    expect(isUntakeable(9n, '9')).toBe(false);
    expect(isUntakeable(8n, '9')).toBe(true);
    expect(isUntakeable(0n, '9')).toBe(true);
    // A deployment without the record: nothing is untakeable there.
    expect(isUntakeable(null, '9')).toBe(false);
  });
});
