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

export interface LoanTerms {
  lender: Party;
  borrower: Party;
  /** WETH lent, decimal string. */
  principalWeth: string;
  /** tLIQ locked, decimal string. */
  collateralTliq: string;
  rateBps: number;
  days: number;
  /** `LibVaipakam.PeriodicInterestCadence` (0 None, 1 Monthly, …). Omitted,
   *  None. A finer cadence needs periodic interest switched on and a
   *  principal above the finer-cadence threshold. */
  cadence?: number;
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

/** The lender posts a lender offer; the borrower accepts it with a signed
 *  AcceptTerms. Returns the loan the accept initiated. */
export async function openLoan(sc: ScenarioChain, t: LoanTerms): Promise<OpenedLoan> {
  const principal = parseEther(t.principalWeth);
  const collateral = parseEther(t.collateralTliq);
  const collateralAsset = tliq(sc);

  // The lender's leg: wrap its own ETH, escrow it with the offer.
  await sc.write(t.lender, WETH, TOKEN_ABI, 'deposit', [], principal);
  await sc.write(t.lender, WETH, TOKEN_ABI, 'approve', [sc.diamond, principal]);
  const created = await sc.diamondWrite(t.lender, 'createOffer', [
    {
      offerType: 0,
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
      periodicInterestCadence: t.cadence ?? 0,
      expiresAt: 0n,
      fillMode: 0,
      allowsPrepayListing: false,
      allowsParallelSale: false,
      refinanceTargetLoanId: 0n,
      useFullTermInterest: false,
    },
  ]);
  const offerEv = sc.decodeDiamondLogs(created.logs).find((e) => e.eventName === 'OfferCreated');
  if (!offerEv) throw new Error('createOffer emitted no OfferCreated');
  const offerId = BigInt(offerEv.args.offerId as bigint);

  // The borrower's leg: mint the faucet collateral, sign, accept.
  await sc.write(t.borrower, collateralAsset, TOKEN_ABI, 'mint', [sc.address(t.borrower), collateral]);
  await sc.write(t.borrower, collateralAsset, TOKEN_ABI, 'approve', [sc.diamond, collateral]);
  const o = await sc.read<Record<string, unknown>>('getOffer', [offerId]);
  const linkedLoanId = await sc.read<bigint>('getOfferLinkedLoanId', [offerId]);
  const riskTermsHash = await sc.read<Hex>('getCurrentRiskTermsHash').catch(() => ZERO_HASH);
  const chainNow = BigInt(await sc.now());
  const acceptor = sc.address(t.borrower);
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
    deadline: chainNow + 1800n,
    riskTermsHash,
    acceptorFull: false,
    acceptorMaxCStar: 0n,
    acceptorAllowFullDowngrade: false,
  };
  const signature = await sc.wallet(t.borrower).signTypedData({
    account: sc.wallet(t.borrower).account!,
    domain: { name: 'Vaipakam AcceptOffer', version: '1', chainId: sc.chain.id, verifyingContract: sc.diamond },
    types: ACCEPT_TERMS_TYPES,
    primaryType: 'AcceptTerms',
    message: terms,
  });
  const accepted = await sc.diamondWrite(t.borrower, 'acceptOffer', [offerId, terms, signature]);
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
