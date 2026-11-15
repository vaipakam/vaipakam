/**
 * RW-74 / RW-75 — the protocol's public figures on one network, read from
 * its contracts at ONE block (RB-ANALYTICS). A public read (RB-PUBLIC): no
 * wallet and nobody's own state, through the network's read-only proxy or
 * its public endpoint.
 *
 * Every group of figures is settled on its own, so one view that fails is
 * stated as unread beside the ones that answered, never shown as zero. The
 * lifetime lending totals are valued asset by asset by the protocol's own
 * valuation rule at the same block, so the page can show the headline as
 * the sum of the parts it lists plus the assets the rule could not value.
 */
import { hexToString, type Abi, type PublicClient } from 'viem';
import { AdminFacetABI, ConfigFacetABI, MetricsFacetABI, NumeraireConfigFacetABI, NumeraireValueFacetABI } from '@vaipakam/contracts/abis';
import type { SupportedChain } from '../../chain/chains';
import { isContractAnswer } from '../reads/answer';
import { readTokenMeta, type TokenMetaMap } from '../reads/tokens';

type Hex = `0x${string}`;

const METRICS = MetricsFacetABI as Abi;
const CONFIG = ConfigFacetABI as Abi;
const ADMIN = AdminFacetABI as Abi;
const NUMERAIRE = NumeraireConfigFacetABI as Abi;
const VALUE = NumeraireValueFacetABI as Abi;

const ZERO = '0x0000000000000000000000000000000000000000';

/** The most fee records a window figure scans, newest first
 *  (`LibVaipakam.MAX_FEE_EVENTS_ITER`); past it the figure is a lower bound. */
export const FEE_WINDOW_SCAN_LIMIT = 10_000;

/** One group of figures: what the view answered, or why it did not. */
export type Figure<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface ProtocolStats {
  users: bigint;
  activeLoans: bigint;
  activeOffers: bigint;
  loansOpened: bigint;
  /** 1e18 numeraire, valued now; an asset the rule cannot value counts 0. */
  volumeLent: bigint;
  interestPaid: bigint;
  /** Basis points of loans opened; meaningless while none were opened. */
  defaultRateBps: bigint;
  averageRateBps: bigint;
}

export interface LockedValue {
  /** 1e18 numeraire: principal of open ERC-20 loans plus their ERC-20 collateral. */
  total: bigint;
  erc20Collateral: bigint;
  /** A COUNT of open loans whose collateral is an NFT (valued at nothing). */
  nftCollateralLoans: bigint;
}

export interface ProtocolHealth {
  utilizationBps: bigint;
  collateral: bigint;
  debt: bigint;
  paused: boolean;
}

/** What the valuation rule answered for one amount at the read block. */
export type AssetValue = { kind: 'value'; value: bigint } | { kind: 'refused' } | { kind: 'unread'; reason: string };

export interface AssetLifetime {
  asset: Hex;
  principalLent: bigint;
  interestPaid: bigint;
  lentValue: AssetValue;
  interestValue: AssetValue;
}

/** Where the protocol's fees go (the treasury its vault code names). */
export type Custody = { kind: 'unset' } | { kind: 'diamond'; address: Hex } | { kind: 'external'; address: Hex };

export interface TreasuryFigures {
  /** 1e18 numeraire. Held balance counts only assets on open loans and only
   *  means anything while the protocol contract keeps fees itself. */
  heldOnOpenLoanAssets: bigint;
  feesSinceStart: bigint;
  feesLastDay: bigint;
  feesLastWeek: bigint;
}

export interface ConvertConfig {
  targets: readonly { asset: Hex; bps: number }[];
  lastConversionAt: bigint;
}

export interface ProtocolFigures {
  block: { number: bigint; timestamp: bigint };
  /** When this deployment's first block was made: the counters start there. */
  deployedAt: Figure<bigint>;
  /** The reference currency's display symbol, or null when unset. */
  symbol: Figure<string | null>;
  stats: Figure<ProtocolStats>;
  locked: Figure<LockedValue>;
  health: Figure<ProtocolHealth>;
  offersPosted: Figure<bigint>;
  assets: Figure<{ rows: AssetLifetime[]; meta: TokenMetaMap }>;
  custody: Figure<Custody>;
  feeRates: Figure<{ treasuryShareBps: bigint; loanStartFeeBps: bigint }>;
  treasury: Figure<TreasuryFigures>;
  convert: Figure<ConvertConfig>;
}

function reason(e: unknown): string {
  const msg = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return msg.split('\n')[0]!.slice(0, 160);
}

function settle<T>(r: PromiseSettledResult<T>): Figure<T> {
  return r.status === 'fulfilled' ? { ok: true, value: r.value } : { ok: false, reason: reason(r.reason) };
}

async function valueOf(c: PublicClient, diamond: Hex, asset: Hex, amount: bigint, blockNumber: bigint): Promise<AssetValue> {
  try {
    // Rounded down: the rule the protocol's own totals apply (`valueOrZero`).
    const value = (await c.readContract({
      address: diamond,
      abi: VALUE,
      functionName: 'getNumeraireValue',
      args: [asset, amount, false],
      blockNumber,
    })) as bigint;
    return { kind: 'value', value };
  } catch (e) {
    return isContractAnswer(e) ? { kind: 'refused' } : { kind: 'unread', reason: reason(e) };
  }
}

/** Custody from the treasury address the protocol reports. */
export function custodyOf(treasury: string, diamond: string): Custody {
  if (treasury.toLowerCase() === ZERO) return { kind: 'unset' };
  if (treasury.toLowerCase() === diamond.toLowerCase()) return { kind: 'diamond', address: treasury as Hex };
  return { kind: 'external', address: treasury as Hex };
}

export async function readProtocolFigures(c: PublicClient, chain: SupportedChain): Promise<ProtocolFigures> {
  const diamond = chain.diamondAddress;
  // One block for every figure, so the parts and their totals describe the
  // same moment. A failure to learn the block fails the whole read.
  const block = await c.getBlock();
  const blockNumber = block.number;
  const read = <T>(abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    c.readContract({ address: diamond, abi, functionName, args, blockNumber }) as Promise<T>;

  const assets = async () => {
    const list = await read<readonly Hex[]>(METRICS, 'getLifetimeLendingAssets');
    const [rows, meta] = await Promise.all([
      Promise.all(
        list.map(async (asset) => {
          const [principalLent, interestPaid] = await read<readonly [bigint, bigint]>(METRICS, 'getLifetimeLendingTotals', [asset]);
          const [lentValue, interestValue] = await Promise.all([
            valueOf(c, diamond, asset, principalLent, blockNumber),
            valueOf(c, diamond, asset, interestPaid, blockNumber),
          ]);
          return { asset, principalLent, interestPaid, lentValue, interestValue };
        }),
      ),
      readTokenMeta(c, list),
    ]);
    return { rows, meta };
  };

  const [deployedAt, symbol, stats, locked, health, offersPosted, assetRows, custody, feeRates, treasury, convert] = await Promise.allSettled([
    c.getBlock({ blockNumber: BigInt(chain.deployBlock) }).then((b) => b.timestamp),
    read<Hex>(NUMERAIRE, 'getNumeraireSymbol').then((raw) => {
      const text = hexToString(raw, { size: 32 }).replace(/\0+$/, '');
      return text.length > 0 ? text : null;
    }),
    read<readonly bigint[]>(METRICS, 'getProtocolStats').then(
      ([users, activeLoans, activeOffers, loansOpened, volumeLent, interestPaid, defaultRateBps, averageRateBps]): ProtocolStats => ({
        users: users!,
        activeLoans: activeLoans!,
        activeOffers: activeOffers!,
        loansOpened: loansOpened!,
        volumeLent: volumeLent!,
        interestPaid: interestPaid!,
        defaultRateBps: defaultRateBps!,
        averageRateBps: averageRateBps!,
      }),
    ),
    read<readonly bigint[]>(METRICS, 'getProtocolTVL').then(([total, erc20Collateral, nftCollateralLoans]) => ({
      total: total!,
      erc20Collateral: erc20Collateral!,
      nftCollateralLoans: nftCollateralLoans!,
    })),
    read<readonly [bigint, bigint, bigint, boolean]>(METRICS, 'getProtocolHealth').then(([utilizationBps, collateral, debt, paused]) => ({
      utilizationBps,
      collateral,
      debt,
      paused,
    })),
    read<readonly [bigint, bigint]>(METRICS, 'getGlobalCounts').then(([, offers]) => offers),
    assets(),
    read<Hex>(ADMIN, 'getTreasury').then((t) => custodyOf(t, diamond)),
    Promise.all([read<bigint>(CONFIG, 'getTreasuryFeeBps'), read<bigint>(CONFIG, 'getLoanInitiationFeeBps')]).then(([treasuryShareBps, loanStartFeeBps]) => ({
      treasuryShareBps,
      loanStartFeeBps,
    })),
    read<readonly bigint[]>(METRICS, 'getTreasuryMetrics').then(([held, total, day, week]) => ({
      heldOnOpenLoanAssets: held!,
      feesSinceStart: total!,
      feesLastDay: day!,
      feesLastWeek: week!,
    })),
    read<readonly [readonly { asset: Hex; bps: number }[], bigint, bigint, bigint]>(CONFIG, 'getTreasuryConvertConfig').then(
      ([targets, , , lastConversionAt]) => ({
        targets: targets.map((t) => ({ asset: t.asset, bps: Number(t.bps) })),
        lastConversionAt,
      }),
    ),
  ]);

  return {
    block: { number: block.number, timestamp: block.timestamp },
    deployedAt: settle(deployedAt),
    symbol: settle(symbol),
    stats: settle(stats),
    locked: settle(locked),
    health: settle(health),
    offersPosted: settle(offersPosted),
    assets: settle(assetRows),
    custody: settle(custody),
    feeRates: settle(feeRates),
    treasury: settle(treasury),
    convert: settle(convert),
  };
}

/** The lifetime headline as its listed parts: the sum of what the rule
 *  valued, the assets it refused (counted 0 by the protocol), and the ones
 *  whose valuation could not be read. `matches` compares that sum with the
 *  protocol's own headline at the same block. */
export function headlineParts(rows: readonly AssetLifetime[], pick: 'lent' | 'interest', headline: bigint) {
  let valued = 0n;
  const refused: Hex[] = [];
  const unread: Hex[] = [];
  for (const r of rows) {
    const amount = pick === 'lent' ? r.principalLent : r.interestPaid;
    const v = pick === 'lent' ? r.lentValue : r.interestValue;
    if (v.kind === 'value') valued += v.value;
    else if (amount === 0n) continue;
    else if (v.kind === 'refused') refused.push(r.asset);
    else unread.push(r.asset);
  }
  return { valued, refused, unread, matches: unread.length > 0 ? null : valued === headline };
}

/** A ratio the protocol reports as 0 when it has nothing to divide by is
 *  "none yet", never "0 %": loans opened for the default and average rates,
 *  priced collateral for utilisation. */
export function rateOrNone(bps: bigint, base: bigint): { kind: 'rate'; bps: bigint } | { kind: 'none' } {
  return base === 0n ? { kind: 'none' } : { kind: 'rate', bps };
}
