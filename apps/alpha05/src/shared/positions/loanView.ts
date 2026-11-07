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
import {
  AdminFacetABI,
  ConfigFacetABI,
  DefaultedFacetABI,
  LoanFacetABI,
  MetricsFacetABI,
  NumeraireConfigFacetABI,
  OracleFacetABI,
  RepayPeriodicFacetABI,
  RiskFacetABI,
  VaipakamNFTFacetABI,
} from '@vaipakam/contracts/abis';
import { isLiveStatus, type Deadlines, type LoanSummary } from './model';

type Hex = `0x${string}`;

const LOAN = LoanFacetABI as Abi;
const RISK = RiskFacetABI as Abi;
const METRICS = MetricsFacetABI as Abi;
const NFT = VaipakamNFTFacetABI as Abi;
const DEFAULTED = DefaultedFacetABI as Abi;
const PERIODIC = RepayPeriodicFacetABI as Abi;
const NUMERAIRE = NumeraireConfigFacetABI as Abi;
const CONFIG = ConfigFacetABI as Abi;
const ADMIN = AdminFacetABI as Abi;
const ORACLE = OracleFacetABI as Abi;

/** `LibVaipakam.LiquidityStatus.Illiquid`. */
export const ILLIQUID = 1;

/** The stored loan record, as `getLoanDetails` returns it (the fields the
 *  page states). Rates and the liquidation threshold are the loan's own
 *  snapshots, fixed when it opened, never today's configuration. */
/** The protocol's share of interest a loan opened without a recorded rate
 *  settles at: a stored 0 means no rate was recorded at origination (older
 *  loans), and settlement then charges this fixed legacy rate, never zero. */
export const LEGACY_TREASURY_FEE_BPS = 100;

/** The share of interest settlement actually takes for this loan, and
 *  whether it came from the legacy fallback rather than the loan's record. */
export function treasuryShareBps(l: Pick<LoanDetails, 'treasuryFeeBpsAtInit'>): { bps: number; legacy: boolean } {
  return l.treasuryFeeBpsAtInit === 0 ? { bps: LEGACY_TREASURY_FEE_BPS, legacy: true } : { bps: l.treasuryFeeBpsAtInit, legacy: false };
}

/** The initiation fee rate the loan recorded when it opened, or `null`
 *  when none was recorded: a stored 0 marks a loan that opened before the
 *  rate was kept (the recorded rate is always the resolved, non-zero knob),
 *  never a fee-free loan. */
export function recordedInitFeeBps(l: Pick<LoanDetails, 'loanInitiationFeeBpsAtInit'>): number | null {
  return l.loanInitiationFeeBpsAtInit === 0 ? null : l.loanInitiationFeeBpsAtInit;
}

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

/** The gate that refuses a default the timing already allows. */
export type DefaultRefusal = 'paused' | 'sequencer' | 'admission';

/** The one default verdict (see `LoanView.defaultable`), from the gates in
 *  the order `triggerDefault` applies them after the timing. */
export function defaultVerdict(g: { timing: boolean | null; paused: boolean | null; sequencerHealthy: boolean | null; admitted: boolean | null }): {
  defaultable: boolean | null;
  refusal: DefaultRefusal | null;
} {
  if (g.timing === false) return { defaultable: false, refusal: null };
  if (g.timing === null) return { defaultable: null, refusal: null };
  if (g.paused === true) return { defaultable: false, refusal: 'paused' };
  if (g.sequencerHealthy === false) return { defaultable: false, refusal: 'sequencer' };
  if (g.admitted === false) return { defaultable: false, refusal: 'admission' };
  if (g.paused === null || g.sequencerHealthy === null || g.admitted === null) return { defaultable: null, refusal: null };
  return { defaultable: true, refusal: null };
}

export interface LoanView {
  loan: LoanDetails;
  holders: Holders;
  /** Live loans only; `null` when unread (or the loan has ended). */
  deadlines: Deadlines | null;
  /** The original due date before any pause credit; `null` when unread. */
  originalMaturity: bigint | null;
  /** Whether a default may be started now: true only when every gate
   *  `triggerDefault` applies that a read can answer passes: the timing
   *  verdict (`isLoanDefaultable`), the global pause (`paused`), the
   *  sequencer (`sequencerHealthy`) and the lender admission
   *  (`defaultKycAdmission`, which refuses only where the network turns
   *  that check on). `null` when a needed read failed. One verdict, so no
   *  surface can say "may now start" on part of the rule. */
  defaultable: boolean | null;
  /** When the timing allows a default but another gate refuses it, which
   *  one, so the page says why it cannot start yet. */
  defaultRefusal: DefaultRefusal | null;
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
  /** The internal-match priority band (`getInternalMatchConfigBundle`):
   *  while matching is on, a liquidatable loan whose loan-to-value is from
   *  its threshold up to the threshold plus `windowBps` is held for an
   *  internal match and every outside liquidation route refuses. Live loans
   *  only; `null` when unread. */
  matchWindow: { enabled: boolean; windowBps: bigint } | null;
  /** The borrower position's lock (`positionLock`); null when unread. */
  borrowerLock: number | null;
  /** The latest block's time, which the actions' rules compare dates with
   *  (never the device clock); null when unread. */
  chainNow: bigint | null;
  /** The current interest period of a running loan with a schedule
   *  (`previewPeriodicSettle`); null when it has none, has ended, or the
   *  read failed (`scheduleUnread` tells the last two apart). */
  schedule: PeriodSchedule | null;
  /** Whether the period read was attempted and failed. */
  scheduleUnread: boolean;
  /** Whether periodic settlement is switched on here
   *  (`getPeriodicInterestEnabled`); null when unread or not asked. */
  periodicOn: boolean | null;
  /** Whether the protocol is paused (`paused`), asked for every running
   *  loan: the pause stops settlement and a default alike; null when unread
   *  or not asked. */
  paused: boolean | null;
}

/** One interest period, as the protocol previews its settlement. */
export interface PeriodSchedule {
  cadence: number;
  /** The period's end, pause credit included. */
  periodEndAt: bigint;
  /** When the period may be settled: its end plus its grace. */
  graceEndsAt: bigint;
  /** The interest for the whole period at the principal and rate as they
   *  stand now. */
  expected: bigint;
  /** Interest the borrower's payments have credited to this period. */
  paid: bigint;
  /** `expected - paid`, never below zero. */
  shortfall: bigint;
  /** The protocol's own "settlement callable now": the grace is over and
   *  the loan is Active. It does not account for the switch or the pause,
   *  which are read beside it. */
  canSettleNow: boolean;
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

  const scheduled = live && cadence !== 0;
  const [
    lender,
    borrower,
    dates,
    periodic,
    periodicOn,
    timingDefaultable,
    admission,
    paused,
    sequencerHealthy,
    healthFactor,
    ltvBps,
    lien,
    saleVehicle,
    matchConfig,
    borrowerLock,
    block,
  ] = await Promise.all([
    maybe(read<Hex>(NFT, 'ownerOf', [loan.lenderTokenId])),
    maybe(read<Hex>(NFT, 'ownerOf', [loan.borrowerTokenId])),
    live ? maybe(read<readonly [bigint, bigint, bigint, bigint]>(LOAN, 'getLoanDeadlines', [loanId])) : null,
    scheduled ? maybe(read<readonly [number, bigint, bigint, bigint, bigint, bigint, boolean]>(PERIODIC, 'previewPeriodicSettle', [loanId])) : null,
    scheduled ? maybe(read<boolean>(NUMERAIRE, 'getPeriodicInterestEnabled')) : null,
    live ? maybe(read<boolean>(DEFAULTED, 'isLoanDefaultable', [loanId])) : null,
    live ? maybe(read<readonly [boolean, Hex]>(DEFAULTED, 'defaultKycAdmission', [loanId])) : null,
    live ? maybe(read<boolean>(ADMIN, 'paused')) : null,
    live ? maybe(read<boolean>(ORACLE, 'sequencerHealthy')) : null,
    live ? maybe(read<bigint>(RISK, 'calculateHealthFactor', [loanId])) : null,
    live ? maybe(read<bigint>(RISK, 'calculateLTV', [loanId])) : null,
    maybe(read<CollateralLien>(METRICS, 'getLoanCollateralLien', [loanId])),
    maybe(read<boolean>(METRICS, 'isSaleVehicleLoan', [loanId])),
    live ? maybe(read<readonly [boolean, bigint, bigint]>(CONFIG, 'getInternalMatchConfigBundle')) : null,
    live ? maybe(read<number>(NFT, 'positionLock', [loan.borrowerTokenId]).then(Number)) : null,
    live ? maybe(client.getBlock({ blockTag: 'latest' })) : null,
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

  const verdict = defaultVerdict({ timing: timingDefaultable, paused, sequencerHealthy, admitted: admission ? admission[0] : null });

  const view: LoanView = {
    loan,
    holders: { lender, borrower },
    deadlines,
    originalMaturity: dates ? dates[0] : null,
    defaultable: verdict.defaultable,
    defaultRefusal: verdict.refusal,
    healthFactor,
    ltvBps,
    lien,
    saleVehicle,
    matchWindow: matchConfig ? { enabled: matchConfig[0], windowBps: matchConfig[1] } : null,
    borrowerLock,
    chainNow: block ? block.timestamp : null,
    schedule: periodic
      ? {
          cadence: Number(periodic[0]),
          periodEndAt: periodic[1],
          graceEndsAt: periodic[2],
          expected: periodic[3],
          paid: periodic[4],
          shortfall: periodic[5],
          canSettleNow: periodic[6],
        }
      : null,
    scheduleUnread: scheduled && periodic === null,
    periodicOn,
    paused,
  };
  return { view };
}
