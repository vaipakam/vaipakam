// apps/keeper/src/intentCalm.ts
//
// The keeper's side of the calm-price check on lender intent slots.
//
// Every fill from a lender intent slot (`matchIntent`: Auto-lend, the
// backstop fill, the aggregator adapters) is refused while the pair moved
// past the calm bound against either of the last two hourly price
// checkpoints, while either checkpoint is missing, or while a price cannot be
// read (`OfferPriceGuardFacet.intentCalmStatus`). The check is on by default;
// a slot's owner may switch it off, a platform-run owner (the backstop vault,
// an aggregator adapter) cannot.
//
// So the hourly checkpoints are no longer only the forced-sale floor's
// input: a pair nothing checkpoints is a pair no slot can lend in. This
// module holds what the passes share about that:
//
//   - the refusal codes and words, so the Auto-lend pass (matcher.ts) and the
//     backstop fill (positionUpkeep.ts) skip a refused fill with its reason
//     and never alert per skip;
//   - the "no checkpoint for 3 hours" tracker the checkpoint pass
//     (priceCheckpoint.ts) runs over the slots it reads, which raises one ops
//     digest per chain when a slot has read NoCheckpoint for 3 hours;
//   - and, in `checkpointCoverage.ts`, the check that the checkpoint pass is
//     armed wherever a pass that fills from intent slots is armed.

import type { Address } from 'viem';
import type { Env } from './env';
import { resolveOpsAlerts, sendOpsAlertDigest, type OpsAlertOutcome } from './opsAlert';
import { enqueueWork, finishWork, listOpenWorkPage } from './db';
import { redactedError } from '@vaipakam/lib/errorDescription';

/** `LibOfferPriceGuard.Status`, as `intentCalmStatus` answers it. */
export const CALM_STATUS = { Off: 0, Clear: 2, NoCheckpoint: 4, NotCalm: 5, Unpriced: 6 } as const;

/** What a slot's status says, in the words the run lines use. */
export const CALM_STATUS_WORDS: ReadonlyMap<number, string> = new Map([
  [CALM_STATUS.Off, 'check switched off by the owner'],
  [CALM_STATUS.Clear, 'calm'],
  [CALM_STATUS.NoCheckpoint, 'a checkpoint of one of the last two hours is missing for the pair'],
  [CALM_STATUS.NotCalm, 'the pair moved past the calm bound in the last two hours'],
  [CALM_STATUS.Unpriced, 'a price of the pair cannot be read'],
]);

/** `LibOfferMatch.IntentError` codes `previewIntent` gives for the check's
 *  refusals (appended after `PastLendUntil`), with their words. The refusal
 *  depends only on the pair and the slot, so it holds for every borrower of
 *  the intent this run. */
export const CALM_INTENT_ERRORS: ReadonlyMap<number, string> = new Map([
  [26, CALM_STATUS_WORDS.get(CALM_STATUS.NoCheckpoint)!],
  [27, CALM_STATUS_WORDS.get(CALM_STATUS.NotCalm)!],
  [28, CALM_STATUS_WORDS.get(CALM_STATUS.Unpriced)!],
]);

/** The errors `matchIntent` reverts with for the same refusals (the backstop
 *  fill meets them in its simulation), with their words. */
export const CALM_FILL_REFUSALS: ReadonlyMap<string, string> = new Map([
  ['IntentPairNoCheckpoint', `the price check refuses it: ${CALM_STATUS_WORDS.get(CALM_STATUS.NoCheckpoint)}`],
  ['IntentPairNotCalm', `the price check refuses it: ${CALM_STATUS_WORDS.get(CALM_STATUS.NotCalm)}`],
  ['IntentPairUnpriced', `the price check refuses it: ${CALM_STATUS_WORDS.get(CALM_STATUS.Unpriced)}`],
]);

/** A slot read NoCheckpoint this long is raised to ops. The pass checkpoints
 *  at :11 and :41, and a pair it starts covering reads NoCheckpoint until it
 *  has the two whole hours before the current one, so under two hours of it
 *  is expected; three is not. */
export const NO_CHECKPOINT_ALERT_AFTER_SEC = 3 * 3600;
/** While it lasts, the alert repeats this often. */
export const NO_CHECKPOINT_ALERT_REPEAT_SEC = 6 * 3600;
/** Open slots one run reads back from the tracker. */
export const NO_CHECKPOINT_TRACK_LIMIT = 1000;

/** One lender intent slot. */
export interface CalmSlot {
  owner: Address;
  lendingAsset: Address;
  collateralAsset: Address;
  slot: number;
}

/** The slot's tracker and alert key part. Lowercased, so one slot is one key. */
export function calmSlotKey(s: CalmSlot): string {
  return `${s.owner}:${s.lendingAsset}:${s.collateralAsset}:${s.slot}`.toLowerCase();
}

/** One slot as the checkpoint pass read it; `status` is null when the read
 *  did not come back (unknown, so neither started nor cleared). */
export interface CalmObservation {
  slot: CalmSlot;
  status: number | null;
}

export interface NoCheckpointResult {
  /** Slots that have read NoCheckpoint for the alert's length (raised, or
   *  suppressed as recently raised). */
  overdue: number;
  outcome: OpsAlertOutcome | null;
}

/** The ops digest's text pieces, exported for the tests. */
export function noCheckpointHeader(chainId: number, count: number): string {
  return `⚠️ Chain ${chainId}: ${count} lender intent slot(s) have read "no checkpoint" for over ${NO_CHECKPOINT_ALERT_AFTER_SEC / 3600} hours, so every fill from them (Auto-lend, the backstop, aggregators) is refused.`;
}
export const NO_CHECKPOINT_FOOTER =
  "The price checkpoint pass writes each pair's hourly checkpoint. Check that PRICE_CHECKPOINT_ENABLED is armed and read its run line for this chain: it names assets whose price does not read, and sends deferred by its budget.";

const TRACK_KIND = 'calm_no_checkpoint' as const;
const alertKey = (chainId: number, item: string) => `calm-no-checkpoint:${chainId}:${item}`;

/** What the tracker needs. Injected so the rule is testable without D1. */
export interface NoCheckpointStore {
  /** Start tracking (idempotent: a tracked slot keeps its start time). */
  start(items: readonly { item: string; slot: CalmSlot }[]): Promise<void>;
  /** Stop tracking these slots. */
  stop(items: readonly string[]): Promise<void>;
  /** The tracked slots, with the time each started (unix seconds). */
  list(): Promise<{ item: string; slot: CalmSlot; since: number }[]>;
  /** Raise the due slots in one digest. */
  alert(entries: readonly { key: string; id: string; detail: string }[], nowSec: number): Promise<OpsAlertOutcome>;
  /** The slots' conditions are gone: a recurrence alerts at once. */
  resolve(keys: readonly string[]): Promise<void>;
}

/** The store over the keeper's private database and the ops channel. */
export function d1NoCheckpointStore(env: Env, chainId: number, diamond: Address, deadline: number): NoCheckpointStore {
  return {
    start: (items) =>
      enqueueWork(env.KEEPER_DB, chainId, diamond, TRACK_KIND, items.map((x) => ({ item: x.item, block: 0, payload: x.slot }))),
    stop: (items) => finishWork(env.KEEPER_DB, chainId, diamond, TRACK_KIND, items),
    list: async () =>
      (await listOpenWorkPage<CalmSlot>(env.KEEPER_DB, chainId, diamond, TRACK_KIND, NO_CHECKPOINT_TRACK_LIMIT)).items.map((w) => ({
        item: w.item,
        slot: w.payload,
        since: w.addedAt,
      })),
    alert: (entries, nowSec) =>
      sendOpsAlertDigest(env, (n) => noCheckpointHeader(chainId, n), entries, NO_CHECKPOINT_FOOTER, NO_CHECKPOINT_ALERT_REPEAT_SEC, nowSec, chainId, deadline),
    resolve: (keys) => resolveOpsAlerts(env, keys, deadline),
  };
}

/**
 * Apply one checkpoint run's slot reads to the tracker, and raise the slots
 * that have read NoCheckpoint for {@link NO_CHECKPOINT_ALERT_AFTER_SEC}.
 *
 * A slot read NoCheckpoint starts (or keeps) its clock; a slot read with any
 * other status stops it and clears its alert. A slot whose read did not come
 * back is left as it was. When `complete` (the run read the whole intent
 * registry), a tracked slot it did not see has left the registry and is
 * stopped too. The clock measures how long the slot has READ NoCheckpoint at
 * the pass's runs, whether or not a fill was tried in that time: a slot
 * nobody tries to fill still cannot lend, and the condition is the same.
 * Never throws; a failure leaves the tracker for the next run.
 */
export async function trackNoCheckpoint(
  chainId: number,
  observations: readonly CalmObservation[],
  complete: boolean,
  store: NoCheckpointStore,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<NoCheckpointResult> {
  try {
    const seen = new Set<string>();
    const starts: { item: string; slot: CalmSlot }[] = [];
    const stops: string[] = [];
    for (const o of observations) {
      const item = calmSlotKey(o.slot);
      seen.add(item);
      if (o.status === null) continue;
      if (o.status === CALM_STATUS.NoCheckpoint) starts.push({ item, slot: o.slot });
      else stops.push(item);
    }
    if (starts.length > 0) await store.start(starts);
    const tracked = await store.list();
    if (complete) for (const t of tracked) if (!seen.has(t.item)) stops.push(t.item);
    if (stops.length > 0) {
      await store.stop(stops);
      await store.resolve(stops.map((i) => alertKey(chainId, i)));
    }
    const stopped = new Set(stops);
    const due = tracked.filter((t) => !stopped.has(t.item) && nowSec - t.since >= NO_CHECKPOINT_ALERT_AFTER_SEC);
    if (due.length === 0) return { overdue: 0, outcome: null };
    const entries = due.map((t) => ({
      key: alertKey(chainId, t.item),
      id: `${t.slot.owner} slot ${t.slot.slot} (${t.slot.lendingAsset} lent against ${t.slot.collateralAsset})`,
      detail: `no checkpoint since ${new Date(t.since * 1000).toISOString()}`,
    }));
    return { overdue: due.length, outcome: await store.alert(entries, nowSec) };
  } catch (err) {
    console.warn(`[keeper] priceCheckpoint chain=${chainId} no-checkpoint tracker not updated (${redactedError(err, { stack: false })}); retried next run`);
    return { overdue: 0, outcome: null };
  }
}
