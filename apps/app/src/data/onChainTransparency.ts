/**
 * #2437 — the VPFI token and treasury-fee figures on /analytics, read from
 * the Diamond itself.
 *
 * The rest of the page reports the indexer's account of the chain. These
 * figures are the chain's own view calls, so they are read from the chain:
 * `VPFITokenFacet.getVPFISnapshot`, `MetricsFacet.getTreasuryMetrics`,
 * `AdminFacet.getTreasury` and `NumeraireConfigFacet.getNumeraireSymbol`.
 *
 * ONE BLOCK, STATED. The block is fixed first and every view is read AT it,
 * in one Multicall3 aggregate, so the figures describe one state of the
 * chain and the page can say which (its number and its timestamp, from
 * which the page states the reading's age). Reading at `latest` and then
 * asking for the block would let the stated block and the figures disagree.
 *
 * NOTHING UNREAD BECOMES ZERO. Each view can fail on its own (a Diamond
 * that does not route it, a revert), and a failed one is carried as
 * `unread`, never as a zero or an empty address. A whole-request failure
 * (the RPC did not answer) rejects, and the page says the chain could not
 * be read. An unbound VPFI token is the chain's own answer, distinct from
 * a failed read.
 *
 * Display only: nothing here feeds a signature or a transaction.
 */
import { getAddress, isAddress, type Address, type PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { readAggregate, type AggregateSlot } from '../contracts/aggregate';
import { numeraireOf, type Numeraire } from './numeraire';

const ZERO = '0x0000000000000000000000000000000000000000';

/** The VPFI token as this chain's Diamond reports it. */
export type VpfiTokenView =
  /** The snapshot view could not be read at this block. */
  | { kind: 'unread' }
  /** The Diamond has no VPFI token bound on this chain. */
  | { kind: 'unbound' }
  /** The chain where VPFI is issued: supply, the cap, and who may mint. */
  | {
      kind: 'canonical';
      token: Address;
      totalSupply: bigint;
      cap: bigint;
      /** What can still be minted before the cap: `cap - totalSupply`. */
      headroom: bigint;
      /** `null` when the token reports no minter. */
      minter: Address | null;
    }
  /** A chain VPFI reaches by bridge: the supply here only. The cap and the
   *  minter exist only where VPFI is issued, so they are not stated. */
  | { kind: 'mirror'; token: Address; totalSupply: bigint };

/** Fees the Diamond has recorded, each valued in the reference currency
 *  (1e18-scaled) when it was collected. */
export type TreasuryFeesView =
  | { kind: 'unread' }
  | {
      kind: 'read';
      total: bigint;
      last24h: bigint;
      last7d: bigint;
      /** The figure the view calls the treasury balance. Meaningful only
       *  when the Diamond is the treasury; see {@link TreasuryView}. */
      held: bigint;
    };

/** Where collected fees go. */
export type TreasuryView =
  | { kind: 'unread' }
  /** No treasury address is set. */
  | { kind: 'unset' }
  /** The Diamond keeps its own fees. */
  | { kind: 'diamond'; address: Address }
  /** Fees are sent on to another address as they are collected. */
  | { kind: 'external'; address: Address };

export interface OnChainTransparency {
  /** The block every figure below was read at. */
  blockNumber: bigint;
  /** That block's timestamp, in seconds. */
  blockTimestamp: number;
  vpfi: VpfiTokenView;
  fees: TreasuryFeesView;
  treasury: TreasuryView;
  /** The reference currency the fee values are in; `null` when it could
   *  not be read or is not printable. */
  numeraire: Numeraire | null;
}

/** The four views, in the order the aggregate reads them. */
export function transparencyReads(diamond: Address) {
  const read = (functionName: string) => ({ address: diamond, abi: DIAMOND_ABI_VIEM, functionName });
  return [
    read('getVPFISnapshot'),
    read('getTreasuryMetrics'),
    read('getTreasury'),
    read('getNumeraireSymbol'),
  ] as const;
}

const asBigint = (v: unknown): bigint | null => (typeof v === 'bigint' && v >= 0n ? v : null);
const asAddress = (v: unknown): Address | null =>
  typeof v === 'string' && isAddress(v, { strict: false }) ? getAddress(v) : null;

/** The token view from the snapshot slot. A result whose shape is not the
 *  view's is treated as unread rather than guessed at. */
export function vpfiTokenOf(slot: AggregateSlot): VpfiTokenView {
  if (slot.status !== 'success' || !Array.isArray(slot.result)) return { kind: 'unread' };
  const [tokenRaw, canonical, supplyRaw, capRaw, headroomRaw, minterRaw] = slot.result as unknown[];
  const token = asAddress(tokenRaw);
  const totalSupply = asBigint(supplyRaw);
  if (token === null || typeof canonical !== 'boolean' || totalSupply === null) return { kind: 'unread' };
  if (token === ZERO) return { kind: 'unbound' };
  if (!canonical) return { kind: 'mirror', token, totalSupply };
  const cap = asBigint(capRaw);
  const headroom = asBigint(headroomRaw);
  const minter = asAddress(minterRaw);
  // The view computes headroom as cap - supply; an answer where that does
  // not hold is not the view's, and is not shown as if it were.
  if (cap === null || headroom === null || minter === null || cap - totalSupply !== headroom) {
    return { kind: 'unread' };
  }
  return { kind: 'canonical', token, totalSupply, cap, headroom, minter: minter === ZERO ? null : minter };
}

export function treasuryFeesOf(slot: AggregateSlot): TreasuryFeesView {
  if (slot.status !== 'success' || !Array.isArray(slot.result)) return { kind: 'unread' };
  const [held, total, last24h, last7d] = (slot.result as unknown[]).map(asBigint);
  if (held == null || total == null || last24h == null || last7d == null) return { kind: 'unread' };
  return { kind: 'read', total, last24h, last7d, held };
}

export function treasuryOf(slot: AggregateSlot, diamond: Address): TreasuryView {
  if (slot.status !== 'success') return { kind: 'unread' };
  const address = asAddress(slot.result);
  if (address === null) return { kind: 'unread' };
  if (address === ZERO) return { kind: 'unset' };
  return address === getAddress(diamond) ? { kind: 'diamond', address } : { kind: 'external', address };
}

export function numeraireFrom(slot: AggregateSlot): Numeraire | null {
  return slot.status === 'success' && typeof slot.result === 'string' ? numeraireOf(slot.result) : null;
}

/**
 * Read every figure at one block. Rejects when the chain could not be
 * reached; a view that failed on its own comes back `unread`.
 */
export async function readOnChainTransparency(
  publicClient: Pick<PublicClient, 'chain' | 'readContract' | 'getBlock'>,
  diamond: Address,
): Promise<OnChainTransparency> {
  const block = await publicClient.getBlock({ blockTag: 'latest' });
  if (block.number === null) throw new Error('the latest block has no number');
  const [snapshot, metrics, treasury, numeraire] = await readAggregate(
    publicClient,
    transparencyReads(diamond),
    block.number,
  );
  return {
    blockNumber: block.number,
    blockTimestamp: Number(block.timestamp),
    vpfi: vpfiTokenOf(snapshot),
    fees: treasuryFeesOf(metrics),
    treasury: treasuryOf(treasury, diamond),
    numeraire: numeraireFrom(numeraire),
  };
}
