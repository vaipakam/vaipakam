/**
 * #1213 PR 2b — HF-band inbox rows, piggybacked on the liquidator scan.
 *
 * The liquidator pass already multicalls `calculateHealthFactor` for
 * EVERY active loan on every tick (liquidator.ts); this module reuses
 * those readings to materialize free in-app inbox rows when a loan's
 * health CROSSES DOWN into a protocol-level band:
 *
 *   - `hf_warn`     — HF dipped below 1.5 (the initiation floor)
 *   - `hf_alert`    — HF dipped below 1.2
 *   - `hf_critical` — HF dipped below 1.05 (liquidatable at 1.0)
 *
 * Distinct from the SUBSCRIBER alert rail (watcher.ts / notify_state):
 * that path sends Telegram/Push against each wallet's OWN configured
 * thresholds and only for wallets that set them up. This path is
 * unconditional protocol-band bookkeeping — one fixed schedule, every
 * borrower, zero setup — feeding the same `notifications` table the
 * indexer's event/calendar rows land in (the bell reads one feed).
 *
 * Semantics:
 *   - DOWNGRADE-ONLY: a row mints when the observed band is WORSE than
 *     the stored one (absence = healthy, so a loan FIRST OBSERVED
 *     already inside a band notifies once). Recoveries update state
 *     silently — "your loan got safer" is not an alert.
 *   - Day-bucketed dedup: the dedup key embeds the UTC day, so an HF
 *     oscillating around a threshold re-alerts at most once per band
 *     per day (state updates keep the crossing edge-triggered within
 *     the day; the bucket only bounds pathological flapping).
 *   - Borrower-only recipient: HF is the BORROWER's actionable number
 *     (top up / repay). The lender-side risk surface is the grace and
 *     terminal rows. Recipient resolves to the CURRENT borrower-
 *     position holder via the shared D1 `loans` table.
 *   - LIQUID LOANS ONLY, inherently: illiquid loans revert
 *     `IlliquidLoanNoRiskMath` in the multicall and never reach this
 *     module — exactly the design split (#1213): calendar rows cover
 *     every loan; HF rows cover the loans HF math exists for.
 *   - Fail-open: this is derived convenience data. Any failure logs
 *     and returns — the liquidation pass it rides on must never wedge.
 *
 * Gating note (documented, deliberate): the liquidator pass — and so
 * this piggyback — runs only when the autonomous keeper is enabled
 * (`isKeeperEnabled`). Without a keeper key there is no per-tick HF
 * scan to reuse, so HF-band inbox rows are a keeper-enabled feature;
 * the calendar/event rows (indexer-side) are unconditional.
 *
 * Delivery note: rows written here reach the bell on its polling
 * cadence (the signal-stretched net). The keeper cannot push the
 * indexer DO's `notification.created` invalidation — an acceptable
 * lag for a band alert whose Telegram/Push twin (for subscribers) is
 * immediate.
 *
 * Two databases (#2450): the band STATE (`hf_band_state`) is keeper-
 * private and lives behind `KEEPER_DB`; the indexer's `indexer_cursor`
 * and `loans`, and the inbox `notifications` the app reads, are SHARED
 * (`DB`). D1 cannot join across databases, so every statement here
 * touches one side only. Splitting them changed no failure ordering: the
 * inbox insert and the state commit were already two separate batches,
 * inbox first — a state commit that fails re-mints next tick, and the
 * day-bucket dedup key absorbs the repeat.
 */

import type { Env } from './env';
import { assertEpochsHold, epochWriteGuard } from './epochFence';

export type HfBand = 'healthy' | 'warn' | 'alert' | 'critical';

/** Protocol-level band thresholds in milli-HF (1e18-scaled HF / 1e15).
 *  Fixed on purpose — the subscriber rail (watcher.ts) is where users
 *  tune personal thresholds; the inbox uses one protocol schedule
 *  anchored on MIN_HEALTH_FACTOR (1.5, the initiation floor). */
export const HF_WARN_MILLI = 1_500;
export const HF_ALERT_MILLI = 1_200;
export const HF_CRITICAL_MILLI = 1_050;

/** Milli-HF ceiling stored for effectively-infinite readings (a
 *  zero-borrow loan's `calculateHealthFactor` returns uint256.max). */
const HEALTHY_MILLI_CAP = 1_000_000;

/** Mirrors the indexer's calendar-row sentinel (calendarNotifications
 *  .ts CRON_LOG_INDEX — duplicated because Workers are separate
 *  packages): keeps a head-stamped cron row strictly newer than any
 *  real log in the same block for the feed's (block, logIndex, id)
 *  order and the client read cursor. */
export const CRON_LOG_INDEX = 1_000_000;

const BAND_RANK: Record<HfBand, number> = {
  healthy: 0,
  warn: 1,
  alert: 2,
  critical: 3,
};

const BAND_KIND: Record<Exclude<HfBand, 'healthy'>, string> = {
  warn: 'hf_warn',
  alert: 'hf_alert',
  critical: 'hf_critical',
};

/** 1e18-scaled HF → milli-HF, clamped. uint256.max (zero borrow) and
 *  any absurdly large reading collapse to the healthy cap. */
export function hfToMilli(hf: bigint): number {
  if (hf >= BigInt(HEALTHY_MILLI_CAP) * 10n ** 15n) return HEALTHY_MILLI_CAP;
  return Number(hf / 10n ** 15n);
}

export function classifyBand(hfMilli: number): HfBand {
  if (hfMilli < HF_CRITICAL_MILLI) return 'critical';
  if (hfMilli < HF_ALERT_MILLI) return 'alert';
  if (hfMilli < HF_WARN_MILLI) return 'warn';
  return 'healthy';
}

/**
 * Every statement in this module that takes a list takes it as ONE bound JSON
 * parameter, read with `json_each`, the shape the indexer's
 * `insertNotificationRows` uses (#2479). A statement's bind count is then fixed
 * by its text, whatever the list's length, so neither D1's 100-parameter cap
 * per statement (`@vaipakam/lib/d1Binds`) nor its per-invocation bind budget
 * can be reached by a busy pass, and a guard added to a statement later cannot
 * push it over either (Codex #2655 r5: the per-row binds the fences added had
 * done exactly that, at about 358 rows in one batch, and the prune's two
 * IN-list families at about 2,463 markers). A failure there would have been a
 * stall, not a skip: the pass fails open, commits nothing, and meets the same
 * list on every later tick.
 *
 * The chunk bounds the size of that one parameter, not a bind count: a few
 * dozen bytes an id or row, well inside D1's 2 MB value ceiling. All chunks of
 * a step go in one `batch()`, so a step is one subrequest.
 */
const JSON_LIST_CHUNK = 500;

/** `items` as JSON arrays of at most `JSON_LIST_CHUNK` entries each. */
function jsonChunks(items: readonly unknown[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < items.length; i += JSON_LIST_CHUNK) {
    out.push(JSON.stringify(items.slice(i, i + JSON_LIST_CHUNK)));
  }
  return out;
}

export interface HfReading {
  id: bigint;
  hf: bigint;
}

export interface HfBandResult {
  inserted: number;
  stateWrites: number;
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/** Max age of the indexer's `notified` watermark before the pass
 *  defers (Codex #1300 r1). The watermark is stamped only when a scan
 *  BOTH reached the safe head AND finished materializing notifications
 *  — so a fresh stamp means D1's ownership and notification rows are
 *  current. The indexer cron runs every FIVE minutes now (free-plan DO
 *  rows_written diet — webhooks still trigger event scans immediately),
 *  so a healthy quiet chain refreshes the watermark ~every 5 min; 15
 *  minutes tolerates two missed/busy ticks while still bounding how
 *  stale a resolved recipient can be. MUST stay comfortably above the
 *  indexer's cron interval or this pass defers forever. */
const WATERMARK_MAX_AGE_SEC = 900;

/**
 * Record band crossings for one chain's full active-book HF readings.
 * Called from the liquidator pass (AFTER its liquidation submits) with
 * EVERY successful reading — including an empty set, so the terminal
 * prune still runs on a quiet book. Fail-open: returns zeros on any
 * error.
 *
 * Takes both bindings by NAME rather than two positional handles, so the
 * shared and the private database cannot be passed the wrong way round.
 */
export async function recordHfBandNotifications(
  dbs: Pick<Env, 'DB' | 'KEEPER_DB'>,
  chainId: number,
  diamond: string,
  readings: HfReading[],
  nowSec: number,
): Promise<HfBandResult> {
  const empty: HfBandResult = { inserted: 0, stateWrites: 0 };
  try {
    // Read inside the try: a build without a binding must fail open here
    // like every other error, not escape into the liquidator.
    const db = dbs.DB; // shared — indexer_cursor, loans, notifications
    const keeper = dbs.KEEPER_DB; // private — hf_band_state

    // The indexer's "notifications complete through last_block"
    // watermark (Codex #1300 r1) — NOT the main `diamond` cursor, which
    // advances BEFORE materializeNotifications: stamping a cron-sentinel
    // row against it could out-sort that block's still-pending event
    // rows and swallow them under the client's read cursor. No
    // watermark row means the indexer has never completed a caught-up
    // pass on this chain — nothing to resolve against; skip.
    const cursors = await db
      .prepare(
        `SELECT kind, last_block, updated_at FROM indexer_cursor
          WHERE chain_id = ? AND kind IN ('notified', 'diamond')`,
      )
      .bind(chainId)
      .all<{ kind: string; last_block: number; updated_at: number }>();
    const watermark = (cursors.results ?? []).find((c) => c.kind === 'notified');
    const diamondTip = (cursors.results ?? []).find((c) => c.kind === 'diamond');
    if (!watermark) return empty;
    const headBlock = watermark.last_block;

    // Prune state for loans that left the active set (repaid/defaulted/
    // liquidated) — their terminal inbox rows come from the indexer's
    // event materializer; keeping band state would only re-alert a
    // re-observed id. Runs every pass, BEFORE the staleness/empty
    // returns (Codex #1300 r1: a chain whose last at-risk loan just
    // closed has zero readings but still needs its rows pruned), and
    // is safe against a lagging index: a terminal D1 status is
    // definitive, it can only arrive late — never wrongly. Bounded:
    // hf_band_state holds only at-risk loans.
    await pruneTerminalBandState(db, keeper, chainId, diamond);

    if (readings.length === 0) return empty;

    // STALENESS GATE (Codex #1300 r1): the HF readings are LIVE RPC
    // state, but recipients and band-state commits resolve against D1.
    // If the indexer hasn't completed a caught-up pass recently, a
    // just-transferred borrower position could still show its previous
    // holder — the row would go to the wrong wallet and the committed
    // state would swallow the crossing for the real holder. Defer the
    // tick instead; the crossing re-detects as soon as the watermark
    // freshens. (Residual window: a transfer inside the last watermark
    // interval — minutes — can still resolve to the just-previous
    // holder; the position page and the subscriber alert rail remain
    // the authoritative/immediate surfaces.)
    if (nowSec - watermark.updated_at > WATERMARK_MAX_AGE_SEC) {
      console.warn(
        `[keeper] hfBandNotifications chain=${chainId} deferred — notified watermark is ${nowSec - watermark.updated_at}s old`,
      );
      return empty;
    }
    // TIP GATE (Codex #1300 r2): age alone still admits the window
    // where a scan is IN FLIGHT — the `diamond` cursor has advanced
    // past a still-fresh watermark (or the fail-open stamp was
    // missed), and event/calendar rows at blocks > watermark may
    // already be visible. An HF row stamped at the OLDER watermark
    // block would sort behind them, so a wallet that just opened the
    // inbox could advance its read cursor past the HF row before it
    // exists. Mint only when the watermark has caught the indexed tip;
    // a mid-scan tick simply defers (the next tick re-detects).
    if (diamondTip && watermark.last_block < diamondTip.last_block) {
      return empty;
    }

    const observed = readings.map((r) => {
      const milli = hfToMilli(r.hf);
      return { loanId: Number(r.id), milli, band: classifyBand(milli) };
    });

    // Stored (band, recipient) per loan — absence = healthy; healthy
    // loans carry no row (keeper migration 0001). The recipient is part of
    // the edge (Codex #1300 r2): a borrower transfer inside the SAME
    // band must still notify the new holder.
    const prev = new Map<number, { band: HfBand; recipient: string }>();
    const prevChunks = jsonChunks(observed.map((o) => o.loanId));
    if (prevChunks.length > 0) {
      const parts = await keeper.batch<{ loan_id: number; last_band: HfBand; last_recipient: string }>(
        prevChunks.map((ids) =>
          keeper
            .prepare(
              `SELECT s.loan_id, s.last_band, s.last_recipient
                 FROM json_each(?) j
                 JOIN hf_band_state s ON s.chain_id = ? AND s.loan_id = j.value`,
            )
            .bind(ids, chainId),
        ),
      );
      for (const part of parts) {
        for (const row of part.results ?? []) {
          prev.set(row.loan_id, { band: row.last_band, recipient: row.last_recipient });
        }
      }
    }

    // Borrower recipients — the CURRENT position holder from the shared
    // loans table — for every loan currently INSIDE a band (needed for
    // both the mint decision and the state commit; healthy loans only
    // ever DELETE state, which needs no recipient).
    const inBand = observed.filter((o) => o.band !== 'healthy');
    // Each holder is read TOGETHER with the newest of the indexer's loan
    // withdrawals (#2638), in ONE statement, so both come from one snapshot of
    // the shared database (Codex #2655 r4). That number is this pass's
    // causal token for the loan, and it is the one fence both of the pass's
    // writes about the loan carry: the inbox row refuses to land if a
    // withdrawal of the loan newer than it exists, and the marker is stamped
    // with it so the prune can tell a marker written about the withdrawn loan
    // from one written about the loan the chain later gave the same id. Read
    // in separate statements, a withdrawal and reissue landing between them
    // would stamp the reissued loan's marker with a token older than the
    // withdrawal it had in fact seen, and the prune would drop it. Ordered by
    // the record's own AUTOINCREMENT ids, never this machine's clock against
    // the indexer's (Codex #2655 r1). See `pruneTerminalBandState`.
    const holderByLoan = new Map<number, { recipient: string; orphanSeq: number }>();
    const holderChunks = jsonChunks(inBand.map((o) => o.loanId));
    if (holderChunks.length > 0) {
      const parts = await db.batch<{
        loan_id: number;
        borrower: string | null;
        borrower_current_owner: string | null;
        orphan_seq: number;
      }>(
        holderChunks.map((ids) =>
          db
            .prepare(
              `SELECT l.loan_id, l.borrower, l.borrower_current_owner,
                      (SELECT COALESCE(MAX(id), 0) FROM loan_orphans) AS orphan_seq
                 FROM json_each(?) j
                 JOIN loans l ON l.chain_id = ? AND l.loan_id = j.value`,
            )
            .bind(ids, chainId),
        ),
      );
      for (const part of parts) {
        for (const row of part.results ?? []) {
          const who = (row.borrower_current_owner ?? row.borrower ?? '').toLowerCase();
          if (who && who !== ZERO_ADDR) {
            holderByLoan.set(row.loan_id, { recipient: who, orphanSeq: Number(row.orphan_seq ?? 0) });
          }
        }
      }
    }

    // The edge decision per loan:
    //   - band WORSENED (incl. first observation inside a band) → mint;
    //   - band unchanged/improved but still in-band AND the borrower
    //     position moved to a NEW holder → mint (the claim follows the
    //     NFT; the previous holder's row can't warn the new one);
    //   - recovery to healthy → delete state silently.
    // A loan inside a band whose recipient can't be resolved yet
    // (indexer lag) is DEFERRED: no row AND no state write, so the next
    // tick retries the same edge instead of silently swallowing it.
    const dayBucket = Math.floor(nowSec / 86_400);
    interface Row {
      loanId: number;
      recipient: string;
      kind: string;
      dedupKey: string;
      orphanSeq: number;
    }
    const rows: Row[] = [];
    interface Commit {
      loanId: number;
      band: HfBand;
      milli: number;
      recipient: string | null; // null only for healthy (DELETE)
      orphanSeq: number | null; // null only for healthy (DELETE)
    }
    const commits: Commit[] = [];
    for (const o of observed) {
      const p = prev.get(o.loanId);
      const prevBand: HfBand = p?.band ?? 'healthy';
      if (o.band === 'healthy') {
        if (p) commits.push({ loanId: o.loanId, band: 'healthy', milli: o.milli, recipient: null, orphanSeq: null });
        continue;
      }
      const holder = holderByLoan.get(o.loanId);
      if (!holder) continue; // deferred — retry next tick
      const { recipient, orphanSeq } = holder;
      const worsened = BAND_RANK[o.band] > BAND_RANK[prevBand];
      const holderChanged = p !== undefined && recipient !== p.recipient;
      if (worsened || holderChanged) {
        const kind = BAND_KIND[o.band as Exclude<HfBand, 'healthy'>];
        rows.push({
          loanId: o.loanId,
          recipient,
          kind,
          // Same segment order as the indexer's producers
          // (`chain:recipient:kind:loan:<discriminator>`); the day
          // bucket bounds a flapping HF to one row per band per UTC
          // day PER RECIPIENT (a new holder's key always differs).
          dedupKey: `${chainId}:${recipient}:${kind}:${o.loanId}:${dayBucket}`,
          orphanSeq,
        });
      }
      if (o.band !== prevBand || holderChanged) {
        commits.push({ loanId: o.loanId, band: o.band, milli: o.milli, recipient, orphanSeq });
      }
    }

    // Each insert carries two guards in its own statement. The epoch guard
    // (epochFence.ts): a row lands only while the indexer's epoch for this
    // chain is the one this process runs under. And the loan's causal token
    // (above): a row lands only while no withdrawal of the loan newer than the
    // holder read exists (Codex #2655 r4). The indexer's move takes the loan's
    // inbox rows with it and refuses to run if one appears mid-move, so a row
    // this pass inserted before the move goes with the loan; without the
    // token, one inserted AFTER it would recreate the withdrawn loan's alert,
    // and a loan the chain gives the same id that day, same holder and band,
    // would collide with it on the dedup key and never get its own. A refused
    // row still leaves its marker committed below; the next prune drops that
    // marker by the same token, and the loan alerts afresh.
    //
    // An `INSERT OR IGNORE` cannot report a refusal by its change count — a
    // duplicate changes nothing too — so when a non-empty batch inserted
    // nothing the epoch fence is asked, and a moved epoch is thrown as the
    // refusal it was rather than logged as "0 inserted".
    const guard = epochWriteGuard(chainId);
    const diamondKey = diamond.toLowerCase();
    let inserted = 0;
    const rowChunks = jsonChunks(rows.map((r) => [r.recipient, r.kind, r.loanId, r.dedupKey, r.orphanSeq]));
    if (rowChunks.length > 0) {
      const results = await db.batch(
        rowChunks.map((tuples) =>
          db
            .prepare(
              `INSERT OR IGNORE INTO notifications
                 (chain_id, recipient, kind, loan_id, event_kind,
                  block_number, log_index, created_at, dedup_key)
               SELECT ?, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'),
                      json_extract(j.value, '$[2]'), NULL, ?, ?, ?, json_extract(j.value, '$[3]')
                 FROM json_each(?) j
                WHERE ${guard.where}
                  AND NOT EXISTS (SELECT 1 FROM loan_orphans o
                                   WHERE o.chain_id = ? AND o.diamond = ?
                                     AND o.loan_id = json_extract(j.value, '$[2]')
                                     AND o.id > json_extract(j.value, '$[4]'))`,
            )
            .bind(chainId, headBlock, CRON_LOG_INDEX, nowSec, tuples, ...guard.binds, chainId, diamondKey),
        ),
      );
      for (const res of results) {
        inserted += (res as { meta?: { changes?: number } }).meta?.changes ?? 0;
      }
    }
    if (rows.length > 0 && inserted === 0) await assertEpochsHold();

    // Commit the observed (band, recipient) for every edge; deferred
    // loans never reached `commits`, so they retry next tick.
    // Recoveries to healthy DELETE the row — absence means healthy,
    // keeping the table proportional to the at-risk book.
    const healed = commits.filter((o) => o.band === 'healthy').map((o) => o.loanId);
    const banded = commits
      .filter((o) => o.band !== 'healthy')
      .map((o) => [o.loanId, o.band, o.milli, o.recipient, o.orphanSeq]);
    const stateStatements = [
      ...jsonChunks(healed).map((ids) =>
        keeper
          .prepare(
            `DELETE FROM hf_band_state
              WHERE chain_id = ? AND loan_id IN (SELECT value FROM json_each(?))`,
          )
          .bind(chainId, ids),
      ),
      // `WHERE true`: an upsert's SELECT needs a WHERE before ON CONFLICT, or
      // SQLite parses the ON as a join constraint.
      ...jsonChunks(banded).map((tuples) =>
        keeper
          .prepare(
            `INSERT INTO hf_band_state
               (chain_id, loan_id, last_band, last_hf_milli, last_recipient, updated_at, orphan_seq)
             SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'),
                    json_extract(value, '$[2]'), json_extract(value, '$[3]'), ?,
                    json_extract(value, '$[4]')
               FROM json_each(?) WHERE true
             ON CONFLICT (chain_id, loan_id) DO UPDATE SET
               last_band = excluded.last_band,
               last_hf_milli = excluded.last_hf_milli,
               last_recipient = excluded.last_recipient,
               updated_at = excluded.updated_at,
               orphan_seq = excluded.orphan_seq`,
          )
          .bind(chainId, nowSec, tuples),
      ),
    ];
    if (stateStatements.length > 0) await keeper.batch(stateStatements);
    const stateWrites = commits.length;

    return { inserted, stateWrites };
  } catch (err) {
    console.error(
      `[keeper] hfBandNotifications chain=${chainId} failed (fail-open): ${String(err).slice(0, 250)}`,
    );
    return empty;
  }
}

/**
 * Drop band state the indexer's records show is no longer about a live loan.
 * Two cases:
 *
 *   1. TERMINAL. A `loans` row for the id EXISTS with a non-active status. A
 *      loan the index has not caught up with yet keeps its state: a terminal
 *      status can only arrive late, never wrongly.
 *   2. WITHDRAWN (#2638). The indexer proved, at a settled block, that this
 *      Diamond has no loan at the id, and moved its row to `loan_orphans`
 *      (#2197). The withdrawn loan has no `loans` row, so case 1 never sees it,
 *      and without this its marker would outlive it: a real loan the chain
 *      later issues the same id, to the same holder in the same band, would
 *      read as an unchanged observation and its first alert would be
 *      swallowed. The indexer clears its own alert memory for the id in the
 *      move; it has no binding to this database, so this is the keeper's half.
 *
 *      A marker goes only when the withdrawal is one it had NOT seen: an
 *      entry whose `id` is above the marker's `orphan_seq`, the newest entry
 *      the writing pass read IN THE SAME STATEMENT as the loan's holder, so
 *      from one snapshot. A marker is written only for a loan with a `loans`
 *      row (an unresolved holder defers), so a withdrawal after that read is
 *      the move of the very row the marker was written from. A withdrawal the marker had already seen
 *      came before it, so the marker is about the loan that bears the id now
 *      — the id reissued — and is kept: that loan's own edges are tracked as
 *      normal and never re-alerted every pass. The order is the entries' own
 *      AUTOINCREMENT ids, read and written through the shared database, never
 *      this machine's clock against the indexer's (Codex #2655 r1). An
 *      operator's put-back of a withdrawal (migration 0065: the row and its
 *      inbox rows re-inserted, the entry deleted) removes the evidence, and
 *      rightly keeps a marker the prune had not yet dropped: the put-back
 *      says the loan was real all along, so the marker describes it, and its
 *      alert rows come back with it. The entry
 *      must name THIS Diamond: entries outlive a fresh Diamond on the chain,
 *      and an old Diamond's withdrawal says nothing about the new one's ids.
 *
 *      A marker from before `orphan_seq` existed (NULL) carries no such
 *      record, so it is judged by the one fact that is still causal: it was
 *      written from a `loans` row. With a withdrawal recorded for the id and
 *      no row left, it is about the withdrawn loan and goes. With a row
 *      present the id may already be a reissued loan, so it is kept, and this
 *      prune stamps it with the newest withdrawal it read beforehand; from
 *      then on it is judged like any other marker. What that cannot recover
 *      is a stale legacy marker on an id withdrawn AND reissued before the
 *      upgrade: nothing records which loan it was written from.
 *
 * TWO DATABASES (#2450): the state is keeper-private and `loans` /
 * `loan_orphans` are the indexer's, and D1 cannot join across databases, so
 * this reads the markers, reads both shared tables for those ids, and deletes.
 *
 * Bounded the way the old join was — the state table holds only at-risk
 * loans — and cheap in the subrequests this Worker counts: one read when
 * nothing is banded, then one `batch()` of shared reads and one of writes,
 * however many markers there are. Each statement binds its id list as one
 * JSON parameter (see `JSON_LIST_CHUNK`), so the marker count never reaches a
 * bind limit.
 */
async function pruneTerminalBandState(
  db: D1Database,
  keeper: Env['KEEPER_DB'],
  chainId: number,
  diamond: string,
): Promise<void> {
  const state = await keeper
    .prepare(`SELECT loan_id, orphan_seq FROM hf_band_state WHERE chain_id = ?1`)
    .bind(chainId)
    .all<{ loan_id: number; orphan_seq: number | null }>();
  const markers = state.results ?? [];
  if (markers.length === 0) return;
  // Each statement reads, for its chunk of marker ids, the loan's status, its
  // latest withdrawal under this Diamond (an id withdrawn, reissued and
  // withdrawn again is judged against the last move) and the newest
  // withdrawal of all: one statement, so one snapshot, per chunk.
  const parts = await db.batch<{ loan_id: number; status: string | null; seq: number | null; baseline: number }>(
    jsonChunks(markers.map((r) => r.loan_id)).map((ids) =>
      db
        .prepare(
          `SELECT j.value AS loan_id,
                  (SELECT status FROM loans WHERE chain_id = ? AND loan_id = j.value) AS status,
                  (SELECT MAX(id) FROM loan_orphans
                    WHERE chain_id = ? AND diamond = ? AND loan_id = j.value) AS seq,
                  (SELECT COALESCE(MAX(id), 0) FROM loan_orphans) AS baseline
             FROM json_each(?) j`,
        )
        .bind(chainId, chainId, diamond.toLowerCase(), ids),
    ),
  );
  // Markers written before `orphan_seq` existed (keeper migration 0006).
  const legacy = markers.filter((r) => r.orphan_seq === null).map((r) => r.loan_id);
  // The baseline a legacy marker that survives this prune is stamped with: the
  // OLDEST any chunk read, so it is no newer than the snapshot its loan row was
  // judged in. A withdrawal recorded after it carries a higher id, so it still
  // drops the marker later — and erring older only ever drops a pre-upgrade
  // marker that a later withdrawal made doubtful anyway.
  let baseline = Number.POSITIVE_INFINITY;
  const status = new Map<number, string>();
  const withdrawnSeq = new Map<number, number>();
  for (const part of parts) {
    for (const r of part.results ?? []) {
      baseline = Math.min(baseline, Number(r.baseline));
      if (r.status !== null) status.set(r.loan_id, r.status);
      if (r.seq !== null) withdrawnSeq.set(r.loan_id, r.seq);
    }
  }
  const stale = new Set<number>();
  for (const m of markers) {
    const st = status.get(m.loan_id);
    if (st !== undefined && st !== 'active') {
      stale.add(m.loan_id); // terminal
      continue;
    }
    const w = withdrawnSeq.get(m.loan_id);
    if (w === undefined) continue;
    if (m.orphan_seq !== null) {
      if (w > m.orphan_seq) stale.add(m.loan_id); // withdrawn after the marker's read
    } else if (st === undefined) {
      // A legacy marker has no record of which withdrawals it saw. It was
      // written from a `loans` row, and the row is gone with a withdrawal
      // recorded for the id: the move of that row. With a row present the id
      // has been issued again, and the marker may describe that loan, so it is
      // kept (Codex #2655 r2) and given the baseline below.
      stale.add(m.loan_id);
    }
  }

  // Stamp the legacy markers this prune keeps, once, so every later prune
  // judges them by the record's order like any other marker.
  const baselined = legacy.filter((id) => !stale.has(id));
  const writes = [
    ...jsonChunks(baselined).map((ids) =>
      keeper
        .prepare(
          `UPDATE hf_band_state SET orphan_seq = ?
            WHERE chain_id = ? AND orphan_seq IS NULL
              AND loan_id IN (SELECT value FROM json_each(?))`,
        )
        .bind(baseline, chainId, ids),
    ),
    ...jsonChunks([...stale]).map((ids) =>
      keeper
        .prepare(
          `DELETE FROM hf_band_state
            WHERE chain_id = ? AND loan_id IN (SELECT value FROM json_each(?))`,
        )
        .bind(chainId, ids),
    ),
  ];
  if (writes.length > 0) await keeper.batch(writes);
}
