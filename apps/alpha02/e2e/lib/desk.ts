/**
 * Rate Desk spec helpers — shared by 17-rate-desk (book / ticket /
 * amend / cancel, #1129) and 18-rate-desk-chart (chart + History,
 * #1130). Extracted verbatim from spec 17 when spec 18 landed so the
 * two specs can never drift on the market/seeding conventions.
 *
 * Market convention (see spec 17's header note): every desk test
 * trades WETH (lending) against a faucet collateral mock, at a TENOR
 * bucket verified live-empty on the fork first. The on-chain matcher
 * requires exact durationDays equality, so a fresh tenor IS a fresh
 * market: the inherited Base Sepolia book can never leak rows into
 * the ladder under test. Each spec FILE that rests GTC offers owns
 * its own collateral pair — WETH/tLIQ for 17/18, WETH/mUSDC for 19 —
 * see the bucket-budget note at {@link freshTenor}.
 */
import { expect } from '@playwright/test';
import {
  encodeAbiParameters,
  keccak256,
  parseEther,
  parseUnits,
  type Hex,
} from 'viem';
import type { Page } from '@playwright/test';
import { chooseMenuValue, newestOfferIdFor, newestLoanIdFor } from './flows';
import {
  CHAIN_ID,
  DIAMOND,
  DIAMOND_ABI_VIEM,
  ERC20_MIN_ABI,
  MOCKS,
  WETH,
  forkChain,
  pub,
  walletFor,
} from './chain';
import { accountFor, type Role } from './wallets';

export const TLIQ = MOCKS!.liquidToken as `0x${string}`;
/** Second liquid faucet mock (deployments key `liquidToken2`): mUSDC —
 *  18 decimals, $1 USD feed, WETH pool ⇒ classifies Liquid like tLIQ.
 *  Spec 19's collateral leg (see the bucket-budget note at
 *  {@link freshTenor}); read decimals/symbol live in the spec, never
 *  assume. */
export const MUSDC = MOCKS!.liquidToken2 as `0x${string}`;
export const ZERO = '0x0000000000000000000000000000000000000000';

/** Bucket preference for the fresh-tenor pick. 365 is left out to stay
 *  clear of the protocol's offer-duration cap whatever its live value;
 *  30 goes last because it's the app-wide default every other spec
 *  posts into. */
export const BUCKET_PREFERENCE = [60, 90, 14, 180, 7, 30] as const;

/** Tenor buckets with live offers for the pair on the fork right now
 *  (default WETH/tLIQ). The ranked view is active-only; treating its
 *  lazily-expired GTT rows as live is a safe over-approximation — it
 *  can only skip a bucket, never return a false-empty one. */
export async function liveOfferTenors(
  lend: `0x${string}` = WETH,
  coll: `0x${string}` = TLIQ,
): Promise<Set<number>> {
  const [rankings] = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getActiveOffersByAssetPairRanked',
    args: [lend, coll],
  })) as readonly [readonly { durationDays: bigint }[], bigint];
  return new Set(rankings.map((r) => Number(r.durationDays)));
}

/** A tenor bucket for the pair with NO live offers on the fork right
 *  now (default WETH/tLIQ). Each test recomputes, so a previous test's
 *  (or retry's) seeds exclude their bucket automatically.
 *
 *  CROSS-SPEC BUCKET BUDGET: a pair has only the six
 *  {@link BUCKET_PREFERENCE} buckets, shared by EVERY spec that seeds
 *  resting GTC offers into it — plus every retry burns another bucket.
 *  A spec file that rests GTC offers must therefore own its OWN pair:
 *  WETH/tLIQ belongs to specs 17/18; spec 19 trades WETH/mUSDC
 *  ({@link MUSDC}, deployments `liquidToken2`). When a new spec needs
 *  resting desk offers, give it the next untouched pair instead of
 *  squeezing into an owned one — exhaustion throws here, but only at
 *  runtime, in whichever spec runs last. */
export async function freshTenor(
  lend: `0x${string}` = WETH,
  coll: `0x${string}` = TLIQ,
): Promise<number> {
  const live = await liveOfferTenors(lend, coll);
  for (const d of BUCKET_PREFERENCE) if (!live.has(d)) return d;
  throw new Error(
    `every duration bucket for pair ${lend}/${coll} already has live offers on the fork — no fresh market to test in (see freshTenor's bucket-budget note: one pair per resting-GTC spec file)`,
  );
}

/** Direct-write seeding (the lib/seed.ts pattern): approve + createOffer
 *  from the role wallet, mirroring offerSchema's canonical
 *  role-asymmetric payload mapping — lender ships floor rate + open
 *  ceiling with amount = the 10% min-partial default; borrower ships a
 *  rate ceiling + zero floor, single-value amount. GTC + Partial, like
 *  the guided flows. */
export async function seedDeskOffer(opts: {
  role: Role;
  side: 'lend' | 'borrow';
  rateBps: number;
  amountWeth: string;
  /** Collateral amount in WHOLE units of the collateral token (name is
   *  historical — parsed with `collateralDecimals`, tLIQ by default). */
  collateralTliq: string;
  days: number;
  /** Collateral token override (default tLIQ). Pair it with the token's
   *  REAL `collateralDecimals` — read live via `decimals()`, never
   *  assumed — so `collateralTliq` parses to the right base units. */
  collateralAsset?: `0x${string}`;
  collateralDecimals?: number;
}): Promise<bigint> {
  const account = accountFor(opts.role);
  const wallet = walletFor(account);
  const collateralAsset = opts.collateralAsset ?? TLIQ;
  const amount = parseEther(opts.amountWeth);
  const collateral = parseUnits(opts.collateralTliq, opts.collateralDecimals ?? 18);
  const isLend = opts.side === 'lend';
  // Escrowed leg per side: lender pre-vaults amountMax of the lending
  // asset; borrower pre-vaults collateralAmountMax of the collateral.
  const [token, locked] = isLend
    ? [WETH, amount]
    : ([collateralAsset, collateral] as const);
  const approveHash = await wallet.writeContract({
    address: token,
    abi: ERC20_MIN_ABI,
    functionName: 'approve',
    args: [DIAMOND, locked],
    account,
    chain: forkChain,
  });
  await pub.waitForTransactionReceipt({ hash: approveHash });
  const params = {
    offerType: isLend ? 0 : 1,
    lendingAsset: WETH,
    amount: isLend ? (amount / 10n > 0n ? amount / 10n : 1n) : amount,
    interestRateBps: isLend ? BigInt(opts.rateBps) : 0n,
    collateralAsset,
    collateralAmount: collateral,
    durationDays: BigInt(opts.days),
    assetType: 0,
    tokenId: 0n,
    quantity: 1n,
    creatorRiskAndTermsConsent: true,
    prepayAsset: ZERO,
    collateralAssetType: 0,
    collateralTokenId: 0n,
    collateralQuantity: 0n,
    allowsPartialRepay: true,
    amountMax: amount,
    interestRateBpsMax: isLend ? 10_000n : BigInt(opts.rateBps),
    collateralAmountMax: collateral,
    periodicInterestCadence: 0,
    expiresAt: 0n, // GTC
    fillMode: 0, // Partial
    allowsPrepayListing: false,
    allowsParallelSale: false,
    refinanceTargetLoanId: 0n,
    useFullTermInterest: false,
  };
  const hash = await wallet.writeContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'createOffer',
    args: [params],
    account,
    chain: forkChain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return newestOfferIdFor(account.address);
}

export async function getOffer(offerId: bigint): Promise<Record<string, unknown>> {
  return (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getOffer',
    args: [offerId],
  })) as Record<string, unknown>;
}

/** Load the WETH/`coll` market (default tLIQ) via the header's
 *  CUSTOM-pair branch — deterministic even before anything is seeded
 *  (the markets summary only lists pairs with live offers). The
 *  dropdown selection path is exercised separately by spec 17's
 *  ticket test. */
export async function openMarketViaCustomPair(
  page: Page,
  days: number,
  coll: `0x${string}` = TLIQ,
): Promise<void> {
  await page.goto('/desk', { waitUntil: 'domcontentloaded' });
  await chooseMenuValue(page, 'desk-pair', '__custom__');
  await page.locator('#desk-custom-lend').fill(WETH);
  await page.locator('#desk-custom-coll').fill(coll);
  await page.getByRole('button', { name: 'Load market' }).click();
  await selectTenor(page, days);
}

/** Tenor chips are scoped to the header's "Term" group — the ticket's
 *  expiry chips reuse the '7d' label. */
export async function selectTenor(page: Page, days: number): Promise<void> {
  await page
    .getByRole('group', { name: 'Term' })
    .getByRole('button', { name: `${days}d`, exact: true })
    .click();
}

// ---------------------------------------------------------------------------
// Direct-write loan lifecycle (Rate Desk phase 2, #1130) — the chart /
// History specs need FILLS (initiated loans), and driving the guided
// accept UI per fill would spend the whole test budget on flows specs
// 03/04 already cover. These write the same transactions the app does.
// ---------------------------------------------------------------------------

/** EIP-712 AcceptTerms type — a verbatim copy of the app's
 *  ACCEPT_TERMS_TYPES (src/contracts/useAcceptTerms.ts); field ORDER +
 *  types must match `LibAcceptTerms.ACCEPT_TERMS_TYPEHASH` exactly or
 *  the recovered signature won't match on-chain. Keep in sync. */
const ACCEPT_TERMS_TYPES = {
  AcceptTerms: [
    { name: 'acceptor', type: 'address' },
    { name: 'offerCreator', type: 'address' },
    { name: 'offerKey', type: 'bytes32' },
    { name: 'offerType', type: 'uint8' },
    { name: 'lendingAsset', type: 'address' },
    { name: 'collateralAsset', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'collateralAmount', type: 'uint256' },
    { name: 'interestRateBps', type: 'uint256' },
    { name: 'durationDays', type: 'uint256' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'collateralTokenId', type: 'uint256' },
    { name: 'quantity', type: 'uint256' },
    { name: 'collateralQuantity', type: 'uint256' },
    { name: 'assetType', type: 'uint8' },
    { name: 'collateralAssetType', type: 'uint8' },
    { name: 'prepayAsset', type: 'address' },
    { name: 'useFullTermInterest', type: 'bool' },
    { name: 'allowsPartialRepay', type: 'bool' },
    { name: 'allowsPrepayListing', type: 'bool' },
    { name: 'allowsParallelSale', type: 'bool' },
    { name: 'refinanceTargetLoanId', type: 'uint256' },
    { name: 'linkedLoanId', type: 'uint256' },
    { name: 'parallelSaleOrderHash', type: 'bytes32' },
    { name: 'periodicInterestCadence', type: 'uint8' },
    { name: 'riskAndTermsConsent', type: 'bool' },
    { name: 'acknowledgedIlliquidLendingAsset', type: 'address' },
    { name: 'acknowledgedIlliquidCollateralAsset', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'riskTermsHash', type: 'bytes32' },
  ],
} as const;

const ZERO_HASH =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;

function randomNonce(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let nonce = 0n;
  for (const b of bytes) nonce = (nonce << 8n) | BigInt(b);
  return nonce;
}

/** Direct-write accept of an ERC-20/ERC-20 LENDER offer (the shape
 *  seedDeskOffer creates on the lend side): approve the collateral,
 *  sign the canonical AcceptTerms bound to the LIVE getOffer fields
 *  (mirroring useAcceptTerms' lender-offer mapping — amountMax +
 *  interestRateBps are the endpoints a direct accept binds), send
 *  acceptOffer. Returns the initiated loan id. */
export async function acceptOfferDirect(
  role: Role,
  offerId: bigint,
): Promise<bigint> {
  const account = accountFor(role);
  const wallet = walletFor(account);
  const o = await getOffer(offerId);

  // The acceptor of a lender offer locks the collateral leg.
  const approveHash = await wallet.writeContract({
    address: o.collateralAsset as `0x${string}`,
    abi: ERC20_MIN_ABI,
    functionName: 'approve',
    args: [DIAMOND, o.collateralAmountMax as bigint],
    account,
    chain: forkChain,
  });
  await pub.waitForTransactionReceipt({ hash: approveHash });

  // The chain clock judges the signature deadline — never Date.now()
  // (evm_increaseTime moves the fork far from wall time).
  const chainNow = (await pub.getBlock({ blockTag: 'latest' })).timestamp;
  const linkedLoanId = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getOfferLinkedLoanId',
    args: [offerId],
  })) as bigint;
  // #730 risk-terms anchor — read live like the app; only a Diamond
  // without the getter at all falls back to the zero hash.
  let riskTermsHash: Hex = ZERO_HASH;
  try {
    riskTermsHash = (await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getCurrentRiskTermsHash',
    })) as Hex;
  } catch {
    /* selector absent on this deploy — zero hash is the correct ack */
  }

  const terms = {
    acceptor: account.address,
    offerCreator: o.creator as `0x${string}`,
    // Direct-accept offerKey is keccak256(abi.encode(offerId)).
    offerKey: keccak256(encodeAbiParameters([{ type: 'uint256' }], [offerId])),
    offerType: Number(o.offerType),
    lendingAsset: o.lendingAsset as `0x${string}`,
    collateralAsset: o.collateralAsset as `0x${string}`,
    // ERC-20 LENDER offer endpoints (OfferAcceptFacet._bindTermsToOffer):
    // amountMax + the floor rate.
    amount: o.amountMax as bigint,
    collateralAmount: o.collateralAmount as bigint,
    interestRateBps: o.interestRateBps as bigint,
    durationDays: o.durationDays as bigint,
    tokenId: o.tokenId as bigint,
    collateralTokenId: o.collateralTokenId as bigint,
    quantity: o.quantity as bigint,
    collateralQuantity: o.collateralQuantity as bigint,
    assetType: Number(o.assetType),
    collateralAssetType: Number(o.collateralAssetType),
    prepayAsset: o.prepayAsset as `0x${string}`,
    useFullTermInterest: Boolean(o.useFullTermInterest),
    allowsPartialRepay: Boolean(o.allowsPartialRepay),
    allowsPrepayListing: Boolean(o.allowsPrepayListing),
    allowsParallelSale: Boolean(o.allowsParallelSale),
    refinanceTargetLoanId: o.refinanceTargetLoanId as bigint,
    linkedLoanId,
    parallelSaleOrderHash: o.parallelSaleOrderHash as Hex,
    periodicInterestCadence: Number(o.periodicInterestCadence),
    riskAndTermsConsent: true,
    acknowledgedIlliquidLendingAsset: o.lendingAsset as `0x${string}`,
    acknowledgedIlliquidCollateralAsset: o.collateralAsset as `0x${string}`,
    nonce: randomNonce(),
    deadline: chainNow + 1800n,
    riskTermsHash,
  };
  const signature = await account.signTypedData({
    domain: {
      name: 'Vaipakam AcceptOffer',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: DIAMOND as `0x${string}`,
    },
    types: ACCEPT_TERMS_TYPES,
    primaryType: 'AcceptTerms',
    message: terms,
  });
  const hash = await wallet.writeContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'acceptOffer',
    args: [offerId, terms, signature],
    account,
    chain: forkChain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return newestLoanIdFor(account.address, 'borrower');
}

/** Direct-write full repayment: approve the contract's own settlement
 *  figure (×2 pad — interest accrues per-second and repayLoan pulls
 *  the recomputed amount; only the owed amount is transferred, the pad
 *  is never spent), then repayLoan, then assert the terminal status
 *  on-chain so a silent revert can't pass as a repay. */
export async function repayLoanInFull(role: Role, loanId: bigint): Promise<void> {
  const account = accountFor(role);
  const wallet = walletFor(account);
  const loan = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [loanId],
  })) as { principalAsset: `0x${string}` };
  const owed = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'calculateRepaymentAmount',
    args: [loanId],
  })) as bigint;
  const approveHash = await wallet.writeContract({
    address: loan.principalAsset,
    abi: ERC20_MIN_ABI,
    functionName: 'approve',
    args: [DIAMOND, owed * 2n],
    account,
    chain: forkChain,
  });
  await pub.waitForTransactionReceipt({ hash: approveHash });
  const hash = await wallet.writeContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'repayLoan',
    args: [loanId],
    account,
    chain: forkChain,
  });
  await pub.waitForTransactionReceipt({ hash });
  const after = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [loanId],
  })) as { status: number };
  expect(Number(after.status)).toBe(1); // LoanStatus.Repaid
}
