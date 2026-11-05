/**
 * Home's reads (RW-70, ACC-31). The wallet's positions, payouts and offers
 * are OWN state: read through the own rail (`useOwnRead`), bound to the
 * connected identity and chain, from the protocol's dashboard views, which
 * walk the wallet's own index. The protocol's pause posture and numeraire
 * are chain reads that belong to no one (`useChainRead`).
 *
 * Every walk is the full index (`scanAll`) up to a stated cap, and a walk the
 * cap stopped is reported incomplete, never shown as all of it. A per-loan
 * figure that could not be read (a deadline, a value) is `null`, never 0.
 */
import { hexToString, type Abi, type PublicClient } from 'viem';
import { AdminFacetABI, LoanFacetABI, MetricsDashboardFacetABI, NumeraireConfigFacetABI, NumeraireValueFacetABI } from '@vaipakam/contracts/abis';
import { scanAll } from '../../shared/reads/scan';
import { ASSET_ERC20, type Deadlines, type LiveLoanRow, type LoanSummary } from './model';

const DASHBOARD = MetricsDashboardFacetABI as Abi;
const LOAN = LoanFacetABI as Abi;
const VALUE = NumeraireValueFacetABI as Abi;
const ADMIN = AdminFacetABI as Abi;
const NUMERAIRE = NumeraireConfigFacetABI as Abi;

/** Index rows per call. The loan walk prices every live row inside the view
 *  (two risk reads each), so it reads fewer rows per call than the cheap
 *  walks; both stay under the view's own page limit (100). */
const LOAN_SCAN = 50;
const CHEAP_SCAN = 100;
/** Calls per walk before it stops and says so (5,000 index rows at most). */
const MAX_PAGES = 50;

type Hex = `0x${string}`;

/** Every promise settled, each as its value or `null`: one figure that could
 *  not be read never sinks the others, and is never read as zero. */
async function settled<T>(promises: readonly Promise<T>[]): Promise<(T | null)[]> {
  return (await Promise.allSettled(promises)).map((r) => (r.status === 'fulfilled' ? r.value : null));
}

export interface LiveLoans {
  rows: LiveLoanRow[];
  complete: boolean;
  /** Keyed by loan id as a decimal string; null = the read failed. */
  deadlines: Readonly<Record<string, Deadlines | null>>;
  /** Each loan's principal in the numeraire (1e18), a debt rounded up and an
   *  asset rounded down; null = the protocol could not value it now (an NFT
   *  leg, an unpriced asset, or a failed read). */
  values: Readonly<Record<string, bigint | null>>;
}

export async function readLiveLoans(client: PublicClient, diamond: Hex, account: Hex): Promise<LiveLoans> {
  const { rows, complete } = await scanAll<LiveLoanRow>(
    async (cursor, maxScan) => {
      const [page, nextCursor] = (await client.readContract({
        address: diamond,
        abi: DASHBOARD,
        functionName: 'getUserDashboardLoansBothSides',
        args: [account, cursor, maxScan],
      })) as [readonly { loan: LoanSummary; healthFactor: bigint; borrowerSide: boolean }[], bigint];
      return { rows: page.map((r) => ({ loan: r.loan, healthFactor: r.healthFactor, borrowerSide: r.borrowerSide })), nextCursor };
    },
    { maxScan: LOAN_SCAN, maxPages: MAX_PAGES },
  );
  const [deadlineList, valueList] = await Promise.all([
    settled(
      rows.map(async (r) => {
        const [, pauseCredit, maturity, graceEnd] = (await client.readContract({
          address: diamond,
          abi: LOAN,
          functionName: 'getLoanDeadlines',
          args: [r.loan.id],
        })) as [bigint, bigint, bigint, bigint];
        return { maturity, graceEnd, pauseCredit } satisfies Deadlines;
      }),
    ),
    settled(
      rows.map(async (r) => {
        if (r.loan.assetType !== ASSET_ERC20) throw new Error('an NFT leg has no numeraire value');
        return (await client.readContract({
          address: diamond,
          abi: VALUE,
          functionName: 'getNumeraireValue',
          args: [r.loan.principalAsset, r.loan.principal, r.borrowerSide],
        })) as bigint;
      }),
    ),
  ]);
  const deadlines: Record<string, Deadlines | null> = {};
  const values: Record<string, bigint | null> = {};
  rows.forEach((r, i) => {
    deadlines[r.loan.id.toString()] = deadlineList[i] ?? null;
    values[r.loan.id.toString()] = valueList[i] ?? null;
  });
  return { rows, complete, deadlines, values };
}

export interface PayoutRow {
  loanId: bigint;
  side: 'lender' | 'borrower';
  asset: Hex;
  assetType: number;
}

export interface Payouts {
  rows: PayoutRow[];
  complete: boolean;
}

/** Every loan where a claim call would pay the wallet now, on either side
 *  (the protocol's own pending rule, #941). The view's row is the claim's
 *  primary lane only, so Home names the payout and leaves its amounts to
 *  Claims, which reads every lane. */
export async function readPayouts(client: PublicClient, diamond: Hex, account: Hex): Promise<Payouts> {
  const side = (borrowerSide: boolean) =>
    scanAll<PayoutRow>(
      async (cursor, maxScan) => {
        const [loanIds, claims, nextCursor] = (await client.readContract({
          address: diamond,
          abi: DASHBOARD,
          functionName: 'getUserDashboardClaimables',
          args: [account, borrowerSide, cursor, maxScan],
        })) as [readonly bigint[], readonly { asset: Hex; assetType: number }[], bigint];
        return {
          rows: loanIds.map((loanId, i) => ({ loanId, side: borrowerSide ? 'borrower' : 'lender', asset: claims[i]!.asset, assetType: claims[i]!.assetType }) as PayoutRow),
          nextCursor,
        };
      },
      { maxScan: CHEAP_SCAN, maxPages: MAX_PAGES },
    );
  const [lender, borrower] = await Promise.all([side(false), side(true)]);
  return { rows: [...lender.rows, ...borrower.rows].sort((a, b) => (a.loanId < b.loanId ? -1 : a.loanId > b.loanId ? 1 : 0)), complete: lender.complete && borrower.complete };
}

export interface OpenOffer {
  id: bigint;
  offerType: number;
  createdAt: bigint;
  expiresAt: bigint;
  lendingAsset: Hex;
  assetType: number;
  amount: bigint;
  amountMax: bigint;
  amountFilled: bigint;
  interestRateBps: bigint;
  interestRateBpsMax: bigint;
  durationDays: bigint;
  tokenId: bigint;
}

export interface OpenOffers {
  rows: OpenOffer[];
  complete: boolean;
}

/** The wallet's own offers that are still open (not accepted, not consumed
 *  by a sale), newest first. */
export async function readOpenOffers(client: PublicClient, diamond: Hex, account: Hex): Promise<OpenOffers> {
  const { rows, complete } = await scanAll<OpenOffer>(
    async (cursor, maxScan) => {
      const [page, nextCursor] = (await client.readContract({
        address: diamond,
        abi: DASHBOARD,
        functionName: 'getUserDashboardOffers',
        args: [account, false, cursor, maxScan],
      })) as [readonly OpenOffer[], bigint];
      return { rows: [...page], nextCursor };
    },
    { maxScan: CHEAP_SCAN, maxPages: MAX_PAGES },
  );
  return { rows: rows.sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)), complete };
}

export interface ProtocolPosture {
  paused: boolean;
  /** When an automatic pause window ends (unix seconds); 0 when none runs. */
  pausedUntil: bigint;
  keepersPaused: boolean;
}

export async function readPosture(client: PublicClient, diamond: Hex): Promise<ProtocolPosture> {
  const call = (functionName: string) => client.readContract({ address: diamond, abi: ADMIN, functionName });
  const [paused, pausedUntil, keepersPaused] = await Promise.all([call('paused'), call('pausedUntil'), call('keepersPaused')]);
  return { paused: paused as boolean, pausedUntil: pausedUntil as bigint, keepersPaused: keepersPaused as boolean };
}

/** The numeraire's display symbol ("USD"), or null when unset or unreadable. */
export async function readNumeraireSymbol(client: PublicClient, diamond: Hex): Promise<string | null> {
  const raw = (await client.readContract({ address: diamond, abi: NUMERAIRE, functionName: 'getNumeraireSymbol' })) as Hex;
  const text = hexToString(raw, { size: 32 }).replace(/\0+$/, '');
  return text.length > 0 ? text : null;
}
