// apps/keeper/src/tierPushRetry.ts
//
// #2984 — the TIER-PUSH RETRY, step 4 of `protocolUpkeep`: the keeper's call
// of `ProtocolBroadcastFacet.deliverTierPush(user)` for a tier push a lane is
// still owed (`docs/DesignsAndPlans/TierPushDeliveryDesign.md`).
//
// Base commits a user's new effective tier and delivers it to each broadcast
// lane inside the user's own action. A lane it cannot pay or reach there
// stays OWED and the facet says so with `TierPushDeferred`: the protocol
// budget was short, the lane's spacing window had not elapsed, or its quote
// or send reverted. Nothing delivers an owed push afterwards unless something
// calls `deliverTierPush`, so without a caller the mirror keeps the tier it
// last received until the user's tier changes again.
//
// Per chain, per run:
//
//   1. NOMINATE — no view lists the owed lanes, so the indexer's ledger of
//      `TierPushDeferred` nominates them: a page a run, rotating above a
//      stored floor every row before which names a push no longer owed on its
//      lane (`ledgerRotation.ts`; the floor moves only on what the finalized
//      block shows).
//   2. READ — each nominated user's push and lanes (`getTierPushStatus`): the
//      contract's own word on which lanes are owed and when the protocol
//      budget may next pay each one.
//   3. PRICE — each owed lane the budget may pay now, quoted by the reward
//      messenger, against what the budget holds. The keeper attaches no value
//      (it spends no capital of its own), so only a lane the budget can pay
//      can be delivered; a user with none is not sent, since the call would
//      only defer the same lanes again.
//   4. DELIVER — `deliverTierPush(user)`, simulated first, one user at a
//      time from a point that moves each run. The contract decides each lane
//      again. A lane's quoted fee counts against the budget only once a
//      receipt shows that lane sent, so a delivery that spends nothing holds
//      back no later user. The run's line names, from the receipt, each lane
//      sent or settled, each left owed with its reason, and each delivery
//      that found nothing left to do.
//
// Every call is permissionless and moves no value of the keeper's; the
// protocol budget pays each lane's CCIP fee under the facet's own rule.
//
// Gated by KEEPER_ENABLED + PROTOCOL_UPKEEP_ENABLED + TIER_PUSH_RETRY_ENABLED.
// Ships disarmed.

import { decodeEventLog, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { ProtocolBroadcastFacetABI, RewardReporterFacetABI, VaipakamRewardMessengerABI } from '@vaipakam/contracts/abis';
import { deadlineClient, PastRunDeadline, settledChunkedRead, settledRead } from './batchRead';
import { shortErr } from './callErrors';
import { boundedCall } from './passReader';
import type { EventLedger } from './eventLedger';
import { readLedgerRotation, type LedgerRotation } from './ledgerRotation';
import { priorStageCutoffMs, readCutoffMs } from './runWindow';
import type { FinalBlock, ScanCursors } from './scanCursors';
import type { StepSender } from './stepSender';

export const TIER_PUSH_ABI = [...(ProtocolBroadcastFacetABI as Abi), ...(RewardReporterFacetABI as Abi)] as Abi;
const MESSENGER_ABI = VaipakamRewardMessengerABI as Abi;

/** Ledger rows of deferrals read per run, rotating above the floor. */
export const DEFERRAL_PAGE = 200;
export const DEFERRAL_FLOOR_ITEM = 'tier-push-floor';
export const DEFERRAL_NEXT_ITEM = 'tier-push-next';
const DEFERRAL_EVENT = 'TierPushDeferred';
/** Reads per aggregate. */
const READ_CHUNK = 50;

/** `ProtocolBroadcastFacet.TierPushDeferral`, by ordinal. */
export const DEFERRAL_REASONS = ['spacing', 'budget', 'quote', 'send', 'destinations', 'no-destinations'] as const;

const ZERO_ADDRESS = /^0x0{40}$/i;

/** What the step reads and signs with. */
export interface TierPushDeps {
  /** Plain client for every read here; each read carries its own cutoff. */
  readClient: PublicClient;
  sendDeadline: number;
  /** Where the rotated reads start this run. */
  visit: number;
  cursors: ScanCursors;
  ledger: EventLedger;
  finalized: () => Promise<FinalBlock | null>;
}

/** What the step did on one chain. */
export interface TierPushReport {
  /** Why it did nothing this run, when it did nothing. */
  off: string | null;
  /** Users the ledger page named, and those with a lane still owed. */
  nominated: number;
  owed: string[];
  /** Users owed only lanes the budget cannot pay now, with why. */
  waiting: string[];
  /** Users whose status listed no lane at all: the messenger's destination
   *  list could not be read, or none is configured. Not known to be owed
   *  nothing. */
  lanesUnknown: string[];
  /** Deliveries that landed: `user: lanes 10,42; still owed 7 (budget)`. */
  delivered: string[];
  /** Deliveries that landed and left every lane owed, each deferred by the
   *  contract (its own read differed from the keeper's price). */
  deliveredNone: string[];
  /** Deliveries that landed with no lane sent, settled or deferred: every
   *  lane was already delivered when it ran (another caller got there
   *  first). */
  nothingOwed: string[];
  /** Deliveries that landed whose receipt was not read. */
  landedUnread: string[];
}

export function emptyTierPushReport(): TierPushReport {
  return { off: null, nominated: 0, owed: [], waiting: [], lanesUnknown: [], delivered: [], deliveredNone: [], nothingOwed: [], landedUnread: [] };
}

/** The step's figures for the run's line. */
export function describeTierPush(r: TierPushReport | null): string[] {
  if (r === null) return ['tier-push-retry=off (TIER_PUSH_RETRY_ENABLED not armed)'];
  if (r.off !== null) return [`tier-push-retry=not worked (${r.off})`];
  const list = (xs: readonly string[]) => xs.join(',') || 'none';
  return [
    `tier-push-nominated=${r.nominated} users, ${r.owed.length} owed`,
    `tier-push-delivered=${list(r.delivered)}`,
    ...(r.waiting.length > 0 ? [`tier-push-waiting=${r.waiting.join('; ')}`] : []),
    ...(r.lanesUnknown.length > 0 ? [`tier-push-lanes-unknown=${list(r.lanesUnknown)} (the status listed no lane: the messenger's destination list could not be read, or none is configured)`] : []),
    ...(r.deliveredNone.length > 0 ? [`tier-push-delivered-none=${list(r.deliveredNone)} (the contract left every lane owed)`] : []),
    ...(r.nothingOwed.length > 0 ? [`tier-push-nothing-owed=${list(r.nothingOwed)} (every lane was already delivered when the call ran)`] : []),
    ...(r.landedUnread.length > 0 ? [`tier-push-event-unread=${list(r.landedUnread)}`] : []),
  ];
}

/** A deferral row's push: whose, which lane (0: none named), which nonce. */
interface Deferral {
  user: Address;
  dst: bigint;
  nonce: bigint;
}

interface Lane {
  dst: bigint;
  owed: boolean;
  eligibleAt: bigint;
}

interface PushStatus {
  nonce: bigint;
  tier: number;
  bps: number;
  expiry: number;
  version: number;
  lanes: Lane[];
}

/** `getTierPushStatus`'s result, or null when it does not have that shape. */
export function readStatus(raw: unknown): PushStatus | null {
  if (!Array.isArray(raw) || raw.length < 6 || !Array.isArray(raw[5])) return null;
  try {
    return {
      nonce: BigInt(raw[0] as bigint),
      tier: Number(raw[1]),
      bps: Number(raw[2]),
      expiry: Number(raw[3]),
      version: Number(raw[4]),
      lanes: (raw[5] as { destChainId: bigint; owed: boolean; budgetEligibleAt: bigint | number }[]).map((l) => ({
        dst: BigInt(l.destChainId),
        owed: l.owed === true,
        eligibleAt: BigInt(l.budgetEligibleAt),
      })),
    };
  } catch {
    return null;
  }
}

/**
 * Whether a deferral row is finished on `st`: its push was superseded by a
 * later one (whose own deferrals, if any, are rows above it), or the lane it
 * names is no longer owed. A row that names no lane is finished when no lane
 * is owed. An empty lane list finishes nothing but a superseded push: the
 * status reads it empty both where no lane is configured and where the
 * messenger's list could not be read, and the second is not "delivered".
 */
export function deferralDone(k: Deferral, st: PushStatus | undefined): boolean {
  if (st === undefined) return false;
  if (st.nonce > k.nonce) return true;
  if (st.lanes.length === 0) return false;
  if (k.dst === 0n) return st.lanes.every((l) => !l.owed);
  const lane = st.lanes.find((l) => l.dst === k.dst);
  return lane === undefined || !lane.owed;
}

const userKey = (a: string) => a.toLowerCase();

/** One chain's step. It never throws for running out of time: a stage that
 *  reaches its cutoff is reported unread in the step's own report, so an armed
 *  step always says what it read and what it did not. */
export async function retryTierPushes(chainId: number, diamond: Address, sender: StepSender, deps: TierPushDeps): Promise<TierPushReport> {
  const out = emptyTierPushReport();
  // Each read stage stops early enough to leave the stages after it their
  // time (runWindow.ts, rule 3): the quotes by the read cutoff, which reserves
  // the sends' time; the status reads a stage reserve before that; the
  // ledger's nominees and the gate reads a stage reserve before those.
  const readCutoff = readCutoffMs(deps.sendDeadline);
  const statusCutoff = priorStageCutoffMs(readCutoff);
  const gateCutoff = priorStageCutoffMs(statusCutoff);
  const gateClient = deadlineClient(deps.readClient, gateCutoff);

  // 1. Nominate, by the gate's cutoff.
  let page: LedgerRotation<Deferral> | null;
  try {
    page = await readLedgerRotation<Deferral>({
      ledger: deps.ledger,
      cursors: deps.cursors,
      chainId,
      kinds: [DEFERRAL_EVENT],
      floorItem: DEFERRAL_FLOOR_ITEM,
      nextItem: DEFERRAL_NEXT_ITEM,
      limit: DEFERRAL_PAGE,
      nominee: (row) => {
        const user = String(row.args.user ?? '');
        try {
          const dst = BigInt(String(row.args.destChainId));
          const nonce = BigInt(String(row.args.nonce));
          return /^0x[0-9a-fA-F]{40}$/.test(user) && !ZERO_ADDRESS.test(user) ? { user: user as Address, dst, nonce } : null;
        } catch {
          return null;
        }
      },
      id: (k) => `${userKey(k.user)}:${k.dst}:${k.nonce}`,
      cutoff: gateCutoff,
    });
  } catch (err) {
    if (!(err instanceof PastRunDeadline)) throw err;
    sender.noteUnread('tier-push', `the event ledger of deferred tier pushes (${shortErr(err)})`);
    out.off = 'the event ledger of deferred tier pushes was not read by its stage cutoff';
    return out;
  }
  if (page === null) {
    sender.noteUnread('tier-push', 'the event ledger of deferred tier pushes');
    out.off = 'the event ledger of deferred tier pushes could not be read';
    return out;
  }
  const users = [...new Map(page.nominees.map((k) => [userKey(k.user), k.user])).values()];
  out.nominated = users.length;
  const statusAt = async (us: readonly Address[], blockNumber?: bigint) => {
    const res = await settledChunkedRead(
      deps.readClient,
      us,
      READ_CHUNK,
      (u) => ({ address: diamond, abi: TIER_PUSH_ABI, functionName: 'getTierPushStatus', args: [u] }),
      `protocolUpkeep tier-push status${blockNumber === undefined ? '' : ' (finalized)'}`,
      statusCutoff,
      deps.visit,
      blockNumber,
    );
    const m = new Map<string, PushStatus>();
    for (const u of us) {
      const x = res.get(u);
      const st = x?.status === 'success' ? readStatus(x.result) : null;
      if (st !== null) m.set(userKey(u), st);
    }
    return m;
  };
  const lift = (head: ReadonlyMap<string, PushStatus>) =>
    page.liftFloor(deps.finalized, (k) => deferralDone(k, head.get(userKey(k.user))), async (ks, block) => {
      const at = await statusAt([...new Map(ks.map((k) => [userKey(k.user), k.user])).values()], block.number);
      return (k) => deferralDone(k, at.get(userKey(k.user)));
    });
  if (users.length === 0) {
    await lift(new Map());
    return out;
  }

  // The gate reads: the budget, the messenger that prices a lane, the clock.
  let budget: bigint;
  let messenger: Address;
  let now: bigint;
  try {
    // The client refuses a call started past the cutoff; the bound stops the
    // wait on one already in flight.
    const [b, cfg, block] = await boundedCall(gateCutoff, 'the broadcast budget, messenger and clock', () =>
      Promise.all([
        gateClient.readContract({ address: diamond, abi: TIER_PUSH_ABI, functionName: 'getProtocolBroadcastBudget' }) as Promise<bigint>,
        gateClient.readContract({ address: diamond, abi: TIER_PUSH_ABI, functionName: 'getRewardReporterConfig' }) as Promise<readonly [Address, ...unknown[]]>,
        gateClient.getBlock(),
      ]),
    );
    [budget, messenger, now] = [b, cfg[0], block.timestamp];
  } catch (err) {
    sender.noteUnread('tier-push', `the broadcast budget, messenger or clock (${shortErr(err)})`);
    out.off = 'the broadcast budget, messenger or clock could not be read';
    return out;
  }

  // 2. Read.
  const head = await statusAt(users);
  const unread = users.filter((u) => !head.has(userKey(u)));
  if (unread.length > 0) sender.noteUnread('tier-push', `the tier-push status of ${unread.length} user(s) the ledger names`);
  await lift(head);
  if (ZERO_ADDRESS.test(messenger)) {
    out.off = 'no reward messenger is set on this chain, so it originates no tier push';
    return out;
  }

  // A status with no lane says nothing about what is owed: the facet returns
  // it both where no destination is configured and where the messenger's
  // list could not be read.
  out.lanesUnknown = users.filter((u) => head.get(userKey(u))?.lanes.length === 0);
  if (out.lanesUnknown.length > 0) sender.noteUnread('tier-push', `the broadcast lanes of ${out.lanesUnknown.length} user(s) (their status listed none)`);

  // 3. Price: each owed lane the budget may pay now.
  const owed = users.filter((u) => head.get(userKey(u))?.lanes.some((l) => l.owed) === true);
  out.owed = owed.map((u) => u);
  const due: { user: Address; lanes: Lane[] }[] = [];
  for (const u of owed) {
    const st = head.get(userKey(u))!;
    const open = st.lanes.filter((l) => l.owed && l.eligibleAt <= now);
    if (open.length === 0) {
      const next = st.lanes.filter((l) => l.owed).map((l) => l.eligibleAt).reduce((a, b) => (b < a ? b : a));
      out.waiting.push(`${u}: every owed lane is spaced until ${next}`);
      continue;
    }
    due.push({ user: u, lanes: open });
  }
  const quotes = due.length === 0
    ? []
    : await settledRead(
        deps.readClient,
        due.flatMap(({ user, lanes }) => {
          const st = head.get(userKey(user))!;
          return lanes.map((l) => ({
            address: messenger,
            abi: MESSENGER_ABI,
            functionName: 'quoteSendTierUpdateTo',
            args: [l.dst, user, st.tier, st.bps, Number(now), st.nonce, st.expiry, st.version],
          }));
        }),
        'protocolUpkeep tier-push quotes',
        readCutoff,
      );
  const priced: { user: Address; lanes: { dst: bigint; fee: bigint | null }[] }[] = [];
  let q = 0;
  for (const { user, lanes } of due) {
    priced.push({ user, lanes: lanes.map((l) => {
      const x = quotes[q++];
      return { dst: l.dst, fee: x?.status === 'success' ? BigInt(x.result as bigint) : null };
    }) });
  }

  // 4. The contract decides. Users go in an order that moves each run, so a
  // user whose delivery keeps failing does not always come first; and a fee
  // counts against the budget only once a receipt shows its lane sent, so a
  // delivery that spends nothing leaves the budget to the users after it.
  let left = budget;
  const start = priced.length === 0 ? 0 : deps.visit % priced.length;
  for (let i = 0; i < priced.length; i++) {
    const { user, lanes } = priced[(start + i) % priced.length]!;
    let room = left;
    const paid: bigint[] = [];
    const short: string[] = [];
    for (const l of lanes) {
      if (l.fee === null) short.push(`${l.dst} (its quote did not come back)`);
      else if (l.fee > room) short.push(`${l.dst} (fee ${l.fee} over the ${room} the budget has left)`);
      else {
        room -= l.fee;
        paid.push(l.dst);
      }
    }
    if (paid.length === 0) {
      out.waiting.push(`${user}: ${short.join(', ')}`);
      continue;
    }
    if (sender.stopped) break;
    // eslint-disable-next-line no-await-in-loop
    const res = await sender.call('tier-push', user, 'deliverTierPush', [user]);
    if (res !== 'landed') continue;
    if (sender.receipt === null) {
      out.landedUnread.push(user);
      continue;
    }
    const got = pushEvents(diamond, user, sender.receipt.logs);
    for (const dst of got.sent) {
      const fee = lanes.find((l) => l.dst === dst)?.fee;
      if (fee !== null && fee !== undefined) left = fee > left ? 0n : left - fee;
    }
    if (got.sent.length === 0 && got.settled.length === 0) {
      if (got.deferred.length > 0) out.deliveredNone.push(user);
      else out.nothingOwed.push(user);
      continue;
    }
    const still = got.deferred.map(([dst, why]) => `${dst} (${why})`);
    const parts = [
      ...(got.sent.length > 0 ? [`lanes ${got.sent.join(',')}`] : []),
      ...(got.settled.length > 0 ? [`settled ${got.settled.join(',')}`] : []),
      ...(still.length > 0 ? [`still owed ${still.join(', ')}`] : []),
    ];
    out.delivered.push(`${user}: ${parts.join('; ')}`);
  }
  return out;
}

/** The lanes a landed delivery sent, those it settled without a send (the
 *  lane already carried the push's effect) and those it left owed, from its
 *  own events. Exported for tests. */
export function pushEvents(
  diamond: Address,
  user: Address,
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[],
): { sent: bigint[]; settled: bigint[]; deferred: [bigint, string][] } {
  const out = { sent: [] as bigint[], settled: [] as bigint[], deferred: [] as [bigint, string][] };
  for (const log of logs) {
    if (log.address.toLowerCase() !== diamond.toLowerCase()) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: ProtocolBroadcastFacetABI as Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    const a = ev.args as unknown as Record<string, unknown>;
    if (String(a.user ?? '').toLowerCase() !== user.toLowerCase()) continue;
    if (ev.eventName === 'ProtocolTierBroadcastSent') out.sent.push(BigInt(a.destChainId as bigint));
    else if (ev.eventName === 'TierPushLaneSettled') out.settled.push(BigInt(a.destChainId as bigint));
    else if (ev.eventName === 'TierPushDeferred') out.deferred.push([BigInt(a.destChainId as bigint), DEFERRAL_REASONS[Number(a.reason)] ?? `reason ${a.reason}`]);
  }
  return out;
}
