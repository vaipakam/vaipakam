/**
 * Offer / accept / accounting helpers shared by every scenario.
 *
 * Two things here are load-bearing and easy to get wrong by hand:
 *
 *  - The EIP-712 `AcceptTerms` struct is 34 fields and the ACCEPTOR signs it.
 *    Its field list is DERIVED from the compiled ABI rather than transcribed
 *    (see `ACCEPT_TERMS_FIELDS`), so it cannot drift. Its `offerKey` is
 *    `keccak256(abi.encode(uint256 offerId))` on a direct accept — a zero key
 *    is accepted by the encoder and then refused on-chain as
 *    `OfferTermsMismatch(1)`, which reads like a terms bug rather than a
 *    missing key.
 *  - Expiries and deadlines are taken from the CHAIN's block timestamp, not
 *    from wall-clock time. Scenarios warp the fork weeks forward to reach the
 *    default path, after which a wall-clock expiry is already in the past and
 *    every later offer dies on `OfferExpiryInPast`.
 */
import { keccak256, encodeAbiParameters } from 'viem';
import {
  DIAMOND,
  ERC20,
  MOCKS,
  abi,
  chainNow,
  f18,
  forkChain,
  parseUnits,
  pub,
  tx,
  walletFor,
} from './chain.mjs';
import { simulate } from './errors.mjs';
import { check, expectLedger, requireEnvelope } from './report.mjs';

export const ZERO = '0x0000000000000000000000000000000000000000';
export const BYTES32_ZERO = `0x${'0'.repeat(64)}`;

export const ABIS = {
  offerCreate: abi('OfferCreateFacet'),
  offerAccept: abi('OfferAcceptFacet'),
  loan: abi('LoanFacet'),
  metrics: abi('MetricsFacet'),
  risk: abi('RiskFacet'),
  repay: abi('RepayFacet'),
  vaultFactory: abi('VaultFactoryFacet'),
  claim: abi('ClaimFacet'),
  defaulted: abi('DefaultedFacet'),
  preclose: abi('PrecloseFacet'),
  partialWithdrawal: abi('PartialWithdrawalFacet'),
  refinance: abi('RefinanceFacet'),
  autoLifecycle: abi('AutoLifecycleFacet'),
  config: abi('ConfigFacet'),
  offerCancel: abi('OfferCancelFacet'),
  numeraireConfig: abi('NumeraireConfigFacet'),
  repayPeriodic: abi('RepayPeriodicFacet'),
  swapToRepay: abi('SwapToRepayFacet'),
  earlyWithdrawal: abi('EarlyWithdrawalFacet'),
  earlyWithdrawalDirect: abi('EarlyWithdrawalDirectFacet'),
  profile: abi('ProfileFacet'),
  admin: abi('AdminFacet'),
  oracle: abi('OracleFacet'),
  nft: abi('VaipakamNFTFacet'),
  loupe: abi('DiamondLoupeFacet'),
};

export const read = (facetAbi, functionName, args = []) =>
  pub.readContract({ address: DIAMOND, abi: facetAbi, functionName, args });

export const balanceOf = (token, holder) =>
  pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [holder] });

export const mint = (account, token, whole) =>
  tx(account, { address: token, abi: ERC20, functionName: 'mint', args: [account.address, parseUnits(whole, 18)] }, 'mint');

export const approveDiamond = (account, token) =>
  tx(account, { address: token, abi: ERC20, functionName: 'approve', args: [DIAMOND, 2n ** 255n] }, 'approve');

/** A liquid/liquid lender offer with every range bound pinned to the point value. */
export async function offerParams(overrides = {}) {
  const now = await chainNow();
  const amount = overrides.amount ?? parseUnits('1000', 18);
  const collateralAmount = overrides.collateralAmount ?? parseUnits('1.25', 18);
  return {
    offerType: 0,
    lendingAsset: MOCKS.liquidToken2,
    amount,
    interestRateBps: 500n,
    collateralAsset: MOCKS.liquidToken,
    collateralAmount,
    durationDays: 7n,
    assetType: 0,
    tokenId: 0n,
    quantity: 0n,
    creatorRiskAndTermsConsent: true,
    prepayAsset: MOCKS.liquidToken2,
    collateralAssetType: 0,
    collateralTokenId: 0n,
    collateralQuantity: 0n,
    allowsPartialRepay: false,
    amountMax: amount,
    interestRateBpsMax: overrides.interestRateBps ?? 500n,
    collateralAmountMax: collateralAmount,
    periodicInterestCadence: 0,
    expiresAt: BigInt(now + 7 * 86_400),
    fillMode: 0,
    allowsPrepayListing: false,
    allowsParallelSale: false,
    refinanceTargetLoanId: 0n,
    useFullTermInterest: true,
    ...overrides,
  };
}

export async function createOffer(creator, overrides = {}) {
  const offer = await offerParams(overrides);
  const sim = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer', [offer], creator.address);
  if (!sim.ok) throw new Error(`createOffer would revert: ${sim.name}`);
  const receipt = await tx(creator, { address: DIAMOND, abi: ABIS.offerCreate, functionName: 'createOffer', args: [offer] }, 'createOffer');
  return { offerId: BigInt(sim.result), offer, gas: receipt.gasUsed };
}

/**
 * The EIP-712 `AcceptTerms` field list, DERIVED from the compiled ABI rather
 * than transcribed here.
 *
 * EIP-712 encodes a struct's members in DECLARATION order, and the ABI's
 * tuple components are emitted in that same order by the compiler — so the
 * `terms` parameter of `acceptOffer` already carries the exact names, types
 * and order the signature needs. Reading them from there means a contract-
 * side struct change reaches this harness through the ABI re-export, instead
 * of silently producing `AcceptSignatureInvalid()` against a stale hand-
 * written copy.
 *
 * What this does NOT guard: `LibAcceptTerms`'s typehash STRING is written by
 * hand in Solidity, so it could in principle drift from the struct it
 * describes. That is a contract-side concern and no amount of deriving here
 * would catch it — checked by hand on 2026-09-24, the two agreed field for
 * field. The domain name is likewise not in the ABI and stays literal below.
 */
const ACCEPT_TERMS_FIELDS = (() => {
  const fn = ABIS.offerAccept.find((e) => e.type === 'function' && e.name === 'acceptOffer');
  const terms = fn?.inputs?.find((i) => i.type === 'tuple' && /AcceptTerms$/.test(i.internalType ?? ''));
  if (!terms?.components?.length) {
    throw new Error(
      "fork-scenarios: could not read acceptOffer's AcceptTerms tuple from OfferAcceptFacet.json — " +
        're-export the ABIs (contracts/script/exportFrontendAbis.sh) before running scenarios',
    );
  }
  return terms.components.map(({ name, type }) => ({ name, type }));
})();

const TYPES = { AcceptTerms: ACCEPT_TERMS_FIELDS };

export async function acceptTerms(offerId, offer, acceptor, creator, overrides = {}) {
  const now = await chainNow();
  return {
    acceptor: acceptor.address,
    offerCreator: creator.address,
    offerKey: keccak256(encodeAbiParameters([{ type: 'uint256' }], [offerId])),
    offerType: offer.offerType,
    lendingAsset: offer.lendingAsset,
    collateralAsset: offer.collateralAsset,
    amount: offer.amount,
    collateralAmount: offer.collateralAmount,
    interestRateBps: offer.interestRateBps,
    durationDays: offer.durationDays,
    tokenId: offer.tokenId,
    collateralTokenId: offer.collateralTokenId,
    quantity: offer.quantity,
    collateralQuantity: offer.collateralQuantity,
    assetType: offer.assetType,
    collateralAssetType: offer.collateralAssetType,
    prepayAsset: offer.prepayAsset,
    useFullTermInterest: offer.useFullTermInterest,
    allowsPartialRepay: offer.allowsPartialRepay,
    allowsPrepayListing: offer.allowsPrepayListing,
    allowsParallelSale: offer.allowsParallelSale,
    refinanceTargetLoanId: offer.refinanceTargetLoanId,
    linkedLoanId: 0n,
    parallelSaleOrderHash: BYTES32_ZERO,
    periodicInterestCadence: offer.periodicInterestCadence,
    riskAndTermsConsent: true,
    acknowledgedIlliquidLendingAsset: ZERO,
    acknowledgedIlliquidCollateralAsset: ZERO,
    // The nonce is a per-acceptor one-shot ledger (`AcceptNonceUsed`), not a
    // counter — any never-before-used value is valid.
    nonce: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
    deadline: BigInt(now + 3600),
    riskTermsHash: BYTES32_ZERO,
    acceptorFull: false,
    acceptorMaxCStar: 0n,
    acceptorAllowFullDowngrade: false,
    ...overrides,
  };
}

/**
 * Read an offer back from the chain and accept it.
 *
 * Use this for any offer this process did not construct — an offset vehicle,
 * a sale listing, anything a facet created on a user's behalf. Rebuilding
 * those terms by hand means guessing at fields the facet chose (the offset
 * vehicle's `offerType` is the one that caught this), and the accept then
 * fails `OfferTermsMismatch(n)` against a value that was always knowable.
 */
export async function acceptStoredOffer(offerId, acceptor, overrides = {}) {
  const stored = await read(ABIS.offerCancel, 'getOffer', [offerId]);
  // A vehicle offer (offset, loan sale) is LINKED to the loan it settles, and
  // the signed terms must carry that link — otherwise the accept refuses
  // `OfferTermsMismatch(24)` against a value the chain already knows.
  const linkedLoanId = await read(ABIS.offerCancel, 'getOfferLinkedLoanId', [offerId]).catch(() => 0n);
  return acceptOffer(offerId, stored, acceptor, { address: stored.creator }, { linkedLoanId, ...overrides });
}

export async function acceptOffer(offerId, offer, acceptor, creator, overrides = {}) {
  const terms = await acceptTerms(offerId, offer, acceptor, creator, overrides);
  const signature = await walletFor(acceptor).signTypedData({
    domain: { name: 'Vaipakam AcceptOffer', version: '1', chainId: forkChain.id, verifyingContract: DIAMOND },
    types: TYPES,
    primaryType: 'AcceptTerms',
    message: terms,
  });
  const sim = await simulate(DIAMOND, ABIS.offerAccept, 'acceptOffer', [offerId, terms, signature], acceptor.address);
  if (!sim.ok) return { ok: false, reason: sim.name };
  const receipt = await tx(
    acceptor,
    { address: DIAMOND, abi: ABIS.offerAccept, functionName: 'acceptOffer', args: [offerId, terms, signature] },
    'acceptOffer',
  );
  return { ok: true, gas: receipt.gasUsed, receipt };
}

/**
 * Seed both roles, create a lender offer and accept it.
 * Returns `{ loanId, offerId, offer }`.
 */
/**
 * Open an ordinary liquid/liquid loan.
 *
 * By default the borrower is also funded AND approved in the lending asset,
 * so a later scenario can repay. `borrowerCanRepayFromWallet: false` leaves
 * the Diamond with NO allowance over the borrower's lending asset once the
 * loan is open — for a scenario that claims repayment happens from
 * collateral alone, where a wallet the protocol could quietly debit would
 * let a broken implementation pass.
 */
/**
 * The protocol's own ADMISSION-LIMIT refusals. The fixture loan is a fixed
 * shape (1,000 against 1.25 collateral at the seeded prices unless a scenario
 * overrides it); a valid governance setting can make the deployment refuse it
 * on one of these limits. That is the fixture's envelope, not a broken flow,
 * so it is reported as DID NOT RUN naming the refusal — any OTHER refusal
 * still aborts as a broken flow.
 */
const ADMISSION_LIMITS = new Set(['HealthFactorTooLow', 'LTVExceeded', 'InitLtvAboveTier', 'CollateralBelowRequired', 'MinCollateralBelowFloor']);
const refusalName = (reason) => String(reason ?? '').split('(')[0];

export async function openLoan({ lender, borrower, borrowerCanRepayFromWallet = true, ...overrides } = {}) {
  const { liquidToken: collateral, liquidToken2: lending } = MOCKS;
  await mint(lender, lending, '100000');
  await approveDiamond(lender, lending);
  await mint(borrower, collateral, '100000');
  await approveDiamond(borrower, collateral);
  if (borrowerCanRepayFromWallet) {
    await mint(borrower, lending, '100000');
    await approveDiamond(borrower, lending);
  }
  const offer0 = await offerParams(overrides);
  const created = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer', [offer0], lender.address);
  if (!created.ok) requireEnvelope('fixture admission limits', !ADMISSION_LIMITS.has(refusalName(created.name)),
    `the deployment refuses the fixture offer on its own admission limit: ${created.name}`);
  const { offerId, offer } = await createOffer(lender, overrides);
  const accepted = await acceptOffer(offerId, offer, borrower, lender);
  if (!accepted.ok) requireEnvelope('fixture admission limits', !ADMISSION_LIMITS.has(refusalName(accepted.reason)),
    `the deployment refuses the fixture loan on its own admission limit: ${accepted.reason}`);
  if (!accepted.ok) throw new Error(`accept failed: ${accepted.reason}`);
  if (!borrowerCanRepayFromWallet) {
    await tx(borrower, { address: lending, abi: ERC20, functionName: 'approve', args: [DIAMOND, 0n] }, 'revoke lending allowance');
    const left = await pub.readContract({ address: lending, abi: [{ type: 'function', name: 'allowance', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }], functionName: 'allowance', args: [borrower.address, DIAMOND] });
    if (left !== 0n) throw new Error(`openLoan: the Diamond still holds a ${left} lending allowance from the borrower`);
  }
  const active = await read(ABIS.metrics, 'getUserActiveLoans', [borrower.address]);
  return { loanId: active[active.length - 1], offerId, offer, gas: accepted.gas };
}

/**
 * The account's vault address, CREATING it if it does not exist yet.
 *
 * `getUserVaultAddress` answers `address(0)` for a user who has no vault —
 * quietly, with no revert. Snapshotting that address then reports a balance
 * of zero for every token, which looks exactly like a real reading, and the
 * first thing to notice is an accounting assertion failing several steps
 * later against a party that was never being watched. This helper is the one
 * place that shape is handled: ensure, re-read, and refuse a zero.
 */
export async function vaultAddressFor(account) {
  let address = await read(ABIS.vaultFactory, 'getUserVaultAddress', [account.address]);
  if (address === ZERO) {
    await tx(account, { address: DIAMOND, abi: ABIS.vaultFactory, functionName: 'getOrCreateUserVault', args: [account.address] }, 'getOrCreateUserVault');
    address = await read(ABIS.vaultFactory, 'getUserVaultAddress', [account.address]);
  }
  if (address === ZERO) throw new Error(`no vault for ${account.address} even after getOrCreateUserVault`);
  return address;
}

/**
 * Snapshot every (token, holder) balance so a scenario can account a flow to
 * the wei. A zero-address holder is REFUSED rather than reported as an empty
 * balance — see `vaultAddressFor`; this is the second, independent guard on
 * the same failure, because the symptom is a number rather than an error.
 */
export async function snapshot(tokens, holders) {
  const out = {};
  for (const [tokenName, token] of Object.entries(tokens)) {
    for (const [holderName, holder] of Object.entries(holders)) {
      if (holder === undefined || holder === null) continue;
      if (holder === ZERO) throw new Error(`snapshot: holder "${holderName}" is the zero address — an unresolved vault reads as an empty balance, not as an error`);
      out[`${tokenName}.${holderName}`] = await balanceOf(token, holder);
    }
  }
  return out;
}

/** Non-zero deltas between two snapshots, formatted at 18 decimals. */
export function delta(before, after) {
  const out = {};
  for (const key of Object.keys(after)) {
    const d = after[key] - (before[key] ?? 0n);
    if (d !== 0n) out[key] = f18(d);
  }
  return out;
}

/** `LibVaipakam.LoanStatus`, so rows compare against the exact state. */
export const STATUS = { Active: 0, Repaid: 1, Defaulted: 2, Settled: 3 };

/**
 * The spec's dynamic keeper incentive for a collateral sale: the configured
 * max-liquidation-slippage budget minus the slippage realized against the
 * oracle value of what was sold, capped by the global incentive cap and the
 * collateral's per-asset cap (0 = none). Returns bps.
 */
export async function dynamicIncentiveBps(collateralAsset, principalAsset, soldCollateral, proceeds) {
  const [, maxSlippageBps, maxIncentiveBps] = await read(ABIS.config, 'getLiquidationConfig');
  const risk = await read(ABIS.config, 'getAssetRiskParams', [collateralAsset]);
  const [colPrice, colDec] = await read(ABIS.oracle, 'getAssetPrice', [collateralAsset]);
  const [prinPrice, prinDec] = await read(ABIS.oracle, 'getAssetPrice', [principalAsset]);
  // Both faucet tokens carry 18 decimals; the feeds carry their own.
  const expected = (soldCollateral * colPrice * 10n ** BigInt(prinDec)) / (prinPrice * 10n ** BigInt(colDec));
  let realized = 0n;
  if (proceeds < expected && expected !== 0n) {
    realized = ((expected - proceeds) * 10_000n) / expected;
    if (realized > maxSlippageBps) realized = maxSlippageBps;
  }
  let bps = maxSlippageBps - realized;
  if (bps > maxIncentiveBps) bps = maxIncentiveBps;
  const assetCap = BigInt(risk.liqBonusBps ?? 0);
  if (assetCap !== 0n && bps > assetCap) bps = assetCap;
  return bps;
}

// ---------------------------------------------------------------------------
// Configurable numbers come from the chain, never from this file.
//
// Every fee, share and floor below is governance-tunable, and a loan STAMPS
// the values in force when it opened. A scenario that hard-codes today's
// value certifies one deployment's configuration as if it were a protocol
// invariant — and reports a correct loan as a failure the day governance
// retunes. Expectations therefore read the live getter (for what a NEW loan
// will stamp) or the loan's own stamp (for how an OPEN loan settles).
// ---------------------------------------------------------------------------

/** The live fee configuration a loan opened now would stamp. */
export async function liveFees() {
  const [treasuryFeeBps, lifBps] = await read(ABIS.config, 'getFeesConfig');
  const matcherBps = await read(ABIS.config, 'getLifMatcherFeeBps');
  return { treasuryFeeBps, lifBps, matcherBps: BigInt(matcherBps) };
}

/** Loan-initiation fee on `amount`, and its matcher / treasury split. */
export function lifSplit(amount, lifBps, matcherBps) {
  const lif = (amount * BigInt(lifBps)) / 10_000n;
  const toMatcher = (lif * BigInt(matcherBps)) / 10_000n;
  return { lif, toMatcher, toTreasury: lif - toMatcher };
}

const YEAR_SECONDS_BPS = 365n * 86_400n * 10_000n;

/** Interest accrued by the SECOND (the forced-close and HF debt measure). */
export const perSecondInterest = (principal, rateBps, seconds) =>
  (principal * BigInt(rateBps) * BigInt(seconds)) / YEAR_SECONDS_BPS;

/** Spec late fee: 1% of principal on the first day past due, +0.5% per whole day, capped at 5%. */
export function lateFee(principal, endTime, at) {
  if (at <= endTime) return 0n;
  let bps = 100n + ((at - endTime) / 86_400n) * 50n;
  if (bps > 500n) bps = 500n;
  return (principal * bps) / 10_000n;
}

/**
 * The spec's forced-close proceeds waterfall ("Proceeds Distribution"):
 * the keeper incentive first; then the lender, up to principal + interest +
 * late fee, less the treasury's fee on the recovered interest and late fee;
 * then the 2% handling charge, SUBORDINATED — taken only from what is left
 * above the lender's full recovery; the borrower keeps the rest. On an
 * underwater close the handling charge is zero and the lender bears the loss.
 */
export function forcedCloseWaterfall({ proceeds, incentiveBps, handlingBps, treasuryFeeBps, principal, interest, fee }) {
  let bonus = (proceeds * BigInt(incentiveBps)) / 10_000n;
  if (bonus > proceeds) bonus = proceeds;
  const afterBonus = proceeds - bonus;
  const debt = principal + interest + fee;
  const allocated = afterBonus > debt ? debt : afterBonus;
  const surplus = afterBonus - allocated;
  let handling = (proceeds * BigInt(handlingBps)) / 10_000n;
  if (handling > surplus) handling = surplus;
  let interestFee = 0n;
  if (allocated > principal) {
    let recovered = allocated - principal;
    if (recovered > interest + fee) recovered = interest + fee;
    interestFee = (recovered * BigInt(treasuryFeeBps)) / 10_000n;
  }
  return { bonus, lender: allocated - interestFee, treasury: handling + interestFee, borrower: surplus - handling };
}

// ---------------------------------------------------------------------------
// A position's whole observable state, asserted in one place.
//
// A row that checks ONE field of a position after a step — "the loan names
// the new lender", "the lien is unreleased" — certifies that field while any
// other could be wrong: the NFT the authority resolves through, the recorded
// collateral, the lien's holder or amount, the other side's receipt. Adding
// the missing field to that one row leaves the next row with the same gap.
// So every step asserts the WHOLE position through `expectPosition`: each
// tracked field either changes to the value the step states, or stays exactly
// what it was. Nothing is silently out of scope.
// ---------------------------------------------------------------------------

/**
 * Every field `expectPosition` tracks: EVERY field `getLoanDetails` returns —
 * derived from the compiled ABI, so a field the contract adds is tracked
 * without an edit here and none is hand-picked out — plus each position NFT's
 * holder and every field of the collateral lien.
 */
const LOAN_FIELDS = (() => {
  const fn = ABIS.loan.find((e) => e.type === 'function' && e.name === 'getLoanDetails');
  const comps = fn?.outputs?.[0]?.components;
  if (!comps?.length) throw new Error('fork-scenarios: could not read getLoanDetails\'s Loan tuple from LoanFacet.json');
  return comps.map((c) => c.name);
})();
const LIEN_FIELDS = ['lienUser', 'lienAsset', 'lienTokenId', 'lienAmount', 'lienAssetType', 'lienReleased'];
export const POSITION_FIELDS = [...LOAN_FIELDS, 'lenderNftOwner', 'borrowerNftOwner', ...LIEN_FIELDS];

/**
 * The only fields a created position may leave unstated: the identifiers the
 * chain mints (the loan id and the two token ids), which nothing fixes in
 * advance. Every other field — terms, parties, NFTs, lien, fee stamps, and the
 * creation clock and counters (`creationFields`) — must be stated.
 */
export const CHAIN_ASSIGNED_AT_CREATION = ['id', 'lenderTokenId', 'borrowerTokenId'];

/**
 * The creation-time fields of a loan opened by accepting `offerId` in the
 * transaction `receipt`, called by `acceptor`: the clock starts at the fill
 * block, the whole term remains, every running counter is zero (a rental's
 * deduction clock too, on an ERC-20 loan), the accept's
 * caller is the matcher, and both parties' consent is recorded.
 */
export async function creationFields(receipt, offerId, durationDays, acceptor, { rental = false } = {}) {
  const at = BigInt((await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
  return {
    offerId, startTime: at, interestAccrualStart: at, interestRemainingDays: BigInt(durationDays),
    // `lastDeductTime` is an NFT rental's daily-deduction clock; an ERC-20
    // loan has no daily deduction, so it stays unset.
    lastPeriodicInterestSettledAt: at, lastDeductTime: rental ? at : 0n,
    interestPaidSinceLastPeriod: 0n, interestSettled: 0n,
    lenderDiscountAccAtInit: 0n, borrowerDiscountAccAtInit: 0n,
    matcher: acceptor, lenderNotifBilled: false, borrowerNotifBilled: false, riskAndTermsConsentFromBoth: true,
  };
}

/** A value that matches anything — only for ids a step mints fresh. */
export const ANY = Symbol('any');

const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);

async function nftOwner(tokenId) {
  try { return lower(await pub.readContract({ address: DIAMOND, abi: ABIS.nft, functionName: 'ownerOf', args: [tokenId] })); }
  catch { return null; } // burned, or never minted
}

/** The position as the chain reports it now. */
export async function positionOf(loanId) {
  const l = await read(ABIS.loan, 'getLoanDetails', [loanId]);
  const lien = await read(ABIS.metrics, 'getLoanCollateralLien', [loanId]);
  const out = {};
  for (const k of LOAN_FIELDS) out[k] = typeof l[k] === 'number' ? l[k] : lower(l[k]);
  Object.assign(out, {
    lenderNftOwner: await nftOwner(l.lenderTokenId), borrowerNftOwner: await nftOwner(l.borrowerTokenId),
    lienUser: lower(lien.user), lienAsset: lower(lien.asset), lienTokenId: lien.tokenId,
    lienAmount: lien.amount, lienAssetType: Number(lien.assetType), lienReleased: lien.released,
  });
  return out;
}

/**
 * The terms a position created from `offer` must carry, read off the stored
 * offer — so a created position is compared against what was actually
 * offered, not against a transcription of it.
 */
export function termsFromOffer(offer) {
  return {
    principal: offer.amount, principalAsset: offer.lendingAsset, interestRateBps: offer.interestRateBps,
    durationDays: offer.durationDays, collateralAsset: offer.collateralAsset, collateralAmount: offer.collateralAmount,
    assetType: offer.assetType, collateralAssetType: offer.collateralAssetType, tokenId: offer.tokenId,
    quantity: offer.quantity, collateralTokenId: offer.collateralTokenId, collateralQuantity: offer.collateralQuantity,
    prepayAsset: offer.prepayAsset, useFullTermInterest: offer.useFullTermInterest,
    allowsPartialRepay: offer.allowsPartialRepay, allowsPrepayListing: offer.allowsPrepayListing,
    periodicInterestCadence: offer.periodicInterestCadence,
  };
}

/**
 * The per-loan stamps a position created NOW must carry: the live governance
 * configuration, read from its getters, plus the asset-derived risk stamps as
 * the chain reports them for the collateral.
 */
export async function liveStamps() {
  const fees = await liveFees();
  const [lenderBonusBps, treasuryBps] = await read(ABIS.config, 'getFallbackSplit');
  return {
    treasuryFeeBpsAtInit: fees.treasuryFeeBps, loanInitiationFeeBpsAtInit: fees.lifBps,
    minHealthFactorAtInit: await read(ABIS.risk, 'getMinHealthFactor'),
    fallbackLenderBonusBpsAtInit: lenderBonusBps, fallbackTreasuryBpsAtInit: treasuryBps,
  };
}

/**
 * Assert the WHOLE position after a step. `before` is `positionOf()` from
 * before the step and `changes` the fields the step is meant to change; every
 * other tracked field must be exactly as it was. For a position the step
 * CREATES, pass `before = null` and state every field.
 */
export async function expectPosition(id, name, loanId, before, changes) {
  const unknown = Object.keys(changes).filter((k) => !POSITION_FIELDS.includes(k));
  if (unknown.length) throw new TypeError(`expectPosition(${id}): unknown field(s) ${unknown.join(', ')}`);
  if (before === null) {
    const missing = POSITION_FIELDS.filter((k) => !(k in changes) && !CHAIN_ASSIGNED_AT_CREATION.includes(k));
    if (missing.length) throw new TypeError(`expectPosition(${id}): a new position must state every non-chain-assigned field; missing ${missing.join(', ')}`);
  }
  const want = before ? { ...before } : Object.fromEntries(CHAIN_ASSIGNED_AT_CREATION.map((k) => [k, ANY]));
  for (const [k, v] of Object.entries(changes)) want[k] = lower(v);
  const after = await positionOf(loanId);
  const wrong = POSITION_FIELDS.filter((k) => want[k] !== ANY && String(after[k]) !== String(want[k]))
    .map((k) => `${k}: got ${after[k]} want ${want[k]}`);
  const stated = Object.entries(changes).map(([k, v]) => `${k}=${v === ANY ? '*' : v}`).join(' ');
  return check(id, name, wrong.length === 0,
    wrong.length ? `MISMATCH ${wrong.join('; ')}` : `loanId=${loanId} ${before === null ? 'new position:' : 'changed:'} ${stated || '(nothing)'}; every other field unchanged`);
}

/**
 * One claim, asserted the one way every claim must be: an exact ledger (the
 * claimant's credited share leaves their vault for their wallet, nothing
 * else moves) AND the whole position afterwards (their NFT burned, plus
 * whatever the claim is meant to change — the lien released, the loan
 * settled). Returns the position after, for the next claim to compare to.
 */
export async function claimAndExpect({ id, who, account, fn, loanId, tokens, holders, moves, before, changes }) {
  const { tx } = await import('./chain.mjs');
  const pre = await snapshot(tokens, holders);
  const receipt = await tx(account, { address: DIAMOND, abi: ABIS.claim, functionName: fn, args: [loanId] }, fn);
  const post = await snapshot(tokens, holders);
  expectLedger(id, `the ${who}'s claim moves exactly their credited share, vault → wallet, and nothing else`, pre, post, moves, `gas=${receipt.gasUsed}`);
  await expectPosition(`${id}.pos`, `after the ${who}'s claim the position changes exactly as stated`, loanId, before, changes);
  return positionOf(loanId);
}
