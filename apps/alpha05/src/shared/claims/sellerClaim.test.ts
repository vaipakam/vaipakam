import { encodeAbiParameters, encodeEventTopics, parseAbi, type Abi, type Log } from 'viem';
import { describe, expect, it } from 'vitest';
import { SellerClaimFacetABI } from '@vaipakam/contracts/abis';
import { OPEN } from '../eligibility/types';
import type { LoanDetails } from '../positions/loanView';
import { discoverSoldLoans, mineGross, mineNet, netOwed, sellerLogs, sellerRowShown, sellerVerdict, splitFinal, splitPart, type SellerRow } from './sellerClaim';
import { measureSellerClaim, sellerClaimReceipt, sellerPays, type SellerClaimReview } from './sellerClaimReview';

type Hex = `0x${string}`;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const ME = '0x00000000000000000000000000000000000000aa' as Hex;
const OLDER = '0x00000000000000000000000000000000000000bb' as Hex;
const WETH = '0x00000000000000000000000000000000000000e1' as Hex;
const TLIQ = '0x00000000000000000000000000000000000000e2' as Hex;

const copy = { text: (k: string) => k, format: (k: string, v?: Record<string, string>) => `${k}${v ? JSON.stringify(v) : ''}` } as never;
const words = { amount: (_a: Hex, v: bigint) => `${v}` };

function row(over: Partial<SellerRow> = {}, loan: Partial<LoanDetails> = {}): SellerRow {
  return {
    loanId: 7n,
    loan: { status: 0, principalAsset: WETH, treasuryFeeBpsAtInit: 200, ...loan } as LoanDetails,
    claims: [{ seller: ME, grossOwed: 1000n }],
    claimAsset: null,
    held: [{ asset: WETH, amount: 0n }],
    share: null,
    ...over,
  };
}
const code = (v: ReturnType<typeof sellerVerdict>) => (v.state === 'open' ? 'open' : v.state === 'unknown' ? 'unknown' : v.refusals[0]!.code);

describe('seller claim rules', () => {
  it('reads a claim as final only once the loan has ended outside fallback', () => {
    expect([0, 1, 2, 3, 4, 5].map(splitFinal)).toEqual([false, true, true, true, false, true]);
  });

  it('nets a claim of the loan’s fee, rounded as the protocol rounds it', () => {
    expect(netOwed(1000n, 200)).toBe(980n);
    expect(netOwed(999n, 200)).toBe(979n);
  });

  it('nets each claim on its own before summing what a seller is owed', () => {
    const r = row({
      claims: [
        { seller: ME, grossOwed: 101n },
        { seller: OLDER, grossOwed: 50n },
        { seller: ME, grossOwed: 101n },
      ],
    });
    // 98 + 98, where netting the summed 202 would state 197.
    expect(mineNet(r, ME)).toBe(196n);
    const receipt = sellerClaimReceipt(review(r), ME, words, copy);
    expect(receipt.rows[0]!.value).toEqual({ kind: 'amount', asset: WETH, amount: 196n });
    expect(mineNet(row({ claims: null }), ME)).toBeNull();
  });

  it('pays what waits in the vault, and nothing more, while the loan runs', () => {
    expect(code(sellerVerdict(row({ held: [{ asset: WETH, amount: 50n }] }), ME, false, copy, 1))).toBe('open');
    expect(code(sellerVerdict(row(), ME, false, copy, 1))).toBe('NothingToClaimAsSeller');
    expect(sellerVerdict(row(), ME, false, copy, 1).refusals[0]!.reason).toBe('sellerClaim.laterInterest');
    expect(sellerVerdict(row({}, { status: 4 }), ME, false, copy, 1).refusals[0]!.reason).toBe('sellerClaim.fallbackWaits');
  });

  it('stops under the pause and says so when a read failed', () => {
    expect(code(sellerVerdict(row({ held: [{ asset: WETH, amount: 50n }] }), ME, true, copy, 1))).toBe('EnforcedPause');
    expect(code(sellerVerdict(row(), ME, null, copy, 1))).toBe('unknown');
    expect(code(sellerVerdict(row({ held: null }), ME, false, copy, 1))).toBe('unknown');
  });

  it('splits an ended loan’s principal-asset recovery oldest first, and states what stays unpaid', () => {
    const r = row(
      {
        claims: [
          { seller: OLDER, grossOwed: 1000n },
          { seller: ME, grossOwed: 1000n },
        ],
        claimAsset: WETH,
        share: 1500n,
      },
      { status: 1 },
    );
    // Older takes its 980 net first; 520 is left for me of my 980.
    expect(splitPart(r, ME)).toEqual({ kind: 'exact', amount: 520n, unpaid: 460n });
    expect(code(sellerVerdict(r, ME, false, copy, 1))).toBe('open');
    const none = { ...r, share: 980n };
    expect(splitPart(none, ME)).toEqual({ kind: 'exact', amount: 0n, unpaid: 980n });
    expect(sellerVerdict(none, ME, false, copy, 1).refusals[0]!.reason).toBe('sellerClaim.splitNothing');
  });

  it('leaves an in-kind split to the moment it runs, and an unread share unknown', () => {
    expect(splitPart(row({ claimAsset: TLIQ, share: 10n }, { status: 2 }), ME)).toEqual({ kind: 'inKind', asset: TLIQ });
    expect(code(sellerVerdict(row({ claimAsset: TLIQ, share: 10n }, { status: 2 }), ME, false, copy, 1))).toBe('open');
    expect(splitPart(row({ claimAsset: WETH, share: null }, { status: 1 }), ME)).toEqual({ kind: 'unknown' });
    expect(splitPart(row(), ME)).toBeNull();
  });

  it('lists a loan while a claim is open, money waits or a read failed', () => {
    expect(sellerRowShown(row(), ME)).toBe(true);
    expect(sellerRowShown(row({ claims: [] }), ME)).toBe(false);
    expect(sellerRowShown(row({ claims: [], held: [{ asset: WETH, amount: 1n }] }), ME)).toBe(true);
    expect(sellerRowShown(row({ loan: null }), ME)).toBe(true);
    expect(
      mineGross(
        row({
          claims: [
            { seller: ME, grossOwed: 5n },
            { seller: OLDER, grossOwed: 9n },
            { seller: ME, grossOwed: 6n },
          ],
        }),
        ME,
      ),
    ).toBe(11n);
  });
});

describe('seller discovery', () => {
  it('collects every loan the index names, page by page, and says when it stopped short', async () => {
    const pages = [
      { events: [{ loanId: 3 }, { loanId: 5 }], nextBefore: '10:1' },
      { events: [{ loanId: 3 }, { loanId: null }], nextBefore: null },
    ];
    const asked: string[] = [];
    const indexer = { origin: 'x', getJson: async (p: string) => (asked.push(p), pages.shift()) } as never;
    const out = await discoverSoldLoans(indexer, 84532, ME);
    expect(out).toEqual({ loanIds: [3n, 5n], complete: true });
    expect(asked[0]).toContain('actor=' + ME);
    expect(asked[1]).toContain('before=10%3A1');
  });
});

function log(abi: Abi, address: Hex, eventName: string, args: Record<string, unknown>): Log {
  const event = abi.find((e) => e.type === 'event' && e.name === eventName) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const nonIndexed = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(
    nonIndexed,
    nonIndexed.map((i) => args[i.name]),
  );
  return { address, topics: topics as [Hex, ...Hex[]], data } as unknown as Log;
}
const SELLER = SellerClaimFacetABI as Abi;
const ERC20 = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']) as Abi;
const withdrawn = (amount: bigint) => log(SELLER, DIAMOND, 'SellerInterestWithdrawn', { loanId: 7n, seller: ME, asset: WETH, amount });
const closedEv = (paid: bigint, fullyPaid: boolean) =>
  log(SELLER, DIAMOND, 'SellerInterestClaimClosed', { loanId: 7n, seller: ME, grossOwed: 1000n, netOwed: 980n, asset: WETH, paid, credited: paid, fullyPaid });
const transfer = (amount: bigint) => log(ERC20, WETH, 'Transfer', { from: OLDER, to: ME, value: amount });

function review(r: SellerRow, over: Partial<SellerClaimReview> = {}): SellerClaimReview {
  return { identity: '1:0xaa', loanId: 7n, row: r, paused: false, protection: null, route: 'wallet', part: splitPart(r, ME), dryRun: null, verdict: OPEN, readAt: 1, ...over };
}

describe('seller withdrawal record', () => {
  it('reads only this seller’s events on this loan', () => {
    const other = log(SELLER, DIAMOND, 'SellerInterestWithdrawn', { loanId: 8n, seller: ME, asset: WETH, amount: 1n });
    expect(sellerLogs([withdrawn(40n), other, closedEv(520n, false)], DIAMOND, 7n, ME)).toEqual({
      closed: [{ netOwed: 980n, asset: WETH, paid: 520n, credited: 520n, fullyPaid: false }],
      withdrawn: [{ asset: WETH, amount: 40n }],
    });
  });

  it('measures a running loan’s withdrawal against what waited in the vault', () => {
    const r = review(row({ held: [{ asset: WETH, amount: 40n }] }));
    expect(sellerPays(r)).toEqual([{ asset: WETH, amount: 40n }]);
    const legs = measureSellerClaim(r, [withdrawn(40n), transfer(40n)], DIAMOND, ME, words, copy);
    expect(legs.map((l) => l.status)).toEqual(['done']);
    expect(measureSellerClaim(r, [], DIAMOND, ME, words, copy)[0]!.status).toBe('not-done');
  });

  it('measures an ended loan’s split and states a short claim', () => {
    const r = review(
      row(
        {
          claims: [
            { seller: OLDER, grossOwed: 1000n },
            { seller: ME, grossOwed: 1000n },
          ],
          claimAsset: WETH,
          share: 1500n,
        },
        { status: 1 },
      ),
    );
    expect(sellerPays(r)).toEqual([{ asset: WETH, amount: 520n }]);
    const legs = measureSellerClaim(r, [closedEv(520n, false), withdrawn(520n), transfer(520n)], DIAMOND, ME, words, copy);
    expect(legs.map((l) => l.status)).toEqual(['done', 'done']);
    expect(legs[0]!.label).toContain('legClosedShort');
    // A split that paid another figure is said beside the review's.
    const off = measureSellerClaim(r, [closedEv(400n, false), withdrawn(400n), transfer(400n)], DIAMOND, ME, words, copy);
    expect(off[0]!.status).toBe('unknown');
  });

  it('states the owed figure net, the split and what stays unpaid in the receipt', () => {
    const r = review(
      row(
        {
          claims: [
            { seller: OLDER, grossOwed: 1000n },
            { seller: ME, grossOwed: 1000n },
          ],
          claimAsset: WETH,
          share: 1500n,
        },
        { status: 1 },
      ),
    );
    const receipt = sellerClaimReceipt(r, ME, words, copy);
    const labels = receipt.rows.map((x) => x.label);
    expect(labels).toEqual(['sellerClaim.rowOwed{"pct":"2"}', 'sellerClaim.rowSplit', 'sellerClaim.rowUnpaid', 'takeBack.rowTo']);
    expect(receipt.consequences).toContain('sellerClaim.splitNote');
  });
});
