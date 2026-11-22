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
}

export const RECORDS_PER_WRITE = 20;
const HOUR = 3600;
const DAY = 86_400;

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
  audited?: { from: number; to: number; found: number; missed: number };
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
  const result: RunResult = { chainId, mode: plan.mode, records: 0, findings: [] };
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
        const listed = async (addresses: string[], a: number, b: number): Promise<void> => {
          for (const address of addresses) {
            try {
              for (const t of await ctx.explorer!.failedSentTo(address, a, b)) add(t.hash, t.blockNumber, 'explorer-list');
            } catch (e) {
              if (isWait(e)) throw new Hold(`the explorer did not answer (${why(e)})`);
              gaps.push({ fromBlock: a, toBlock: b, reason: `the explorer refused the list for ${address}: ${why(e)}` });
              alert(`explorer-refused-${address}`, `Chain ${chainId}: the explorer refused the list for ${address} (${why(e)}); blocks ${a} to ${b} recorded as a gap for it.`);
            }
          }
        };
        await listed(plan.direct, from, to);
        const slowFrom = (slow ?? start) + 1;
        if ((to - slowFrom + 1) * plan.blockTimeSeconds >= HOUR) {
          const rest = plan.watched.filter((a) => !plan.direct.includes(a));
          await listed(rest, slowFrom, to);
          slow = to;
        }
      }
      // sends-and-audit: the keeper's own sends are the only continuous
      // source, and the keeper decision record (§4.4) that carries them is
      // not built yet, so the cursor only marks the blocks passed.
    }

    // 5. Decode and write.
    const records: FailedTxRecord[] = [];
    const ordered = [...found.entries()].sort((x, y) => x[1].blockNumber - y[1].blockNumber);
    for (const [hash, f] of ordered) {
      if (f.blockNumber > to) continue;
      try {
        const r = await recordFor({ rpc, chainId, mode: plan.mode, nameOf: ctx.nameOf }, hash, f.foundBy);
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
    for (let i = 0; i < kept.length; i += RECORDS_PER_WRITE) {
      await indexer.write({ kind: 'records', chainId, records: kept.slice(i, i + RECORDS_PER_WRITE) });
    }
    result.records += kept.length;
    for (const r of kept) if (r.stateUnreachable) alert(`unreachable-${r.txHash}`, `Chain ${chainId}: ${r.txHash} failed, but the node no longer held its block's state; the record holds the receipt only.`);
    const cursorTo = Math.max(start, to);
    if (from <= cursorTo) result.scanned = { from, to: cursorTo };

    // 6. The audit slice.
    let auditPlan = state.cursor?.auditPlan ?? null;
    let auditedTo = state.auditedTo;
    const audits: Array<{ fromBlock: number; toBlock: number; found: number; missed: number }> = [];
    if (plan.mode === 'list-and-audit' || plan.mode === 'sends-and-audit') {
      const day = dayOf(ctx.now() - DAY);
      if (!auditPlan || auditPlan.day !== day) {
        auditPlan = await planAudit(ctx, block, day, headNumber);
        auditedTo = null;
      }
      if (auditPlan) {
        const covered = plan.mode === 'sends-and-audit' || (cursorTo >= auditPlan.toBlock && (slow ?? cursorTo) >= auditPlan.toBlock);
        const next = (auditedTo ?? auditPlan.fromBlock - 1) + 1;
        if (!covered) {
          note('audit-waits', `Chain ${chainId}: the audit of ${auditPlan.day} waits for the list to reach block ${auditPlan.toBlock}.`);
        } else if (next <= auditPlan.toBlock) {
          const sliceTo = Math.min(auditPlan.toBlock, next + settings.auditBlocksPerRun - 1);
          const failures: Array<{ hash: string; blockNumber: number }> = [];
          let doneTo = next - 1;
          for (let b = next; b <= sliceTo; b++) {
            let receipts: Array<{ transactionHash: string; to: string | null; status: string }>;
            try {
              receipts = (await rpc.call<typeof receipts | null>('eth_getBlockReceipts', [hex(b)])) ?? [];
            } catch (e) {
              if (isWait(e)) break;
              throw e;
            }
            for (const r of receipts) {
              if (num(r.status) === 0 && r.to && plan.watched.includes(r.to.toLowerCase())) failures.push({ hash: r.transactionHash.toLowerCase(), blockNumber: b });
            }
            doneTo = b;
          }
          if (doneTo >= next) {
            const recorded = new Set((await indexer.state(chainId, { from: next, to: doneTo })).recorded ?? []);
            const missed = failures.filter((x) => !recorded.has(x.hash));
            const audited: FailedTxRecord[] = [];
            for (const m of missed) {
              const r = await recordFor({ rpc, chainId, mode: plan.mode, nameOf: ctx.nameOf }, m.hash, 'audit');
              if (r) audited.push(r);
              if (plan.mode === 'list-and-audit') {
                alert(`audit-missed-${m.hash}`, `Chain ${chainId}: the audit found ${m.hash} (block ${m.blockNumber}), a failed transaction the explorer's list did not return. It is now recorded; open a card for the miss.`);
              }
            }
            for (let i = 0; i < audited.length; i += RECORDS_PER_WRITE) {
              await indexer.write({ kind: 'records', chainId, records: audited.slice(i, i + RECORDS_PER_WRITE) });
            }
            result.records += audited.length;
            audits.push({ fromBlock: next, toBlock: doneTo, found: failures.length, missed: missed.length });
            result.audited = { from: next, to: doneTo, found: failures.length, missed: missed.length };
          }
        }
      }
    }

    // The cursor, its checkpoint, gaps and audit slices, in one statement.
    const top = await block(cursorTo);
    await indexer.write({
      kind: 'cursor',
      chainId,
      cursor: {
        mode: plan.mode,
        blockNumber: cursorTo,
        blockTime: num(top.timestamp),
        watchedShareBps: plan.mode === 'sends-and-audit' ? Math.round((settings.auditWindowSeconds * 10_000) / DAY) : null,
        slowBlockNumber: plan.mode === 'list-and-audit' ? (slow ?? cursorTo) : null,
        auditPlan: plan.mode === 'trace-filter' ? null : auditPlan,
        checkpoints: [{ blockNumber: cursorTo, blockHash: top.hash.toLowerCase() }],
        gaps,
        audits,
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
