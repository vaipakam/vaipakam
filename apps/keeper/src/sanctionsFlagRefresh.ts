// apps/keeper/src/sanctionsFlagRefresh.ts
//
// #3097 — the SANCTIONS-FLAG REFRESH, step 7 of `protocolUpkeep`: the
// keeper's call of `ProfileFacet.refreshSanctionsFlag(who)`.
//
// The Diamond keeps a committed record of wallets it has seen flagged by an
// authoritative oracle read (the #1123 registry, `sanctionsConfirmedFlagged`).
// It is consulted only while the oracle is set but cannot answer (an outage),
// and then it decides, fail-closed: a registered wallet cannot move a
// position NFT, is barred as a payout, prepay-sale, keeper-reward or vault
// recipient, and has its close-out proceeds frozen. So the record is right
// only if it follows the oracle while the oracle answers:
//
//   - a wallet the oracle flags that nothing has registered moves and is paid
//     freely through an outage (the gates write the record only on paths that
//     do not revert, and many do revert on a flag);
//   - a registered wallet the oracle has since cleared stays refused through
//     an outage, until some path that reads it clean clears it.
//
// `refreshSanctionsFlag` mirrors the oracle's three-way read into the record
// for one wallet: registers on Flagged, clears on Clean, reverts on
// Unavailable. It is permissionless and cannot set anything the oracle does
// not confirm.
//
// Coverage (#3097). `rewardSanctionsHold` re-screens every loan party daily and
// its observation (`recordRewardSanctionsEvidence`) writes the same record —
// it registers a flagged wallet and clears a cleared one
// (`LibRewardSanctions.observe`) — but only for loan parties, only while
// REWARD_SANCTIONS_KEEPER_ENABLED arms it, and not while the protocol is
// paused. This step covers the record for every wallet the chain's own events
// name as one the protocol deals with, loan parties included:
//
//   - `UserVaultCreated.user` — every vault owner (every lender, borrower and
//     depositor has one), the recipient of every vault payout;
//   - `Transfer.to` — every position-NFT recipient, the parties the move gate
//     and the close-out freeze screen;
//   - `PayoutQueued.recipient` — every protected-payout recipient;
//   - `KeeperRewardPaid.keeper` — every keeper paid a keeper reward;
//   - `SanctionsFlagRefreshed.who` — every wallet anyone has refreshed.
//
// Per chain, per run:
//
//   0. The gate: a sanctions oracle is set. With none, the record is not
//      consulted and the call reverts, and the step says so.
//   1. NOMINATE — a page of those ledger rows (the shared indexer's
//      `activity_events`), from where the last run stopped, wrapping at the
//      end. There is no floor: a wallet's oracle status changes without any
//      event on this chain, so no row is ever finished, and the rotation is a
//      standing re-screen.
//   2. READ — each wallet's `sanctionsStatus` (the contract's three-way read,
//      the one the refresh acts on) and `isSanctionsConfirmedFlagged`, read
//      together.
//   3. REFRESH — `refreshSanctionsFlag(who)` where the two disagree: Flagged
//      and not registered, or Clean and registered. A wallet the oracle could
//      not answer for is not sent (the call would revert) and is counted
//      unscreened. Each call is simulated first; the run's line names each
//      wallet registered or cleared, from its `SanctionsFlagRefreshed` event.
//
// Registering a flagged wallet early changes one thing beyond the outage
// gates, and it is the contract's existing rule rather than this step's: a
// capacity operator already registered is refused outright on a flagged read
// instead of having its request parked (`LibServiceCapacity`). Every other
// path that writes the record (the reward observation, the close-out freeze,
// a sale buyer's sync) has the same effect.
//
// Permissionless; pays only gas and moves no value.
//
// Gated by KEEPER_ENABLED + PROTOCOL_UPKEEP_ENABLED +
// SANCTIONS_FLAG_REFRESH_ENABLED. Ships disarmed.

import { decodeEventLog, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { ProfileFacetABI } from '@vaipakam/contracts/abis';
import { deadlineClient, PastRunDeadline, settledGroupedRead } from './batchRead';
import { boundedCall } from './passReader';
import { shortErr } from './callErrors';
import type { EventLedger } from './eventLedger';
import { attemptOrder, readLedgerRotation, type LedgerRotation } from './ledgerRotation';
import { priorStageCutoffMs, readCutoffMs } from './runWindow';
import type { ScanCursors } from './scanCursors';
import type { StepSender } from './stepSender';

export const SANCTIONS_FLAG_ABI = ProfileFacetABI as Abi;

/** Each nominating event, and the argument that names the wallet. */
export const SCREEN_SOURCES: Readonly<Record<string, string>> = {
  UserVaultCreated: 'user',
  Transfer: 'to',
  PayoutQueued: 'recipient',
  KeeperRewardPaid: 'keeper',
  SanctionsFlagRefreshed: 'who',
};
/** Ledger rows read per run. */
export const SCREEN_PAGE = 400;
/** The rotation's floor item is never written (no row is ever finished), so
 *  each pass over the ledger starts at its first row. */
export const SCREEN_FLOOR_ITEM = 'sanctions-flag-floor';
export const SCREEN_NEXT_ITEM = 'sanctions-flag-next';
/** Reads per aggregate (two a wallet). */
const READ_CHUNK = 100;
/** `LibVaipakam.SanctionsRead`. */
const CLEAN = 0;
const FLAGGED = 1;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;

/** What the step reads and signs with. */
export interface SanctionsFlagDeps {
  /** Plain client; every read here carries its own cutoff. */
  readClient: PublicClient;
  sendDeadline: number;
  /** Where the batched reads and the sends start this run. */
  visit: number;
  cursors: ScanCursors;
  ledger: EventLedger;
}

/** What the step did on one chain. */
export interface SanctionsFlagReport {
  /** Why it did nothing this run, when it did nothing. */
  off: string | null;
  /** Ledger rows read, and the distinct wallets they named. */
  rows: number;
  wallets: number;
  /** Wallets whose record disagreed with the oracle. */
  due: number;
  /** Refreshes that landed, from their event. */
  registered: string[];
  cleared: string[];
  /** Wallets the oracle could not answer for: not screened this run. */
  unscreened: number;
  /** Wallets whose two reads did not come back. */
  unread: number;
  /** Refreshes that landed whose event was not read. */
  landedUnread: string[];
}

export function emptySanctionsFlagReport(): SanctionsFlagReport {
  return { off: null, rows: 0, wallets: 0, due: 0, registered: [], cleared: [], unscreened: 0, unread: 0, landedUnread: [] };
}

/** The step's figures for the run's line. */
export function describeSanctionsFlags(r: SanctionsFlagReport | null): string[] {
  if (r === null) return ['sanctions-flag-refresh=off (SANCTIONS_FLAG_REFRESH_ENABLED not armed)'];
  if (r.off !== null) return [`sanctions-flag-refresh=not worked (${r.off})`];
  return [
    `sanctions-flag-screened=${r.wallets} wallets from ${r.rows} rows, ${r.due} out of step with the oracle`,
    `sanctions-flag-registered=${r.registered.join(',') || 'none'}`,
    `sanctions-flag-cleared=${r.cleared.join(',') || 'none'}`,
    ...(r.unscreened > 0 ? [`sanctions-flag-unscreened=${r.unscreened} (the oracle did not answer for them)`] : []),
    ...(r.unread > 0 ? [`sanctions-flag-unread=${r.unread} wallets`] : []),
    ...(r.landedUnread.length > 0 ? [`sanctions-flag-event-unread=${r.landedUnread.join(',')}`] : []),
  ];
}

/** The wallet a ledger row names, or null. Exported for tests. */
export function screenedWallet(kind: string, args: Record<string, unknown>): Address | null {
  const arg = SCREEN_SOURCES[kind];
  if (arg === undefined) return null;
  const w = String(args[arg] ?? '');
  return ADDRESS.test(w) && !ZERO_ADDRESS.test(w) ? (w.toLowerCase() as Address) : null;
}

/** What a landed refresh recorded for `who`, from its event; null when the
 *  receipt carries none. Exported for tests. */
export function refreshedFlag(diamond: Address, who: Address, logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[]): boolean | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== diamond.toLowerCase()) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: SANCTIONS_FLAG_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    const a = ev.args as unknown as Record<string, unknown>;
    if (ev.eventName === 'SanctionsFlagRefreshed' && String(a.who).toLowerCase() === who.toLowerCase()) return a.flagged === true;
  }
  return null;
}

/** One chain's step. It never throws for running out of time: a stage that
 *  reaches its cutoff is reported in the step's own report. */
export async function refreshSanctionsFlags(chainId: number, diamond: Address, sender: StepSender, deps: SanctionsFlagDeps): Promise<SanctionsFlagReport> {
  const out = emptySanctionsFlagReport();
  // The status reads by the read cutoff, which reserves the sends' time; the
  // gate and the ledger page a stage reserve before it (runWindow.ts rule 3).
  const statusCutoff = readCutoffMs(deps.sendDeadline);
  const gateCutoff = priorStageCutoffMs(statusCutoff);

  // 0. The gate.
  let oracle: Address;
  try {
    const gateClient = deadlineClient(deps.readClient, gateCutoff);
    oracle = (await boundedCall(gateCutoff, 'the sanctions oracle', () =>
      gateClient.readContract({ address: diamond, abi: SANCTIONS_FLAG_ABI, functionName: 'getSanctionsOracle' }),
    )) as Address;
  } catch (err) {
    sender.noteUnread('sanctions-flag', `the sanctions oracle (${shortErr(err)})`);
    out.off = 'the sanctions oracle could not be read';
    return out;
  }
  if (ZERO_ADDRESS.test(oracle)) {
    out.off = 'no sanctions oracle is set on this chain: the registry is not consulted and the refresh would revert';
    return out;
  }

  // 1. Nominate.
  let page: LedgerRotation<Address> | null;
  try {
    page = await readLedgerRotation<Address>({
      ledger: deps.ledger,
      cursors: deps.cursors,
      chainId,
      kinds: Object.keys(SCREEN_SOURCES),
      floorItem: SCREEN_FLOOR_ITEM,
      nextItem: SCREEN_NEXT_ITEM,
      limit: SCREEN_PAGE,
      nominee: (row) => screenedWallet(row.kind, row.args),
      id: (w) => w,
      cutoff: gateCutoff,
    });
  } catch (err) {
    if (!(err instanceof PastRunDeadline)) throw err;
    sender.noteUnread('sanctions-flag', `the event ledger of screened wallets (${shortErr(err)})`);
    out.off = 'the event ledger of screened wallets was not read by its stage cutoff';
    return out;
  }
  if (page === null) {
    sender.noteUnread('sanctions-flag', 'the event ledger of screened wallets');
    out.off = 'the event ledger of screened wallets could not be read';
    return out;
  }
  out.rows = page.rows.length;
  const wallets = page.nominees;
  out.wallets = wallets.length;
  if (wallets.length === 0) return out;

  // 2. Read each wallet's status and record together.
  const reads = await settledGroupedRead(
    deps.readClient,
    wallets,
    READ_CHUNK,
    (w) => [
      { address: diamond, abi: SANCTIONS_FLAG_ABI, functionName: 'sanctionsStatus', args: [w] },
      { address: diamond, abi: SANCTIONS_FLAG_ABI, functionName: 'isSanctionsConfirmedFlagged', args: [w] },
    ],
    'protocolUpkeep sanctions-flag status',
    statusCutoff,
    deps.visit,
  );
  const due: Address[] = [];
  for (const w of wallets) {
    const [st, marker] = reads.get(w) ?? [];
    if (st?.status !== 'success' || marker?.status !== 'success') {
      out.unread += 1;
      continue;
    }
    const status = Number(st.result);
    const registered = marker.result === true;
    if (status === FLAGGED ? !registered : status === CLEAN ? registered : false) due.push(w);
    else if (status !== FLAGGED && status !== CLEAN) out.unscreened += 1;
  }
  out.due = due.length;
  if (out.unread > 0) sender.noteUnread('sanctions-flag', `the sanctions status or registry entry of ${out.unread} wallet(s)`);

  // 3. Refresh each, from a point that moves each run.
  for (const i of attemptOrder(due.length, deps.visit)) {
    if (sender.stopped) break;
    const w = due[i]!;
    // eslint-disable-next-line no-await-in-loop
    const res = await sender.call('sanctions-flag', w, 'refreshSanctionsFlag', [w]);
    if (res !== 'landed') continue;
    const flagged = sender.receipt === null ? null : refreshedFlag(diamond, w, sender.receipt.logs as never);
    if (flagged === null) out.landedUnread.push(w);
    else (flagged ? out.registered : out.cleared).push(w);
  }
  return out;
}
