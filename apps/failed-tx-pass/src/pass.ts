/**
 * One run of the failed transaction pass for one network (#3919,
 * TroubleshootingPictureDesign.md §4.3).
 *
 * Each run, in order:
 *   1. reads back its own state (cursor, checkpoints, audit plan) from the
 *      indexer, the only store it has;
 *   2. reads the network's settled head (`safe`, the block the indexer reads),
 *      and holds when the node will not say;
 *   3. reads its newest checkpoint's block twice. Only two agreeing reads
 *      that differ from the checkpoint are a replacement; it then walks back
 *      to the newest checkpoint the chain still agrees with, marks every
 *      record above it replaced (nothing is deleted), and scans the range
 *      again. A failed or disagreeing read holds the run;
 *   4. finds failed transactions in the blocks after its cursor, by its mode:
 *      a trace filter over the watched contracts, or the explorer's list
 *      (the contracts users call directly every run, the rest hourly);
 *   5. decodes each one while the node still has the state (`record.ts`) and
 *      writes the records, then its cursor and a checkpoint;
 *   6. in list-and-audit and sends-and-audit mode, scans a slice of the day's
 *      audit window: a random 30 minutes of the previous UTC day, every block
 *      read in full and compared with what the other sources recorded there.
 *      A failure they missed is recorded and reported.
 *
 * A node or explorer that does not answer holds the run: nothing is skipped,
 * and the next run starts where this one stood. A range that is refused
 * outright is written as a gap with its reason. Findings for the operator go
 * back to the host, which alerts.
 */
import type { CodeName } from '@vaipakam/lib/txExplainer';
import { ExplorerFailure, type Explorer } from './explorer';
import { IndexerFailure, type IndexerClient, type PassState } from './indexer';
import { recordFor, type FailedTxRecord, type FoundBy } from './record';
import { RpcFailure, hex, num, type Rpc } from './rpc';
import type { ChainPlan } from './chains';
import { MAX_RECORDS_PER_WRITE } from '@vaipakam/lib/failedTxBounds';

export interface PassSettings {
  /** The most blocks one run moves the cursor by (a catch-up is spread over runs). */
  maxBlocksPerRun: number;
  /** The most trace filter requests one run makes. */
  maxTraceRequestsPerRun: number;
  /** The audit window's length (§4.3, Default 30 minutes). */
  auditWindowSeconds: number;
  /** Blocks of the audit window read per run. */
  auditBlocksPerRun: number;
  /** A cursor older than this raises an alert. */
  behindSeconds: number;
  /** Where a network with no cursor starts: this far behind the settled head (never before its deploy block). */
  firstRunLookbackSeconds: number;
  /**
   * List-and-audit mode: how far behind each list's position the explorer is
   * asked again. The explorer can index a transaction after the node already
   * shows its block settled; a failure it lists late, within this window, is
   * still collected. One listed later than that is the audit's to find (a
   * measured miss).
   */
  listOverlapSeconds: number;
}

/** Records in one write: the route's own bound. */
export const RECORDS_PER_WRITE = MAX_RECORDS_PER_WRITE;
const HOUR = 3600;
const DAY = 86_400;
/** The widest block range one state read lists recorded transactions for (the indexer's bound). */
const STATE_RECORDED_RANGE = 20_000;

/** Settings for a network, from its block time and a run every five minutes. */
export function defaultSettings(plan: ChainPlan, runsPerDay = 288): PassSettings {
  const window = 30 * 60;
  const windowBlocks = Math.ceil(window / plan.blockTimeSeconds);
  return {
    maxBlocksPerRun: Math.ceil((6 * HOUR) / plan.blockTimeSeconds),
    maxTraceRequestsPerRun: 20,
    auditWindowSeconds: window,
    // The window is read within about half a day.
    auditBlocksPerRun: Math.max(1, Math.ceil((windowBlocks * 2) / runsPerDay)),
    behindSeconds: 30 * 60,
    firstRunLookbackSeconds: DAY,
    listOverlapSeconds: HOUR,
  };
}

export interface Finding {
  chainId: number;
  /** alert: the operator should look; note: recorded for the journal only. */
  level: 'alert' | 'note';
  /** Repeats of the same key are one alert to the host. */
  key: string;
  text: string;
}

export interface RunResult {
  chainId: number;
  mode: string;
  /** Why the run stopped short, when it did. Nothing was skipped. */
  held?: string;
  scanned?: { from: number; to: number };
  records: number;
  /** `missed` null: nothing was measured (the list was not asked about that slice). */
  audited?: { from: number; to: number; found: number; missed: number | null };
  findings: Finding[];
}

export interface RunContext {
  plan: ChainPlan;
  rpc: Rpc;
  explorer?: Explorer;
  indexer: IndexerClient;
  nameOf: (address: string) => CodeName | undefined;
  settings: PassSettings;
  /** Unix seconds. */
  now: () => number;
  /** In [0, 1): the audit window's start. */
  random: () => number;
}

interface Block {
  number: string;
  hash: string;
  timestamp: string;
}

class Hold extends Error {}
/** The explorer will not serve the list on this network: the run falls back to sends-and-audit. */
class ListUnreadable extends Error {}

const isWait = (e: unknown) => (e instanceof RpcFailure && e.kind === 'transient') || (e instanceof ExplorerFailure && e.kind === 'transient');
const why = (e: unknown) => (e instanceof Error ? e.message : 'unknown failure');
const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

export async function runChain(ctx: RunContext): Promise<RunResult> {
  const { plan, rpc, settings } = ctx;
  const chainId = plan.chainId;
  // Every read and write names the Diamond this run scans under; the indexer
  // refuses (409) when its deployment record names another.
  const indexer = {
    state: (_chainId: number, span?: { from: number; to: number }) => ctx.indexer.state(chainId, plan.diamond, span),
    write: (body: Record<string, unknown>) => ctx.indexer.write({ ...body, diamond: plan.diamond }),
  };
  // The mode this run actually runs: the plan's, unless the explorer will not
  // serve the list (§4.3: then sends-and-audit, with the watched share stated).
  let mode: ChainPlan['mode'] = plan.mode;
  const result: RunResult = { chainId, mode, records: 0, findings: [] };
  const alert = (key: string, text: string) => result.findings.push({ chainId, level: 'alert', key, text });
  const note = (key: string, text: string) => result.findings.push({ chainId, level: 'note', key, text });
  const mismatch = (e: unknown): boolean => {
    if (!(e instanceof IndexerFailure && e.status === 409)) return false;
    alert(
      'deployment-mismatch',
      `Chain ${chainId}: the indexer's deployment record names another Diamond than this pass's (${plan.diamond}). Nothing was written; the pass holds this network until the two run the same deployment record.`,
    );
    result.held = `the indexer runs another deployment record (${why(e)})`;
    return true;
  };

  const block = async (n: number | 'safe'): Promise<Block> => {
    const b = await rpc.call<Block | null>('eth_getBlockByNumber', [typeof n === 'number' ? hex(n) : n, false]);
    if (!b) throw new RpcFailure('transient', null, `block ${String(n)} is not yet known to the node`);
    return b;
  };
  /** The block's hash, read twice; undefined when the two reads disagree. */
  const hashTwice = async (n: number): Promise<string | undefined> => {
    const a = await block(n);
    const b = await block(n);
    return a.hash.toLowerCase() === b.hash.toLowerCase() ? a.hash.toLowerCase() : undefined;
  };

  let state: PassState;
  try {
    state = await indexer.state(chainId);
  } catch (e) {
    if (mismatch(e)) return result;
    result.held = `its state could not be read from the indexer (${why(e)})`;
    // Without its state the pass records nothing, so this is an operator's
    // matter on every run it lasts (the host repeats it at its own pace).
    alert('state-unreadable', `Chain ${chainId}: the failed transaction pass could not read its state from the indexer (${why(e)}); nothing is being recorded for this network.`);
    return result;
  }

  // 2. The settled head.
  let head: Block;
  try {
    head = await block('safe');
  } catch (e) {
    result.held = `the node gave no settled head (${why(e)})`;
    behind(result, state.cursor?.blockTime, ctx.now(), settings.behindSeconds);
    return result;
  }
  const headNumber = num(head.number);

  let start = state.cursor?.blockNumber ?? null;
  let slow = plan.mode === 'list-and-audit' ? (state.cursor?.slowBlockNumber ?? start) : null;
  // Every cursor write stores a checkpoint at the cursor, so the newest live
  // checkpoint is the cursor's own unless a replacement marked it. A cursor
  // above the newest live checkpoint therefore means a replacement was marked
  // and the run that marked it stopped before rewinding: scan again from the
  // checkpoint. The rewind lives in what is stored, not in one run's memory.
  const live = state.checkpoints[0];
  if (live && start !== null && live.blockNumber < start) {
    start = live.blockNumber;
    if (slow !== null) slow = Math.min(slow, live.blockNumber);
  }

  try {
    // 3. A replaced block.
    const newest = state.checkpoints[0];
    if (newest) {
      if (newest.blockNumber > headNumber) throw new Hold(`the settled head ${headNumber} is below the newest checkpoint ${newest.blockNumber}`);
      const h = await hashTwice(newest.blockNumber);
      if (h === undefined) throw new Hold(`two reads of block ${newest.blockNumber} disagreed`);
      if (h !== newest.blockHash) {
        let agree: { blockNumber: number; blockHash: string } | undefined;
        for (const cp of state.checkpoints.slice(1)) {
          const x = await hashTwice(cp.blockNumber);
          if (x === undefined) throw new Hold(`two reads of block ${cp.blockNumber} disagreed during the replacement walk`);
          if (x === cp.blockHash) {
            agree = cp;
            break;
          }
        }
        if (!agree) {
          alert('replaced-too-deep', `Chain ${chainId}: block ${newest.blockNumber} was replaced, and no checkpoint the pass still holds agrees with the chain. Nothing was marked; the pass holds until an operator looks.`);
          throw new Hold('a replacement deeper than the checkpoints held');
        }
        const top = Math.max(start ?? newest.blockNumber, newest.blockNumber);
        await indexer.write({ kind: 'replaced', chainId, fromBlock: agree.blockNumber + 1, toBlock: top, staleCheckpoint: { blockNumber: newest.blockNumber, blockHash: newest.blockHash } });
        note('replaced', `Chain ${chainId}: blocks ${agree.blockNumber + 1} to ${top} were replaced; their records are marked and the range is scanned again.`);
        start = agree.blockNumber;
        if (slow !== null) slow = Math.min(slow, agree.blockNumber);
      }
    }

    // 4. Where to scan.
    if (start === null) {
      start = Math.max(plan.deployBlock, headNumber - Math.ceil(settings.firstRunLookbackSeconds / plan.blockTimeSeconds));
      if (plan.mode === 'list-and-audit') slow = start;
    }
    const from = start + 1;
    let to = Math.min(headNumber, start + settings.maxBlocksPerRun);
    // The branch this run scans: the hash of the range's top block, read
    // before anything is found. A block hash commits to every block below it,
    // so while that top block keeps this hash, everything the run read below
    // it is on the same branch. It is checked again before records are
    // written and after the checkpoint's block is read; a change holds the run
    // with nothing past the last checkpoint stored, and the next run's
    // checkpoint check finds the replacement.
    const plannedTo = to;
    const plannedHash = from <= to ? (await block(plannedTo)).hash.toLowerCase() : undefined;
    const sameBranch = async (): Promise<void> => {
      if (plannedHash === undefined) return;
      const now = (await block(plannedTo)).hash.toLowerCase();
      if (now !== plannedHash) throw new Hold(`block ${plannedTo} changed while the run read the range below it; nothing past the last checkpoint is stored`);
    };
    const found = new Map<string, { foundBy: FoundBy; blockNumber: number }>();
    const gaps: Array<{ fromBlock: number; toBlock: number; reason: string }> = [];
    const add = (hash: string, blockNumber: number, foundBy: FoundBy) => {
      if (!found.has(hash)) found.set(hash, { foundBy, blockNumber });
    };

    if (from <= to) {
      if (plan.mode === 'trace-filter') {
        let requests = 0;
        for (let a = from; a <= to; a += plan.traceFilterRange) {
          if (requests++ >= settings.maxTraceRequestsPerRun) {
            to = a - 1;
            break;
          }
          const b = Math.min(to, a + plan.traceFilterRange - 1);
          try {
            const traces = await rpc.call<Array<{ error?: string; transactionHash?: string; blockNumber?: number }>>('trace_filter', [
              { fromBlock: hex(a), toBlock: hex(b), toAddress: plan.watched },
            ]);
            for (const t of traces ?? []) {
              if (t.error && t.transactionHash) add(t.transactionHash.toLowerCase(), Number(t.blockNumber ?? a), 'trace-filter');
            }
          } catch (e) {
            if (isWait(e)) {
              to = a - 1;
              result.held = `the trace filter did not answer for blocks ${a} to ${b} (${why(e)})`;
              break;
            }
            gaps.push({ fromBlock: a, toBlock: b, reason: `the node refused the trace filter: ${why(e)}` });
            alert(`gap-${a}`, `Chain ${chainId}: blocks ${a} to ${b} could not be scanned (${why(e)}); recorded as a gap.`);
          }
        }
      } else if (plan.mode === 'list-and-audit') {
        if (!ctx.explorer) throw new Error('list-and-audit mode without an explorer');
        try {
          const listed = async (addresses: string[], a: number, b: number): Promise<void> => {
            for (const address of addresses) {
              try {
                for (const t of await ctx.explorer!.failedSentTo(address, a, b)) add(t.hash, t.blockNumber, 'explorer-list');
              } catch (e) {
                if (isWait(e)) throw new Hold(`the explorer did not answer (${why(e)})`);
                if (e instanceof ExplorerFailure && e.kind === 'unreadable') throw new ListUnreadable(why(e));
                gaps.push({ fromBlock: a, toBlock: b, reason: `the explorer refused the list for ${address}: ${why(e)}` });
                alert(`explorer-refused-${address}`, `Chain ${chainId}: the explorer refused the list for ${address} (${why(e)}); blocks ${a} to ${b} recorded as a gap for it.`);
              }
            }
          };
          // Each list is asked again over the overlap behind its position, for
          // what the explorer indexed late; transactions already recorded there
          // are not decoded again.
          const overlap = Math.ceil(settings.listOverlapSeconds / plan.blockTimeSeconds);
          const back = (a: number) => Math.max(plan.deployBlock, a - overlap);
          await listed(plan.direct, back(from), to);
          const slowFrom = (slow ?? start) + 1;
          let lowest = back(from);
          if ((to - slowFrom + 1) * plan.blockTimeSeconds >= HOUR) {
            const rest = plan.watched.filter((a) => !plan.direct.includes(a));
            lowest = Math.min(lowest, back(slowFrom));
            await listed(rest, back(slowFrom), to);
            slow = to;
          }
          for (let a = lowest; a < from; a += STATE_RECORDED_RANGE) {
            const b = Math.min(from - 1, a + STATE_RECORDED_RANGE - 1);
            for (const h of (await indexer.state(chainId, { from: a, to: b })).recorded ?? []) found.delete(h);
          }
          for (const [hash, f] of found) {
            if (f.blockNumber < from) note(`listed-late-${hash}`, `Chain ${chainId}: the explorer listed ${hash} (block ${f.blockNumber}) after its block was first read; it is recorded now.`);
          }
        } catch (e) {
          if (!(e instanceof ListUnreadable)) throw e;
          // The list cannot be read here: this run is sends-and-audit, and the
          // cursor says so with the share of the day that is watched. Each run
          // asks the list again, so the network returns to list-and-audit by
          // itself once the explorer serves it.
          mode = 'sends-and-audit';
          result.mode = mode;
          found.clear();
          gaps.length = 0;
          slow = null;
          alert('explorer-unreadable', `Chain ${chainId}: the explorer will not serve the transaction list (${why(e)}); the network runs as sends-and-audit, watched only during its audit window, until it does.`);
        }
      }
      // sends-and-audit: the keeper's own sends are the only continuous
      // source, and the keeper decision record (§4.4) that carries them is
      // not built yet, so the cursor only marks the blocks passed.
    }

    // One rule for every record, whichever source found it.
    const unreachable = (r: FailedTxRecord) => {
      if (r.stateUnreachable) alert(`unreachable-${r.txHash}`, `Chain ${chainId}: ${r.txHash} failed, but the node no longer held its block's state; the record holds the receipt only.`);
    };

    // 5. Decode. The records travel in the cursor write (below), so a record
    // is never stored without the checkpoint that lets a later run find its
    // block replaced. One write carries at most RECORDS_PER_WRITE, so the run
    // stops at the block before the one that would overflow it.
    const records: FailedTxRecord[] = [];
    const ordered = [...found.entries()].sort((x, y) => x[1].blockNumber - y[1].blockNumber).filter(([, f]) => f.blockNumber <= to);
    // A block holding more failures than one write: stored ahead of the
    // cursor in plain record writes, the one case where a record precedes its
    // checkpoint (the next run's checkpoint check still covers the block once
    // the cursor write lands).
    let overfull: number | null = null;
    if (ordered.length > RECORDS_PER_WRITE) {
      const first = ordered[0]![1].blockNumber;
      const cut = ordered[RECORDS_PER_WRITE]![1].blockNumber - 1;
      if (cut >= first) to = cut;
      else {
        overfull = first;
        to = first;
      }
      if (slow !== null) slow = Math.min(slow, to);
    }
    for (const [hash, f] of ordered) {
      if (f.blockNumber > to) continue;
      try {
        const r = await recordFor({ rpc, chainId, mode, nameOf: ctx.nameOf }, hash, f.foundBy);
        if (r) records.push(r);
      } catch (e) {
        if (!isWait(e)) throw e;
        // Stop before this transaction's block; the next run picks it up.
        to = f.blockNumber - 1;
        if (slow !== null) slow = Math.min(slow, to);
        result.held = `the node did not answer while decoding ${hash} (${why(e)})`;
        break;
      }
    }
    const kept = records.filter((r) => r.blockNumber <= to);
    let carried = kept;
    if (overfull !== null && to === overfull) {
      await sameBranch();
      for (let i = 0; i < kept.length; i += RECORDS_PER_WRITE) {
        await indexer.write({ kind: 'records', chainId, records: kept.slice(i, i + RECORDS_PER_WRITE) });
      }
      carried = [];
      note(`overfull-${overfull}`, `Chain ${chainId}: block ${overfull} holds more failed transactions than one write carries; its records were stored ahead of the cursor.`);
    }
    result.records += kept.length;
    for (const r of kept) unreachable(r);
    const cursorTo = Math.max(start, to);
    if (from <= cursorTo) result.scanned = { from, to: cursorTo };
    // The first block of the lists' present unbroken coverage: set when the
    // network enters list-and-audit, kept while it stays, cleared when it
    // leaves. An audit slice below it was never asked of the list.
    let listFrom: number | null = null;
    if (mode === 'list-and-audit') {
      const kept0 = state.cursor?.mode === 'list-and-audit' ? (state.cursor.listFromBlock ?? null) : null;
      listFrom = kept0 === null ? from : Math.min(kept0, from);
    }

    // 6. The audit slice.
    let auditPlan = state.cursor?.auditPlan ?? null;
    let auditedTo = state.auditedTo;
    const audits: Array<{ fromBlock: number; toBlock: number; found: number; missed: number | null }> = [];
    if (mode === 'list-and-audit' || mode === 'sends-and-audit') {
      const day = dayOf(ctx.now() - DAY);
      // A window is scanned in full before the next day's is chosen: one
      // started late in the day, or delayed by an outage, is finished first.
      const unfinished = auditPlan !== null && (auditedTo ?? auditPlan.fromBlock - 1) < auditPlan.toBlock;
      if (!auditPlan || (auditPlan.day !== day && !unfinished)) {
        // Days between the finished window and yesterday get no window of
        // their own; that is stated, since in sends-and-audit those days
        // were not watched at all.
        if (auditPlan && auditPlan.day < day) {
          const skipped: string[] = [];
          for (let t = Date.parse(`${auditPlan.day}T00:00:00Z`) / 1000 + DAY; dayOf(t) < day; t += DAY) skipped.push(dayOf(t));
          if (skipped.length) {
            alert(`audit-skipped-${skipped[0]}`, `Chain ${chainId}: no audit window was read for ${skipped.length === 1 ? skipped[0] : `${skipped[0]} to ${skipped[skipped.length - 1]}`} (the previous window finished late)${mode === 'sends-and-audit' ? '; those days were not watched' : ''}.`);
          }
        }
        auditPlan = await planAudit(ctx, block, day, headNumber);
        auditedTo = null;
      }
      if (auditPlan) {
        const covered = mode === 'sends-and-audit' || (cursorTo >= auditPlan.toBlock && (slow ?? cursorTo) >= auditPlan.toBlock);
        // A miss is measured only where the list was asked about the whole
        // window; elsewhere (sends-and-audit, or a window from before the
        // lists' coverage began) the audit records what it finds and states
        // that nothing was measured.
        const measured = mode === 'list-and-audit' && listFrom !== null && listFrom <= auditPlan.fromBlock;
        const next = (auditedTo ?? auditPlan.fromBlock - 1) + 1;
        if (!covered) {
          note('audit-waits', `Chain ${chainId}: the audit of ${auditPlan.day} waits for the list to reach block ${auditPlan.toBlock}.`);
        } else if (next <= auditPlan.toBlock) {
          const sliceTo = Math.min(auditPlan.toBlock, next + settings.auditBlocksPerRun - 1);
          const failures: Array<{ hash: string; blockNumber: number }> = [];
          let doneTo = next - 1;
          for (let b = next; b <= sliceTo; b++) {
            let receipts: Array<{ transactionHash: string; to: string | null; status: string }> | null;
            try {
              receipts = await rpc.call<typeof receipts>('eth_getBlockReceipts', [hex(b)]);
            } catch (e) {
              if (isWait(e)) break;
              throw e;
            }
            // No answer is not an empty block: the slice stops here and the
            // next run reads this block again.
            if (!receipts) {
              note('audit-receipts-unavailable', `Chain ${chainId}: the node gave no receipts for block ${b}; the audit continues from it next run.`);
              break;
            }
            for (const r of receipts) {
              if (num(r.status) === 0 && r.to && plan.watched.includes(r.to.toLowerCase())) failures.push({ hash: r.transactionHash.toLowerCase(), blockNumber: b });
            }
            doneTo = b;
          }
          if (doneTo >= next) {
            // Coverage by the other sources only: a slice read again after an
            // interrupted run must not count the audit's own earlier finds.
            // This run's own discoveries are not stored yet (they travel with
            // the cursor write below), so they count as coverage here too.
            const recorded = new Set([...((await indexer.state(chainId, { from: next, to: doneTo })).recordedByOthers ?? []), ...kept.map((r) => r.txHash)]);
            const missed = failures.filter((x) => !recorded.has(x.hash));
            const audited: FailedTxRecord[] = [];
            for (const m of missed) {
              const r = await recordFor({ rpc, chainId, mode, nameOf: ctx.nameOf }, m.hash, 'audit');
              if (r) {
                audited.push(r);
                unreachable(r);
              }
              if (measured) {
                alert(`audit-missed-${m.hash}`, `Chain ${chainId}: the audit found ${m.hash} (block ${m.blockNumber}), a failed transaction the explorer's list did not return. It is now recorded; open a card for the miss.`);
              }
            }
            for (let i = 0; i < audited.length; i += RECORDS_PER_WRITE) {
              await indexer.write({ kind: 'records', chainId, records: audited.slice(i, i + RECORDS_PER_WRITE) });
            }
            result.records += audited.length;
            // The audit's records lie in the previous day, far below every
            // checkpoint, so they are written on their own.
            audits.push({ fromBlock: next, toBlock: doneTo, found: failures.length, missed: measured ? missed.length : null });
            result.audited = { from: next, to: doneTo, found: failures.length, missed: measured ? missed.length : null };
          }
        }
      }
    }

    // The cursor, its checkpoint, gaps and audit slices, in one statement.
    const top = await block(cursorTo);
    await sameBranch();
    await indexer.write({
      kind: 'cursor',
      chainId,
      cursor: {
        mode,
        blockNumber: cursorTo,
        blockTime: num(top.timestamp),
        watchedShareBps: mode === 'sends-and-audit' ? Math.round((settings.auditWindowSeconds * 10_000) / DAY) : null,
        slowBlockNumber: mode === 'list-and-audit' ? (slow ?? cursorTo) : null,
        listFromBlock: listFrom,
        auditPlan: mode === 'trace-filter' ? null : auditPlan,
        checkpoints: [{ blockNumber: cursorTo, blockHash: top.hash.toLowerCase() }],
        gaps,
        audits,
        records: carried,
      },
    });
    behind(result, num(top.timestamp), ctx.now(), settings.behindSeconds);
    return result;
  } catch (e) {
    if (mismatch(e)) return result;
    if (e instanceof Hold || isWait(e)) {
      result.held = why(e);
      behind(result, state.cursor?.blockTime, ctx.now(), settings.behindSeconds);
      return result;
    }
    throw e;
  }
}

/** The most characters one operator-chat message carries (Telegram takes 4,096). */
export const ALERT_MESSAGE_CHARS = 4_000;
/** An alert's text is cut to this, so any one alert fits a message with its heading. */
const ALERT_TEXT_CHARS = 3_500;

/**
 * Alerts grouped into messages of at most ALERT_MESSAGE_CHARS each, heading
 * included; every alert is in exactly one batch, in order.
 */
export function alertBatches(alerts: Finding[], heading = 'Failed transaction pass'): Finding[][] {
  const batches: Finding[][] = [];
  let batch: Finding[] = [];
  let length = heading.length;
  for (const a0 of alerts) {
    const a = a0.text.length > ALERT_TEXT_CHARS ? { ...a0, text: `${a0.text.slice(0, ALERT_TEXT_CHARS)}…` } : a0;
    const line = 3 + a.text.length; // newline, bullet, space
    if (batch.length && length + line > ALERT_MESSAGE_CHARS) {
      batches.push(batch);
      batch = [];
      length = heading.length;
    }
    batch.push(a);
    length += line;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function behind(result: RunResult, cursorTime: number | undefined, now: number, limit: number): void {
  if (cursorTime === undefined) return;
  const age = now - cursorTime;
  if (age > limit) {
    result.findings.push({
      chainId: result.chainId,
      level: 'alert',
      key: 'behind',
      text: `Chain ${result.chainId}: the failed transaction pass is ${Math.round(age / 60)} minutes behind${result.held ? ` (${result.held})` : ''}.`,
    });
  }
}

/** The previous day's audit window: a random stretch of it, as a block range. Null when the network did not exist yet. */
async function planAudit(
  ctx: RunContext,
  block: (n: number) => Promise<Block>,
  day: string,
  headNumber: number,
): Promise<{ day: string; fromBlock: number; toBlock: number } | null> {
  const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000;
  const window = ctx.settings.auditWindowSeconds;
  const t0 = dayStart + Math.floor(ctx.random() * (DAY - window));
  const atOrAfter = async (t: number): Promise<number> => {
    let lo = ctx.plan.deployBlock;
    let hi = headNumber;
    if (num((await block(hi)).timestamp) < t) return hi + 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (num((await block(mid)).timestamp) < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const fromBlock = await atOrAfter(t0);
  const toBlock = (await atOrAfter(t0 + window)) - 1;
  if (toBlock < fromBlock || fromBlock < ctx.plan.deployBlock) return null;
  return { day, fromBlock, toBlock };
}
