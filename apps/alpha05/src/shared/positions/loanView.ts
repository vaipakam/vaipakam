/**
 * One loan, read for its own page (LN-04, LN-07, LN-08, LN-09, LN-10, LN-11,
 * LN-12, LN-13): the stored record, who holds each position now, the dates it
 * answers to, its health, and where its collateral is held. OWN state, read
 * through the own rail, because the reader's role follows the position NFT
 * they hold.
 *
 * Every figure is read on its own, and one that could not be read is `null`
 * ("unknown" on the page), never a made-up figure and never zero: a failed
 * health read is not a health factor of 0, an unread date is not computed
 * from the start time and the term (the protocol's loan clock credits paused
 * time; `getLoanDeadlines` is the one source).
 */
import { type Abi, type PublicClient } from 'viem';
import { DefaultedFacetABI, LoanFacetABI, MetricsFacetABI, NumeraireConfigFacetABI, RepayPeriodicFacetABI, RiskFacetABI, VaipakamNFTFacetABI } from '@vaipakam/contracts/abis';
import { isLiveStatus, type Deadlines, type LoanSummary } from './model';

type Hex = `0x${string}`;

const LOAN = LoanFacetABI as Abi;
const RISK = RiskFacetABI as Abi;
const METRICS = MetricsFacetABI as Abi;
const NFT = VaipakamNFTFacetABI as Abi;
const DEFAULTED = DefaultedFacetABI as Abi;
const PERIODIC = RepayPeriodicFacetABI as Abi;
const NUMERAIRE = NumeraireConfigFacetABI as Abi;

/** `LibVaipakam.LiquidityStatus.Illiquid`. */
export const ILLIQUID = 1;

/** The stored loan record, as `getLoanDetails` returns it (the fields the
 *  page states). Rates and the liquidation threshold are the loan's own
 *  snapshots, fixed when it opened, never today's configuration. */
export interface LoanDetails extends LoanSummary {
  lender: Hex;
  borrower: Hex;
  principalLiquidity: number;
  collateralLiquidity: number;
  useFullTermInterest: boolean;
  allowsPartialRepay: boolean;
  allowsPrepayListing: boolean;
  periodicInterestCadence: number;
  liquidationLtvBpsAtInit: number;
  treasuryFeeBpsAtInit: number;
  loanInitiationFeeBpsAtInit: number;
  collateralQuantity: bigint;
  quantity: bigint;
  prepayAsset: Hex;
  prepayAmount: bigint;
}

/** The protocol's collateral lien (`getLoanCollateralLien`): what the
 *  borrower's vault holds for this loan, and whether it was released. */
export interface CollateralLien {
  user: Hex;
  asset: Hex;
  tokenId: bigint;
  amount: bigint;
  assetType: number;
  released: boolean;
}

/** Who holds each position now (`ownerOf`); `null` when it could not be read
 *  (or the token no longer exists). */
export interface Holders {
  lender: Hex | null;
  borrower: Hex | null;
}

export interface LoanView {
  loan: LoanDetails;
  holders: Holders;
  /** Live loans only; `null` when unread (or the loan has ended). */
  deadlines: Deadlines | null;
  /** The original due date before any pause credit; `null` when unread. */
  originalMaturity: bigint | null;
  /** Whether a default may be started now (`isLoanDefaultable`). */
  defaultable: boolean | null;
  /** 1e18-scaled, as the protocol computes it (0 is a real reading: the
   *  collateral's risk-adjusted value rounds to nothing). `null` when the
   *  read failed, which is also how the protocol answers for a loan with an
   *  illiquid leg (it refuses the read); the page tells the two apart by
   *  the loan's liquidity classes. */
  healthFactor: bigint | null;
  /** In basis points; `null` when it could not be read (the protocol also
   *  refuses it for a loan with an illiquid leg). */
  ltvBps: bigint | null;
  lien: CollateralLien | null;
  /** A loan opened to carry a lender's sale (no fee, no rental). */
  saleVehicle: boolean | null;
}

/** The reader's role on this loan: the positions their wallet HOLDS now,
 *  never the parties recorded when it opened. `null` while either holder is
 *  unread: the role is being confirmed. */
export interface Role {
  lender: boolean;
  borrower: boolean;
}

export function roleOf(holders: Holders, account: Hex): Role | null {
  const a = account.toLowerCase();
  const lender = holders.lender?.toLowerCase() === a;
  const borrower = holders.borrower?.toLowerCase() === a;
  // Both reads are needed for any role: with one unread, a wallet holding
  // the side that was read may hold the other too.
  if (holders.lender === null || holders.borrower === null) return null;
  return { lender, borrower };
}

async function maybe<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

/** One loan's read: `view` is `null` when no loan has this id (the stored
 *  record is empty), which is an answer, never "still reading". */
export interface LoanRead {
  view: LoanView | null;
}

/** Reads one loan. */
export async function readLoanView(client: PublicClient, diamond: Hex, loanId: bigint): Promise<LoanRead> {
  const read = <T>(abi: Abi, functionName: string, args: readonly unknown[] = []) => client.readContract({ address: diamond, abi, functionName, args }) as Promise<T>;
  const loan = await read<LoanDetails>(LOAN, 'getLoanDetails', [loanId]);
  if (loan.id === 0n) return { view: null };
  const live = isLiveStatus(loan.status);
  const cadence = loan.periodicInterestCadence;

  const [lender, borrower, dates, periodic, periodicOn, defaultable, healthFactor, ltvBps, lien, saleVehicle] = await Promise.all([
    maybe(read<Hex>(NFT, 'ownerOf', [loan.lenderTokenId])),
    maybe(read<Hex>(NFT, 'ownerOf', [loan.borrowerTokenId])),
    live ? maybe(read<readonly [bigint, bigint, bigint, bigint]>(LOAN, 'getLoanDeadlines', [loanId])) : null,
    live && cadence !== 0 ? maybe(read<readonly [number, bigint, bigint, bigint, bigint, bigint, boolean]>(PERIODIC, 'previewPeriodicSettle', [loanId])) : null,
    live && cadence !== 0 ? maybe(read<boolean>(NUMERAIRE, 'getPeriodicInterestEnabled')) : null,
    live ? maybe(read<boolean>(DEFAULTED, 'isLoanDefaultable', [loanId])) : null,
    live ? maybe(read<bigint>(RISK, 'calculateHealthFactor', [loanId])) : null,
    live ? maybe(read<bigint>(RISK, 'calculateLTV', [loanId])) : null,
    maybe(read<CollateralLien>(METRICS, 'getLoanCollateralLien', [loanId])),
    maybe(read<boolean>(METRICS, 'isSaleVehicleLoan', [loanId])),
  ]);

  // A loan with a cadence answers to its checkpoint too: with the checkpoint
  // or the switch unread, its deadlines are unknown rather than half-known.
  let deadlines: Deadlines | null = null;
  if (dates) {
    const [, pauseCredit, maturity, graceEnd] = dates;
    if (cadence === 0) deadlines = { maturity, graceEnd, pauseCredit, periodic: null };
    else if (periodic && periodicOn !== null) {
      const [, periodEndAt, graceEndsAt, , , shortfall] = periodic;
      deadlines = { maturity, graceEnd, pauseCredit, periodic: { periodEndAt, graceEndsAt, shortfall, enforced: periodicOn } };
    }
  }

  const view: LoanView = {
    loan,
    holders: { lender, borrower },
    deadlines,
    originalMaturity: dates ? dates[0] : null,
    defaultable,
    healthFactor,
    ltvBps,
    lien,
    saleVehicle,
  };
  return { view };
}
