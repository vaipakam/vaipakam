/**
 * A real loan, opened and closed through the protocol's public entry points —
 * the source of the reward entries every reward scenario works on. On a
 * chain whose interaction rewards have launched, accepting an offer registers
 * one interaction-reward entry per side (lender, borrower); repaying closes
 * them. The transactions are the ones the connected app
 * sends (`apps/app/e2e/lib/desk.ts` drives the same `createOffer` →
 * signed `acceptOffer` → `repayLoan` sequence), so nothing here reaches past
 * the Diamond's public surface.
 *
 * The market: WETH (Base's predeploy, wrapped from the parties' own ETH)
 * lent against tLIQ (the fixture's oracle-wired faucet mock, freely mintable)
 * — the pair the app's e2e tier trades, priced, so the loan accrues reward in
 * the numeraire.
 */
import { encodeAbiParameters, keccak256, parseEther, type Address, type Hex } from 'viem';
import { TOKEN_ABI, type Party, type ScenarioChain } from './scenarioChain';
import { txValidUntil } from '@vaipakam/lib/txDeadline';

export const WETH: Address = '0x4200000000000000000000000000000000000006';
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;

/** EIP-712 AcceptTerms — field order and types are `LibAcceptTerms`'s typehash
 *  (the app's `useAcceptTerms.ts` carries the same list). */
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
    { name: 'acceptorFull', type: 'bool' },
    { name: 'acceptorMaxCStar', type: 'uint256' },
    { name: 'acceptorAllowFullDowngrade', type: 'bool' },
  ],
} as const;

export interface LoanTerms extends OfferTerms {
  borrower: Party;
}

export interface OpenedLoan {
  loanId: bigint;
  offerId: bigint;
  /** The block the accept landed in (event scans start here). */
  acceptBlock: bigint;
}

function tliq(sc: ScenarioChain): Address {
  return (sc.fixture.artifact.testnetMocks as Record<string, Address>).liquidToken;
}

export interface OfferTerms {
  lender: Party;
  /** WETH lent, decimal string. */
  principalWeth: string;
  /** tLIQ asked as collateral, decimal string. */
  collateralTliq: string;
  rateBps: number;
  days: number;
  /** `LibVaipakam.PeriodicInterestCadence` (0 None, 1 Monthly, …). Omitted,
   *  None. A finer cadence needs periodic interest switched on and a
   *  principal above the finer-cadence threshold. */
  cadence?: number;
  /** Whether interest is charged for the whole term however early the loan
   *  is repaid (`useFullTermInterest`). Omitted, pro rata. */
  fullTermInterest?: boolean;
  /** Whether the loan may be repaid in part; true when left out. */
  allowsPartialRepay?: boolean;
}

/** The lender posts a lender offer, escrowing the principal it wrapped from
 *  its own ETH, and leaves it open. Returns the offer id. */
export async function postLenderOffer(sc: ScenarioChain, t: OfferTerms): Promise<bigint> {
  const principal = parseEther(t.principalWeth);
  const collateral = parseEther(t.collateralTliq);
  await sc.write(t.lender, WETH, TOKEN_ABI, 'deposit', [], principal);
  await sc.write(t.lender, WETH, TOKEN_ABI, 'approve', [sc.diamond, principal]);
  // The transaction deadline (#3412): the chain's own time plus the shared
  // window, never the host clock.
  const validUntil = txValidUntil(BigInt(await sc.now()));
  const created = await sc.diamondWrite(t.lender, 'createOffer', [
    {
      offerType: 0,
      lendingAsset: WETH,
      amount: principal,
      interestRateBps: BigInt(t.rateBps),
      collateralAsset: tliq(sc),
      collateralAmount: collateral,
      durationDays: BigInt(t.days),
      assetType: 0,
      tokenId: 0n,
      quantity: 1n,
      creatorRiskAndTermsConsent: true,
      prepayAsset: ZERO,
      collateralAssetType: 0,
      collateralTokenId: 0n,
      collateralQuantity: 0n,
      allowsPartialRepay: t.allowsPartialRepay ?? true,
      amountMax: principal,
      interestRateBpsMax: BigInt(t.rateBps),
      collateralAmountMax: collateral,
      periodicInterestCadence: t.cadence ?? 0,
      expiresAt: 0n,
      fillMode: 0,
      allowsPrepayListing: false,
      allowsParallelSale: false,
      refinanceTargetLoanId: 0n,
      useFullTermInterest: t.fullTermInterest ?? false,
    },
    validUntil,
  ]);
  const offerEv = sc.decodeDiamondLogs(created.logs).find((e) => e.eventName === 'OfferCreated');
  if (!offerEv) throw new Error('createOffer emitted no OfferCreated');
  const offerId = BigInt(offerEv.args.offerId as bigint);
  await ageOffer(sc, offerId);
  return offerId;
}

export interface RequestTerms {
  borrower: Party;
  /** WETH asked, decimal string. */
  principalWeth: string;
  /** tLIQ locked as collateral, decimal string (minted to the borrower). */
  collateralTliq: string;
  rateBps: number;
  days: number;
}

/** The borrower posts a borrow request for WETH, locking tLIQ it mints for
 *  itself in its own vault, and leaves it open. Returns the offer id. */
export async function postBorrowRequest(sc: ScenarioChain, t: RequestTerms): Promise<bigint> {
  const principal = parseEther(t.principalWeth);
  const collateral = parseEther(t.collateralTliq);
  const collateralAsset = tliq(sc);
  await sc.write(t.borrower, collateralAsset, TOKEN_ABI, 'mint', [sc.address(t.borrower), collateral]);
  await sc.write(t.borrower, collateralAsset, TOKEN_ABI, 'approve', [sc.diamond, collateral]);
  // The transaction deadline (#3412): the chain's own time plus the shared
  // window, never the host clock.
  const validUntil = txValidUntil(BigInt(await sc.now()));
  const created = await sc.diamondWrite(t.borrower, 'createOffer', [
    {
      offerType: 1,
      lendingAsset: WETH,
      amount: principal,
      interestRateBps: BigInt(t.rateBps),
      collateralAsset,
      collateralAmount: collateral,
      durationDays: BigInt(t.days),
      assetType: 0,
      tokenId: 0n,
      quantity: 1n,
      creatorRiskAndTermsConsent: true,
      prepayAsset: ZERO,
      collateralAssetType: 0,
      collateralTokenId: 0n,
      collateralQuantity: 0n,
      allowsPartialRepay: true,
      amountMax: principal,
      interestRateBpsMax: BigInt(t.rateBps),
      collateralAmountMax: collateral,
      periodicInterestCadence: 0,
      expiresAt: 0n,
      fillMode: 0,
      allowsPrepayListing: false,
      allowsParallelSale: false,
      refinanceTargetLoanId: 0n,
      useFullTermInterest: false,
    },
    validUntil,
  ]);
  const offerEv = sc.decodeDiamondLogs(created.logs).find((e) => e.eventName === 'OfferCreated');
  if (!offerEv) throw new Error('createOffer emitted no OfferCreated');
  const offerId = BigInt(offerEv.args.offerId as bigint);
  await ageOffer(sc, offerId);
  return offerId;
}

/** The lender posts a lender offer; the borrower accepts it with a signed
 *  AcceptTerms. Returns the loan the accept initiated. */
export async function openLoan(sc: ScenarioChain, t: LoanTerms): Promise<OpenedLoan> {
  const collateral = parseEther(t.collateralTliq);
  const collateralAsset = tliq(sc);
  const offerId = await postLenderOffer(sc, t);

  // The borrower's leg: mint the faucet collateral, sign, accept.
  await sc.write(t.borrower, collateralAsset, TOKEN_ABI, 'mint', [sc.address(t.borrower), collateral]);
  await sc.write(t.borrower, collateralAsset, TOKEN_ABI, 'approve', [sc.diamond, collateral]);
  return acceptPostedOffer(sc, t.borrower, offerId);
}

/** #3443 — an offer can be filled only once its terms have stood the
 *  Diamond's minimum age (`getMinTermsAgeSec`, 5 s by default). A live taker
 *  simply arrives later; a scenario that posts and accepts back to back moves
 *  the chain to the moment the terms become fillable first. Terms that carry
 *  no age (0), or a Diamond without the rule, need no wait. */
export async function waitOutTermsAge(sc: ScenarioChain, termsSetAt: bigint | undefined): Promise<void> {
  if (!termsSetAt) return;
  const minAge = await sc.read<bigint>('getMinTermsAgeSec').catch(() => 0n);
  const readyAt = Number(termsSetAt + minAge);
  const now = await sc.now();
  if (readyAt > now) await sc.warp(readyAt - now);
}

/** Moves the chain past the moment offer `offerId`'s terms become fillable,
 *  and mines a block there, so every read (a page's preview included) sees
 *  the offer as takeable. A seeded offer stands for one its maker posted
 *  earlier; on an idle Anvil no block would otherwise carry the clock past
 *  the age, and the page would keep reading the offer as just posted. The
 *  post helpers above call it; a spec that posts its own offer for a page to
 *  take calls it too. */
export async function ageOffer(sc: ScenarioChain, offerId: bigint): Promise<void> {
  const o = await sc.read<Record<string, unknown>>('getOffer', [offerId]);
  await waitOutTermsAge(sc, o.termsSetAt as bigint | undefined);
}

/** `who` signs the acceptance terms of a posted offer exactly as it stands
 *  and accepts it, whatever it carries (a loan offer or a rental listing);
 *  the caller funds and approves whatever the acceptance pulls first. */
export async function acceptPostedOffer(sc: ScenarioChain, who: Party, offerId: bigint): Promise<OpenedLoan> {
  const o = await sc.read<Record<string, unknown>>('getOffer', [offerId]);
  await waitOutTermsAge(sc, o.termsSetAt as bigint | undefined);
  const linkedLoanId = await sc.read<bigint>('getOfferLinkedLoanId', [offerId]);
  const riskTermsHash = await sc.read<Hex>('getCurrentRiskTermsHash').catch(() => ZERO_HASH);
  const chainNow = BigInt(await sc.now());
  const acceptor = sc.address(who);
  const terms = {
    acceptor,
    offerCreator: o.creator as Address,
    offerKey: keccak256(encodeAbiParameters([{ type: 'uint256' }], [offerId])),
    offerType: Number(o.offerType),
    lendingAsset: o.lendingAsset as Address,
    collateralAsset: o.collateralAsset as Address,
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
    prepayAsset: o.prepayAsset as Address,
    useFullTermInterest: Boolean(o.useFullTermInterest),
    allowsPartialRepay: Boolean(o.allowsPartialRepay),
    allowsPrepayListing: Boolean(o.allowsPrepayListing),
    allowsParallelSale: Boolean(o.allowsParallelSale),
    refinanceTargetLoanId: o.refinanceTargetLoanId as bigint,
    linkedLoanId,
    parallelSaleOrderHash: o.parallelSaleOrderHash as Hex,
    periodicInterestCadence: Number(o.periodicInterestCadence),
    riskAndTermsConsent: true,
    acknowledgedIlliquidLendingAsset: o.lendingAsset as Address,
    acknowledgedIlliquidCollateralAsset: o.collateralAsset as Address,
    nonce: BigInt(Date.now()),
    deadline: txValidUntil(chainNow),
    riskTermsHash,
    acceptorFull: false,
    acceptorMaxCStar: 0n,
    acceptorAllowFullDowngrade: false,
  };
  const signature = await sc.wallet(who).signTypedData({
    account: sc.wallet(who).account!,
    domain: { name: 'Vaipakam AcceptOffer', version: '1', chainId: sc.chain.id, verifyingContract: sc.diamond },
    types: ACCEPT_TERMS_TYPES,
    primaryType: 'AcceptTerms',
    message: terms,
  });
  const accepted = await sc.diamondWrite(who, 'acceptOffer', [offerId, terms, signature]);
  const loanEv = sc.decodeDiamondLogs(accepted.logs).find((e) => e.eventName === 'LoanInitiated');
  if (!loanEv) throw new Error('acceptOffer emitted no LoanInitiated');
  return { loanId: BigInt(loanEv.args.loanId as bigint), offerId, acceptBlock: accepted.blockNumber };
}

/** The borrower repays in full (the contract's own settlement figure, padded
 *  for per-second accrual; only the owed amount moves). */
export async function repayInFull(sc: ScenarioChain, who: Party, loanId: bigint): Promise<void> {
  const owed = await sc.read<bigint>('calculateRepaymentAmount', [loanId]);
  const pad = owed * 2n;
  await sc.write(who, WETH, TOKEN_ABI, 'deposit', [], pad);
  await sc.write(who, WETH, TOKEN_ABI, 'approve', [sc.diamond, pad]);
  await sc.diamondWrite(who, 'repayLoan', [loanId]);
  const after = await sc.read<{ status: number }>('getLoanDetails', [loanId]);
  if (Number(after.status) !== 1) throw new Error(`loan ${loanId} is not Repaid after repayLoan (status ${after.status})`);
}
