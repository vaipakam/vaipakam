/**
 * RW-11, RW-13, RW-14 — the wallet's fee-discount tier on the protocol's other networks
 * (#3579, from the protocol rule of #1277).
 *
 * VPFI's home network works the tier out; every other network the protocol
 * serves keeps a copy, sent to it as a cross-network message. The protocol
 * pays for a message only when it LOWERS what another network grants (a
 * discount must never outlive the VPFI behind it). A raise, a first
 * discount, or a copy under a new tier table goes out only when someone
 * pays its message fee. Until then the other network keeps what it last
 * received, and a copy from an older tier table counts there as no
 * discount at all.
 *
 * Nothing here is worked out by the app. The protocol's own answer
 * (`getTierPushStatus`) gives the tier last recorded for sending, and for
 * each network what it last received, whether it is still owed the
 * recorded tier, and whether the protocol pays for that message. The fee
 * for each owed network is the messenger's own quote at the same block.
 * The tier the protocol applies now (`getEffectiveDiscount`) says whether
 * the record is behind (the tier moves with time, and only a step on the
 * home network records a new one). The tier table's version has no
 * reader, so a record that is behind only on the version cannot be told
 * apart here; the page says so rather than claim the record is current.
 */
import { decodeEventLog, type Abi, type PublicClient, type TransactionReceipt } from 'viem';
import { ProtocolBroadcastFacetABI, RewardReporterFacetABI, VaipakamRewardMessengerABI } from '@vaipakam/contracts/abis';
import { VPFI_DISCOUNT_ABI } from '../consent/feeDiscount';
import { answerOrNull } from '../reads/answer';
import { MAX_DISCOUNT_BPS } from './tiers';

type Hex = `0x${string}`;

export const BROADCAST_ABI = ProtocolBroadcastFacetABI as Abi;
const REPORTER = RewardReporterFacetABI as Abi;
const MESSENGER = VaipakamRewardMessengerABI as Abi;

export const STATUS_SIGNATURE = 'getTierPushStatus(address)';
export const DELIVER_SIGNATURE = 'deliverTierPush(address)';
export const POKE_SIGNATURE = 'pokeMyTier()';
/** Removed by #1277 with the old spacing rule: a Diamond that still routes
 *  it reports lanes in the older shape, which this page does not read. */
export const RETIRED_SPACING_SIGNATURE = 'getTierPushSpacingSec()';

/** The margin added to the quoted fees before sending: a fee moves with the
 *  other network's gas price between this read and the block the send
 *  lands in, and whatever is not spent comes back in the same transaction. */
export const FEE_MARGIN_BPS = 2_000n;

/** A sentinel the protocol stores for a tier that has no end. */
const NO_EXPIRY = 2 ** 40 - 1;

/** What one other network last received from the home network. */
export interface Delivered {
  nonce: bigint;
  tier: number;
  bps: bigint;
  /** When the copy stops counting there (null: no end), as the home
   *  network sent it. */
  expiresAt: number | null;
  version: number;
  sentAt: number;
}

/** One other network, as the protocol reports it, with the fee its owed
 *  message costs now. */
export interface TierLane {
  chainId: number;
  delivered: Delivered;
  owed: boolean;
  budgetPays: boolean;
  /** The messenger's fee for the owed message, in the native gas token;
   *  null when nothing is owed or the quote refused. */
  fee: bigint | null;
}

/** The tier last recorded for sending. */
export interface Recorded {
  nonce: bigint;
  tier: number;
  bps: bigint;
  expiresAt: number | null;
  version: number;
}

/** Where the list of networks behind `lanes` stands. The protocol's status
 *  returns no lanes alike when no messenger is set, when the messenger's
 *  list refuses, and when the list is empty, so an empty `lanes` is told
 *  apart by reading the messenger and its list directly:
 *  - `listed`: the lanes are the messenger's networks;
 *  - `none`: the messenger lists no network;
 *  - `no-messenger`: no messenger is set, so nothing is recorded or sent;
 *  - `unreadable`: the list refused (or disagreed with the status at the
 *    same block), so whether any network is owed is unknown. */
export type Destinations = 'listed' | 'none' | 'no-messenger' | 'unreadable';

const ZERO = '0x0000000000000000000000000000000000000000';

export interface TierPushCard {
  recorded: Recorded;
  lanes: readonly TierLane[];
  destinations: Destinations;
  /** The tier and discount the protocol applies on this network now; null
   *  when it could not be read. */
  effective: { tier: number; bps: bigint } | null;
  blockNumber: bigint;
  blockTime: number;
}

type RawLane = {
  destChainId: bigint;
  delivered: { nonce: bigint; tier: number; bps: number; tierExpirySec: number; tierTableVersion: number; sentAt: number };
  owed: boolean;
  budgetPays: boolean;
};
type RawStatus = readonly [bigint, number, number, number, number, readonly RawLane[]];

const expiry = (sec: number): number | null => (Number(sec) === NO_EXPIRY || Number(sec) === 0 ? null : Number(sec));

export function recordedOf(r: RawStatus): Recorded {
  return { nonce: r[0], tier: Number(r[1]), bps: BigInt(r[2]), expiresAt: expiry(r[3]), version: Number(r[4]) };
}

export function deliveredOf(d: RawLane['delivered']): Delivered {
  return {
    nonce: d.nonce,
    tier: Number(d.tier),
    bps: BigInt(d.bps),
    expiresAt: expiry(d.tierExpirySec),
    version: Number(d.tierTableVersion),
    sentAt: Number(d.sentAt),
  };
}

/** The protocol's status for `account`, the tier it applies now, and the
 *  fee for each owed network, all read at one block. A quote that refuses
 *  leaves that network's fee unknown; a source that fails is thrown, so
 *  the own rail moves on to its next source. `pinned` reads at that block
 *  (a receipt's) instead of the latest. */
export async function readTierPush(c: PublicClient, diamond: Hex, account: Hex, pinned?: bigint): Promise<TierPushCard> {
  const blockNumber = pinned ?? (await c.getBlockNumber({ cacheTime: 0 }));
  const at = { blockNumber };
  const [block, status, eff] = await Promise.all([
    c.getBlock(at),
    c.readContract({ address: diamond, abi: BROADCAST_ABI, functionName: 'getTierPushStatus', args: [account], ...at }) as Promise<RawStatus>,
    answerOrNull(
      c.readContract({ address: diamond, abi: VPFI_DISCOUNT_ABI, functionName: 'getEffectiveDiscount', args: [account], ...at }) as Promise<
        readonly [number, number]
      >,
    ),
  ]);
  const recorded = recordedOf(status);
  const blockTime = Number(block.timestamp);
  const owed = status[5].some((l) => l.owed);
  const empty = status[5].length === 0;
  const messenger =
    owed || empty
      ? ((await c.readContract({ address: diamond, abi: REPORTER, functionName: 'getRewardReporterConfig', ...at })) as readonly [Hex, ...unknown[]])[0]
      : null;
  let destinations: Destinations = 'listed';
  if (empty) {
    if (messenger === null || messenger.toLowerCase() === ZERO) destinations = 'no-messenger';
    else {
      const list = await answerOrNull(
        c.readContract({ address: messenger, abi: MESSENGER, functionName: 'getBroadcastDestinations', ...at }) as Promise<readonly bigint[]>,
      );
      destinations = list !== null && list.length === 0 ? 'none' : 'unreadable';
    }
  }
  const lanes = await Promise.all(
    status[5].map(async (l): Promise<TierLane> => {
      const fee =
        l.owed && messenger && messenger.toLowerCase() !== ZERO
          ? ((await answerOrNull(
              c.readContract({
                address: messenger,
                abi: MESSENGER,
                functionName: 'quoteSendTierUpdateTo',
                args: [l.destChainId, account, recorded.tier, Number(recorded.bps), blockTime, recorded.nonce, status[3], recorded.version],
                ...at,
              }) as Promise<bigint>,
            )) ?? null)
          : null;
      return { chainId: Number(l.destChainId), delivered: deliveredOf(l.delivered), owed: l.owed, budgetPays: l.budgetPays, fee };
    }),
  );
  return { recorded, lanes, destinations, effective: eff === null ? null : { tier: Number(eff[0]), bps: BigInt(eff[1]) }, blockNumber, blockTime };
}

/** Whether the Diamond serves this page's rule (#1277): it routes the
 *  status and the paid send, and no longer the retired spacing rule.
 *  `unknown` until the routing has been read. */
export type TierPushSupport = 'unknown' | 'present' | 'predates' | 'absent';

export function tierPushSupport(routed: ReadonlySet<Hex> | null, sel: (signature: string) => Hex): TierPushSupport {
  if (routed === null) return 'unknown';
  if (!routed.has(sel(STATUS_SIGNATURE))) return 'absent';
  if (routed.has(sel(RETIRED_SPACING_SIGNATURE))) return 'predates';
  return routed.has(sel(DELIVER_SIGNATURE)) ? 'present' : 'predates';
}

/** How one other network stands against the recorded tier. */
export type LaneStanding =
  /** It holds the recorded tier (or the same effect). */
  | 'current'
  /** It is owed a message that lowers its discount; the protocol pays. */
  | 'protocol-pays'
  /** It is owed a message only a paid send delivers (a raise, a first
   *  discount or a new tier table). */
  | 'needs-paid-send';

export function laneStanding(l: TierLane): LaneStanding {
  if (!l.owed) return 'current';
  return l.budgetPays ? 'protocol-pays' : 'needs-paid-send';
}

/** Whether a message was ever sent on this lane. Only the send time proves
 *  one: a lane whose record grants no discount is settled without a message
 *  (its record number moves, nothing is sent), so a non-zero record number
 *  alone says nothing about a send. */
export function laneSent(l: Pick<TierLane, 'delivered'>): boolean {
  return l.delivered.sentAt !== 0;
}

/** Whether the record for sending is behind the tier the protocol applies
 *  now: `behind` when they differ (an update records the new one), `same`
 *  when they match, `unknown` when the tier now could not be read. The
 *  recorded figure is the uncapped one; the applied one is capped at the
 *  uniform ceiling, so the cap is applied before comparing. */
export function recordStanding(card: Pick<TierPushCard, 'recorded' | 'effective'>): 'behind' | 'same' | 'unknown' {
  const { recorded, effective } = card;
  if (effective === null) return 'unknown';
  if (recorded.nonce === 0n) return effective.tier === 0 && effective.bps === 0n ? 'same' : 'behind';
  const capped = recorded.bps > MAX_DISCOUNT_BPS ? MAX_DISCOUNT_BPS : recorded.bps;
  return recorded.tier === effective.tier && capped === effective.bps ? 'same' : 'behind';
}

/** The paid send's size: every owed network's fee, because the value pays
 *  owed networks first in the protocol's order, including any the protocol
 *  would have paid for, plus the margin. `null` when no network is owed or
 *  an owed network's fee could not be quoted (the send is then withheld:
 *  too little value leaves a network owed without saying which). */
export interface PaidSend {
  /** The sum of the quoted fees. */
  quoted: bigint;
  /** What the wallet sends: the quoted fees plus the margin. */
  value: bigint;
  /** The networks it is meant to reach. */
  chainIds: readonly number[];
}

export function paidSend(lanes: readonly TierLane[]): PaidSend | 'nothing-owed' | 'unquoted' {
  const owed = lanes.filter((l) => l.owed);
  if (owed.length === 0) return 'nothing-owed';
  if (owed.some((l) => l.fee === null)) return 'unquoted';
  const quoted = owed.reduce((sum, l) => sum + l.fee!, 0n);
  return { quoted, value: quoted + (quoted * FEE_MARGIN_BPS) / 10_000n, chainIds: owed.map((l) => l.chainId) };
}

/** What a paid send's receipt says the wallet paid: the fee of every
 *  message the wallet's value carried (`ProtocolTierBroadcastSent` with
 *  `callerFunded`), for `account`, from the Diamond. The rest of the value
 *  came back in the same transaction. */
export function paidByCaller(receipt: Pick<TransactionReceipt, 'logs'>, diamond: Hex, account: Hex): bigint {
  let paid = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== diamond.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: BROADCAST_ABI, data: log.data, topics: log.topics });
      if (ev.eventName !== 'ProtocolTierBroadcastSent') continue;
      const a = ev.args as unknown as { user: Hex; feePaid: bigint; callerFunded: boolean };
      if (a.callerFunded && a.user.toLowerCase() === account.toLowerCase()) paid += a.feePaid;
    } catch {
      // Another event of the Diamond's.
    }
  }
  return paid;
}
