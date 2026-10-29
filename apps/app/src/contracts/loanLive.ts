/**
 * Live loan reads for submit paths and money-critical display — ONE
 * definition of the getLoanDetails shape the UI consumes, so the
 * Solidity struct evolving can't silently strand a stale hand-written
 * cast in one of several files (the casts are unchecked `as`).
 */
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import {
  interestTermEnd,
  pausedSecondsBetween,
  readPauseLog,
  type PauseLog,
} from '@vaipakam/lib/loanClock';

/** LibVaipakam.LoanStatus.Active — first enum member. */
export const LOAN_STATUS_ACTIVE = 0;

/** The subset of LibVaipakam.Loan the UI reads live. */
export interface LoanLive {
  /** LibVaipakam.LoanStatus as a number (Active = 0). */
  status: number;
  /** The stored lender. For a sale-listed loan, `createLoanSaleOffer`
   *  consolidated this to the current lender-NFT holder at listing
   *  (#951 D1/D2) — it is the seller a buy would pay. */
  lender: `0x${string}`;
  /** The ORIGINAL borrower stored at init — NOT the current
   *  borrower-NFT holder. Carry-over refinance binds to this. */
  borrower: `0x${string}`;
  /** The borrower-side position NFT — `ownerOf(borrowerTokenId)` is
   *  the CURRENT borrower every self-dealing guard keys on. */
  borrowerTokenId: bigint;
  principal: bigint;
  principalAsset: `0x${string}`;
  interestRateBps: bigint;
  startTime: bigint;
  /** Term fields come from HERE for any time gate — a term-resetting
   *  position transfer re-stamps them on-chain while the indexer row
   *  still carries the old values. */
  durationDays: bigint;
  interestAccrualStart: bigint;
  /** Remaining committed interest term, re-stamped by partials. Read
   *  via {@link interestRemainingDaysOf}, never directly — the raw
   *  field is only meaningful when `interestAccrualStart != 0`. */
  interestRemainingDays: number;
  useFullTermInterest: boolean;
  allowsPartialRepay: boolean;
  /** LibVaipakam.PeriodicInterestCadence as a number (None = 0). */
  periodicInterestCadence: number;
  /** Interest ALREADY paid to the lender (periodic deductions,
   *  partial repayments). The settlement paths credit this against
   *  gross accrual, so any cost mirror must subtract it or it
   *  overstates the pull (Codex #1500 r4). */
  interestSettled: bigint;
  /** #1209 — the interest the current holder has earned and not yet been
   *  paid, as `SellerClaimFacet.getInterestLedger(loanId)` reports it at the
   *  snapshot's block. A sale does not forfeit it: it becomes the seller's
   *  claim on the loan, paid from the borrower's later interest ahead of the
   *  buyer. This client holds no copy of the ledger rule; it shows the chain's
   *  figure.
   *
   *  Optional: absent means the read FAILED, which includes a Diamond that
   *  predates the ledger. A seller quote on such a Diamond is unavailable
   *  rather than guessed, because that Diamond still prices the sale under the
   *  retired forfeiture rule. */
  sellerClaimOnSale?: bigint;
  /** Timestamp of the block this whole snapshot was read at.
   *
   *  Carried so a caller cannot pair these fields with a `chainNow` from a
   *  DIFFERENT block (#1801 r8). The contract reads were pinned at round 6 and
   *  the timestamp was not, which left the same torn-pair hazard one field
   *  further out — and `sellerEconomics` combines exactly those. */
  readAtTimestamp: bigint;
  /** The protocol's pause-interval log, read at the same block (#2808). Every
   *  deadline below is the D2 loan clock's (#668 / #935): the original one
   *  moved by the paused time since the loan's start. Empty on a Diamond
   *  without the loan clock, which never moves a deadline. */
  pauseLog: PauseLog;
  // Collateral identity — a refinance-tagged offer must repeat these
  // EXACTLY for the collateral to carry over instead of re-pledging.
  collateralAsset: `0x${string}`;
  /** LibVaipakam.AssetType as a number (ERC20 = 0). */
  collateralAssetType: number;
  collateralAmount: bigint;
  collateralTokenId: bigint;
  collateralQuantity: bigint;
  prepayAsset: `0x${string}`;
}

/** Mirrors LibVaipakam.interestRemainingDaysOf: the dedicated
 *  remaining-term field (re-stamped by partials) when the #641
 *  interest clock is present, else the immutable term. */
export function interestRemainingDaysOf(live: LoanLive): bigint {
  return live.interestAccrualStart !== 0n
    ? BigInt(live.interestRemainingDays)
    : live.durationDays;
}

/** Mirrors LibVaipakam.interestAccrualStartOf: the #641 interest
 *  clock's origin (re-stamped by partials), falling back to the
 *  immutable start for pre-field loans. */
export function interestAccrualStartOf(live: LoanLive): bigint {
  return live.interestAccrualStart !== 0n
    ? live.interestAccrualStart
    : live.startTime;
}

/** The loan's ORIGINAL maturity, `startTime + durationDays` — what the loan
 *  was opened with and what its originally announced due date says. Never a
 *  deadline the chain enforces once the protocol has been paused; read
 *  {@link loanEndTimeOf} for that. Shown beside it when a pause moved it. */
export function originalLoanEndTimeOf(live: LoanLive): bigint {
  return live.startTime + live.durationDays * 86_400n;
}

/** Paused time since the loan's start, as of `at` (default: the snapshot's
 *  block) — `LibLoanClock.pauseCredit`. */
export function pauseCreditOf(live: LoanLive, at: bigint = live.readAtTimestamp): bigint {
  return pausedSecondsBetween(live.pauseLog, live.startTime, at);
}

/** The loan's EFFECTIVE maturity as of `at` — `LibLoanClock.maturity`: the
 *  original one moved by the paused time since the start. The reference every
 *  late-fee, grace and listing computation keys on (#668 / #935, #2808).
 *  `at` defaults to the snapshot's block; a later moment counts a pause still
 *  in force up to it, and cannot know about a pause that has not begun. */
export function loanEndTimeOf(live: LoanLive, at: bigint = live.readAtTimestamp): bigint {
  return originalLoanEndTimeOf(live) + pauseCreditOf(live, at);
}

/** Seconds of the interest term left at `at` — `LibLoanClock
 *  .remainingInterestSeconds`: the interest clock's end, moved by the paused
 *  time since THAT clock started, minus `at`. What a sale, a transfer and an
 *  offset price their rate difference over. */
export function remainingInterestSecondsOf(live: LoanLive, at: bigint): bigint {
  const end = interestTermEnd(
    {
      interestAccrualStart: interestAccrualStartOf(live),
      interestRemainingDays: interestRemainingDaysOf(live),
    },
    live.pauseLog,
    at,
  );
  return end > at ? end - at : 0n;
}

/** Mirrors LibVaipakam.calculateLateFee for ERC-20 loans: 0 at or
 *  before the EFFECTIVE maturity, then 1% of principal + 0.5% per WHOLE
 *  day late, capped at 5%. Both the repay and the #1189 preclose/refinance
 *  grace-window paths charge exactly this. */
export function lateFeeAt(live: LoanLive, ts: bigint): bigint {
  const endTime = loanEndTimeOf(live, ts);
  if (ts <= endTime) return 0n;
  const daysLate = (ts - endTime) / 86_400n;
  let feeBps = 100n + daysLate * 50n;
  if (feeBps > 500n) feeBps = 500n;
  return (live.principal * feeBps) / 10_000n;
}

/** The refinance old-lender payoff AS OF `asOf` (chain time). The
 *  facet pays `settlementInterestNet(oldLoan, now)` + the #1189
 *  grace-window late fee, and that settlement interest is
 *  `max(whole days elapsed since the interest clock, remaining
 *  committed term)` — i.e. the full-term floor in term, but PAST
 *  maturity it keeps accruing with elapsed time (Codex #1256 r1).
 *  This mirror applies the remaining-term floor in BOTH interest
 *  modes (exact for full-term loans; over-covers a pro-rata loan —
 *  the pull only shrinks) and stays gross of `interestSettled`
 *  (again over-covers only). ONE definition — the review quote, the
 *  pending watch, and the funding checks must never drift apart. */
export function refinancePayoffOf(live: LoanLive, asOf: bigint): bigint {
  const start = interestAccrualStartOf(live);
  const elapsedDays = asOf > start ? (asOf - start) / 86_400n : 0n;
  const floorDays = interestRemainingDaysOf(live);
  const days = elapsedDays > floorDays ? elapsedDays : floorDays;
  return (
    live.principal +
    (live.principal * live.interestRateBps * days) / (365n * 10_000n) +
    lateFeeAt(live, asOf)
  );
}

/** #3042 — what a refinance accept takes from the holder's WALLET at
 *  `asOf`. The accept and the payoff are one transaction: the new
 *  lender's principal, less the borrower's initiation fee, goes straight
 *  to the old lender, and only the rest of the payoff is pulled from the
 *  wallet. So the pull is the payoff minus that net principal, which is
 *  the old loan's interest (and any late fee) plus the new loan's
 *  initiation fee.
 *
 *  The fee is taken at the LIVE `loanInitiationFeeBps` with no discount,
 *  so this is the MOST the accept can pull: a borrower hold-tier discount
 *  only lowers the fee, which raises the net principal and lowers the
 *  pull. A governance raise of the fee rate after posting raises the
 *  pull above an approval made before it; the pending card recomputes
 *  this with the live rate and asks for a fresh approval. */
export function refinanceWalletPullOf(
  live: LoanLive,
  opts: { requestAmount: bigint; loanInitiationFeeBps: number },
  asOf: bigint,
): bigint {
  const fee = (opts.requestAmount * BigInt(opts.loanInitiationFeeBps)) / 10_000n;
  const netPrincipal = opts.requestAmount - fee;
  const payoff = refinancePayoffOf(live, asOf);
  // The contract refuses a net principal above the old lender's due, and
  // the request amount never exceeds the old principal, so this cannot go
  // negative; clamp anyway rather than approve a negative figure.
  return payoff > netPrincipal ? payoff - netPrincipal : 0n;
}

/** The standing-approval target for a refinance request: the wallet
 *  pull (`refinanceWalletPullOf`) at the LAST moment the request is
 *  still fillable — the earlier of its own expiry and the end of the
 *  loan's grace window (a lender can accept any time up to then, and the
 *  accept-time payoff includes the late fee AND the still-accruing grace
 *  interest AT THAT TIME, #1189/#1236). Approving only today's figure
 *  would strand an otherwise-valid request the moment the loan crosses
 *  maturity; approving this bound covers the most the contract can ever
 *  pull from the wallet for THIS request, and since #3042 that is only
 *  the part of the payoff the new principal does not cover.
 *  `expiresAt === 0` means no offer-level expiry — the grace end alone
 *  bounds it. */
export function refinanceApprovalOf(
  live: LoanLive,
  opts: {
    expiresAt: bigint;
    graceSeconds: bigint;
    requestAmount: bigint;
    loanInitiationFeeBps: number;
  },
): bigint {
  // The effective grace end at the snapshot. A pause that begins later moves
  // it, and the contract's pull with it — an intrinsic race this bound cannot
  // see; the request then needs a fresh approval, never a short-paid lender.
  const graceEnd = loanEndTimeOf(live) + opts.graceSeconds;
  // acceptOffer rejects at ts >= expiresAt, so the last fillable
  // moment under the offer's own clock is expiresAt - 1.
  const lastFillable =
    opts.expiresAt > 0n && opts.expiresAt - 1n < graceEnd
      ? opts.expiresAt - 1n
      : graceEnd;
  return refinanceWalletPullOf(live, opts, lastFillable);
}

/** Mirror LibVaipakam.SECONDS_PER_YEAR / BASIS_POINTS. */
export const SECONDS_PER_YEAR = 365n * 86_400n;
export const BASIS_POINTS = 10_000n;

/** Mirrors LibVaipakam.MIN_OFFER_CANCEL_DELAY — cancels inside this
 *  window revert CancelCooldownActive. Protocol-wide (any offer),
 *  not specific to any one flow. */
export const CANCEL_COOLDOWN_SECONDS = 300n;

/** Mirrors LibVaipakam.MIN_SALE_LISTING_SECONDS — a sale listing's
 *  minimum window (1 hour). `_boundListingExpiry` clamps every window
 *  at the loan's maturity and refuses a clamped window below this
 *  minimum, so a loan within an hour of maturity cannot be listed. */
export const MIN_SALE_LISTING_SECONDS = 3_600n;

/** Seller economics of selling a lender position into a buy offer —
 *  one definition for the picker rows, the review receipt, and the
 *  submit re-check. Mirrors EarlyWithdrawalDirectFacet's net settlement TO
 *  THE WEI: seconds-precision, remaining = remaining-term seconds, and the
 *  shortfall computed as the DIFFERENCE OF THE TWO FLOORED remaining-interest
 *  figures (not one floored difference).
 *
 *  Since #1209 the seller's only cost is that shortfall (the buyer's higher
 *  rate over the remaining term). The interest the seller earned is NOT a
 *  cost: it becomes their claim on the loan (`claim`), paid later from the
 *  borrower's interest, ahead of the buyer and after the buyer's principal on
 *  a default. */
/** The seller quote cannot be computed: the interest ledger could not be
 *  read (or the Diamond predates it). Callers must surface this as
 *  unavailable — never as zero (#1801 r8). */
export class SellerQuoteUnavailableError extends Error {
  constructor() {
    super('seller quote unavailable');
    this.name = 'SellerQuoteUnavailableError';
  }
}

export function sellerEconomics(
  live: LoanLive,
  buyRateBps: bigint,
): {
  cost: bigint;
  toSeller: bigint;
  /** True when a rate shortfall is deducted from the seller's payout. */
  shortfallBinding: boolean;
  /** The interest the seller keeps as a claim on the loan (not paid now). */
  claim: bigint;
  shortfall: bigint;
} {
  // The clock is the SNAPSHOT's, and callers cannot supply their own (Codex
  // #1801 r9 P2): a parameter that must always be one value should not be a
  // parameter.
  const chainNow = live.readAtTimestamp;
  // The remaining term runs to the pause-moved end (#668 / #935).
  const remainingSecs = remainingInterestSecondsOf(live, chainNow);
  const denom = SECONDS_PER_YEAR * BASIS_POINTS;
  // An unreadable ledger is refused, not guessed: a Diamond without it still
  // charges the retired forfeiture, which this client no longer models.
  if (live.sellerClaimOnSale === undefined) throw new SellerQuoteUnavailableError();
  const originalRemaining =
    (live.principal * live.interestRateBps * remainingSecs) / denom;
  const newRemaining = (live.principal * buyRateBps * remainingSecs) / denom;
  const shortfall =
    newRemaining > originalRemaining ? newRemaining - originalRemaining : 0n;
  const cost = shortfall;
  return {
    cost,
    toSeller: live.principal > cost ? live.principal - cost : 0n,
    shortfallBinding: shortfall > 0n,
    claim: live.sellerClaimOnSale,
    shortfall,
  };
}

/** What the BUYER of a sale-listed lender position stands to earn if
 *  the borrower repays at maturity: the sale rate applied to the
 *  remaining interest-window seconds — the exact `saleRemainingInterest`
 *  figure `completeLoanSale` settles against, never a fresh-term
 *  projection (the term is part-elapsed; the buyer only earns from
 *  now). One definition so the buy review and any future quote can't
 *  drift from the facet. */
export function saleBuyerRemainingInterest(
  live: LoanLive,
  saleRateBps: bigint,
  chainNow: bigint,
): bigint {
  // The remaining term runs to the pause-moved end (#668 / #935).
  const remainingSecs = remainingInterestSecondsOf(live, chainNow);
  return (
    (live.principal * saleRateBps * remainingSecs) /
    (SECONDS_PER_YEAR * BASIS_POINTS)
  );
}

/** Borrower economics of handing the loan to a replacement borrower
 *  via `transferObligationViaOffer` (preclose Option 2) — one
 *  definition for the offer-picker rows, the review receipt, and the
 *  submit re-check. Mirrors PrecloseFacet's transfer settlement:
 *  seconds-precision, elapsed measured from the #641 interest clock,
 *  accrued = pro-rata to now at the LOAN's rate, and the shortfall
 *  bridging the staying lender back to their original entitlement
 *  when the replacement offer's expected interest is lower:
 *  `max(0, remaining@loanRate − offerTerm@offerRate)`. Accrued is NET
 *  of `interestSettled`, applying the same saturating credit the
 *  facet does, so a periodic loan's already-paid interest is not
 *  charged twice (Codex #1500 r4). */
export function transferEconomicsOf(
  live: LoanLive,
  offerRateBps: bigint,
  offerDurationDays: bigint,
  chainNow: bigint,
): { accrued: bigint; shortfall: bigint; total: bigint } {
  const start = interestAccrualStartOf(live);
  const elapsed = chainNow > start ? chainNow - start : 0n;
  // The remaining term runs to the pause-moved end (#668 / #935); accrual
  // above is plain elapsed time, pause included, as the facet charges it.
  const remainingSecs = remainingInterestSecondsOf(live, chainNow);
  const denom = SECONDS_PER_YEAR * BASIS_POINTS;
  const grossAccrued = (live.principal * live.interestRateBps * elapsed) / denom;
  // Mirror LibEntitlement.creditSettledInterest: the facet subtracts
  // interest already paid (periodic deductions / partials), saturating
  // at zero. Without this the quote — and the submit balance gate —
  // overstate the pull on a periodic loan and can reject a wallet that
  // actually holds enough (Codex #1500 r4).
  const accrued =
    grossAccrued > live.interestSettled ? grossAccrued - live.interestSettled : 0n;
  const originalRemaining =
    (live.principal * live.interestRateBps * remainingSecs) / denom;
  const newRemaining =
    (live.principal * offerRateBps * offerDurationDays * 86_400n) / denom;
  const shortfall =
    originalRemaining > newRemaining ? originalRemaining - newRemaining : 0n;
  return { accrued, shortfall, total: accrued + shortfall };
}

/** The standing-approval bound for the offset path's COMPLETION pull
 *  (preclose Option 3). When the linked offer is accepted, the
 *  contract pulls `principal + accrued + shortfall` from the
 *  borrower's wallet — and since accrued-to-completion plus the
 *  rate-shortfall can never exceed the full remaining committed term
 *  at the loan's own rate (they cover complementary slices of that
 *  window), `principal + remaining-term interest` bounds the pull
 *  exactly. Completion is contract-blocked at/after maturity (the
 *  anti-drift guard), so no late-fee headroom is needed.
 *
 *  The window is the committed term PLUS the paused time since the interest
 *  clock started (#668 / #935): accrual counts paused seconds, and the
 *  remaining term runs to the pause-moved end, so together they cover both.
 *  A pause that begins after this snapshot widens the window again — an
 *  intrinsic race the bound cannot see; completion then needs a fresh
 *  approval, never a short-paid lender. */
export function offsetCompletionBoundOf(live: LoanLive): bigint {
  const start = interestAccrualStartOf(live);
  const windowSecs =
    interestRemainingDaysOf(live) * 86_400n +
    pausedSecondsBetween(live.pauseLog, start, live.readAtTimestamp);
  return (
    live.principal +
    (live.principal * live.interestRateBps * windowSecs) / (SECONDS_PER_YEAR * BASIS_POINTS)
  );
}

export async function readLoanLive(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
  loanId: number | bigint,
  /** Read at this block instead of the latest. */
  blockNumber?: bigint,
): Promise<LoanLive> {
  // Two reads, one round trip. The interest ledger (#1808) lives in appended
  // Diamond storage with no field on the loan struct, so `getLoanDetails`
  // cannot carry it.
  //
  // The second read FAILS SOFT (Codex #1801 r4 P1). A Diamond that predates
  // the ledger does not route `getInterestLedger` and reverts, and because
  // `readLoanLive` backs position details, repay, refinance, offset, sale and
  // verification alike, letting that rejection propagate would take every one
  // of those flows down. Absent means unknown: only the seller quote refuses.
  //
  // Deliberately broad: `Promise.allSettled` treats ANY failure of the optional
  // read as absent. Narrowing to the missing-selector revert would mean
  // matching on provider-specific error text, and the public Base-Sepolia RPCs
  // are exactly the ones that rewrite reverts into generic gas errors — the
  // #1521-era failure mode. The mandatory read still rejects normally, so a
  // genuine outage is not hidden.
  // Both reads are PINNED TO ONE BLOCK (Codex #1801 r6 P2). Two independent
  // `eth_call`s can resolve against different latest blocks when a mutation is
  // mined between them, and the pair they return is then a state that never
  // existed — `getLoanDetails` at the pre-partial principal beside a
  // post-partial ledger, say. `sellerEconomics` combines exactly these two, so a
  // torn pair does not merely go stale, it produces a figure no block ever
  // supported.
  //
  // The TIMESTAMP is pinned to the same block too (Codex #1801 r8 P2). Round 6
  // pinned the two contract reads and left callers taking `chainNow` from their
  // own `getBlock({ blockTag: 'latest' })`, so a block mined in between gave
  // `sellerEconomics` a timestamp from N beside a loan from N+1 — a torn pair
  // again, one field further out. The snapshot now carries the timestamp of the block it
  // was read at, so a caller cannot combine it with a different one.
  const atBlock = await publicClient.getBlock(
    blockNumber !== undefined ? { blockNumber } : { blockTag: 'latest' },
  );
  const at = atBlock.number;
  const [rawResult, ledgerResult, pauseLogResult] = await Promise.allSettled([
    publicClient.readContract({
      address: diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getLoanDetails',
      args: [BigInt(loanId)],
      blockNumber: at,
    }) as Promise<LoanLive>,
    publicClient.readContract({
      address: diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getInterestLedger',
      args: [BigInt(loanId)],
      blockNumber: at,
    }) as Promise<readonly [bigint, bigint, bigint, readonly unknown[]]>,
    // MANDATORY, like the loan itself (#2808): every deadline on this record
    // is the loan clock's, and a log that could not be read is not "never
    // paused" — treating it so would show an early deadline as current. A
    // Diamond without the loan clock answers an empty log, definitively.
    readPauseLog({ client: publicClient, diamond: diamondAddress, blockNumber: at }),
  ]);
  if (rawResult.status === 'rejected') throw rawResult.reason;
  if (pauseLogResult.status === 'rejected') throw pauseLogResult.reason;
  const raw = rawResult.value;
  return {
    readAtTimestamp: atBlock.timestamp,
    pauseLog: pauseLogResult.value,
    // A FAILED read is "unknown", never zero (Codex #1801 r8 P2): a seller
    // quote built on it is unavailable, not free.
    sellerClaimOnSale:
      ledgerResult.status === 'fulfilled' ? ledgerResult.value[0] : undefined,
    status: Number(raw.status),
    lender: raw.lender,
    borrower: raw.borrower,
    borrowerTokenId: raw.borrowerTokenId,
    principal: raw.principal,
    principalAsset: raw.principalAsset,
    interestRateBps: raw.interestRateBps,
    startTime: raw.startTime,
    durationDays: raw.durationDays,
    interestAccrualStart: raw.interestAccrualStart,
    interestRemainingDays: Number(raw.interestRemainingDays),
    useFullTermInterest: Boolean(raw.useFullTermInterest),
    allowsPartialRepay: Boolean(raw.allowsPartialRepay),
    periodicInterestCadence: Number(raw.periodicInterestCadence),
    interestSettled: raw.interestSettled ?? 0n,
    collateralAsset: raw.collateralAsset,
    collateralAssetType: Number(raw.collateralAssetType),
    collateralAmount: raw.collateralAmount,
    collateralTokenId: raw.collateralTokenId,
    collateralQuantity: raw.collateralQuantity,
    prepayAsset: raw.prepayAsset,
  };
}

/** The contract's own settlement figure (`calculateRepaymentAmount`)
 *  — routed through settlementInterestNet, so it already handles the
 *  full-term floor (max(elapsed, remaining)), interest already
 *  settled by partials/periodic, late fees, and CHAIN time. Both the
 *  repay and preclose paths pull per this math; quoting anything
 *  hand-derived risks drifting from what is actually charged. */
export async function readRepaymentDueLive(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
  loanId: number | bigint,
): Promise<bigint> {
  return (await publicClient.readContract({
    address: diamondAddress,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'calculateRepaymentAmount',
    args: [BigInt(loanId)],
  })) as bigint;
}
