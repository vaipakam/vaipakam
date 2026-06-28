/**
 * #757 Phase A — per-chain ingest Durable Object: the SINGLE serialized writer.
 *
 * One DO instance per chain (`idFromName(String(chainId))`). The webhook route
 * and the cron `scheduled()` both forward a `{ chainId, targetBlock }` hint to
 * this DO; it runs the existing `runChainIndexerForChain` scan. Because all
 * ingest for a chain funnels through one object and is gated by an EXPLICIT
 * single-flight flag, two scans never overlap — so the existing single-writer
 * handlers stay valid unchanged (no lock / watermark / tombstones).
 *
 * SINGLE-WRITER GUARANTEE — it falls out of two runtime facts, not a lock:
 *   (1) a scan runs ONLY inside `alarm()`, and
 *   (2) the Cloudflare runtime never invokes `alarm()` concurrently with itself
 *       for a given DO (one instance per id; one alarm handler at a time).
 * So two scans for a chain can never overlap, and the existing single-writer
 * handlers stay valid unchanged — no lock, lease, watermark, or tombstone. This
 * is why earlier lease/`getAlarm()` attempts were the wrong shape: there is
 * nothing to "lease", because the runtime already serializes the only place a
 * scan runs. (Belt-and-suspenders for a rollout/migration overlap window: the
 * cursor advance is monotonic and the event handlers are re-scan-idempotent —
 * block-pinned absolute reads, #760 — so even a hypothetical overlap can't
 * corrupt or rewind state.)
 *
 * COALESCING — `pendingTarget` (persisted, monotonic high-water mark) absorbs
 * concurrent triggers; `alarm()` re-reads it AFTER each scan, and every trigger
 * re-arms the single alarm slot, so a target raised in the brief window between
 * the scan's final read and `finally` is still serviced promptly (not deferred
 * to the next cron ping). The in-memory `scanRunning` flag is NOT the overlap
 * guard (the runtime is) — it only decides whether a fresh trigger may reset the
 * catch-up `attempts` budget without clobbering an in-flight loop's counter.
 *
 * Catch-up loop (alarm-driven, Hibernation-friendly): each `alarm()` runs ONE
 * `runChainIndexerForChain` (one cursor-derived, safe-head-bounded scan) and
 * re-arms itself until the cursor reaches `pendingTarget` or an attempt budget
 * is hit. A target above the safe head simply keeps the loop scanning (cheaply,
 * empty range) until the block finalizes. On scan failure the alarm retries
 * (bounded), and `scanRunning` is always cleared in `finally`.
 */

import { resolveEnv, getChainConfigs, type WorkerEnv } from './env';
import {
  runChainIndexerForChain,
  sweepUnpublishedListings,
} from './chainIndexer';

/** Max alarm iterations per single-flight session before deferring the rest to
 *  the cron backstop (bounds subrequest/wall cost; a deep backlog finalizes
 *  cron-paced). */
const MAX_ALARM_ATTEMPTS = 12;
/** Delay between catch-up iterations — cheap wait while a target finalizes. */
const ALARM_DELAY_MS = 3_000;

interface ChainIngestState {
  storage: DurableObjectStorage;
  getWebSockets?: () => WebSocket[];
}

interface TriggerBody {
  chainId?: number;
  targetBlock?: string; // bigint as decimal string
}

export class ChainIngestDO {
  /**
   * `true` only while THIS instance's `alarm()` is actively scanning. This is
   * NOT the overlap guard — the runtime already serializes `alarm()` (see the
   * file header). It only lets a fresh `fetch()` trigger decide whether to reset
   * the catch-up `attempts` budget: skip the reset while a loop is in flight so
   * a trigger can't clobber its counter, but reset for a fresh burst. In-memory
   * on purpose (a fresh instance reads `false`, the correct default); never
   * persisted — persistence is what made the old time-lease unsafe.
   */
  private scanRunning = false;

  constructor(
    private readonly state: ChainIngestState,
    private readonly env: WorkerEnv,
  ) {}

  /**
   * Enqueue-only trigger from the webhook route / cron ping. Durably raises
   * `pendingTarget` and arms the catch-up loop if it isn't already running,
   * then returns a fast ack — the scan happens in `alarm()`. This is what lets
   * the webhook Worker await a durable accept before recording its dedupe row
   * and returning 200 (design §3.3).
   */
  async fetch(req: Request): Promise<Response> {
    let body: TriggerBody = {};
    try {
      body = (await req.json()) as TriggerBody;
    } catch {
      return new Response('bad trigger', { status: 400 });
    }
    if (typeof body.chainId !== 'number') {
      return new Response('missing chainId', { status: 400 });
    }
    const target = (() => {
      try {
        return body.targetBlock ? BigInt(body.targetBlock) : 0n;
      } catch {
        return 0n;
      }
    })();

    const prev = (await this.state.storage.get<string>('pendingTarget')) ?? '0';
    const raised = target > BigInt(prev) ? target : BigInt(prev);
    await this.state.storage.put({
      pendingTarget: raised.toString(),
      chainId: body.chainId,
    });

    // ALWAYS (re)arm the alarm. The Cloudflare runtime never runs `alarm()`
    // concurrently with itself and `setAlarm` holds a single slot, so arming
    // while a scan is live does NOT start a second scan — it queues ONE
    // follow-up that fires after the current `alarm()` returns. Arming
    // unconditionally is what makes a trigger SAFE in the shutdown tail window
    // (Codex #764 round 4): a delivery that interleaves after the running
    // `alarm()` already took its final `pendingTarget` read — but before
    // `finally` clears `scanRunning` — still leaves a pending alarm behind, so
    // the raised target is serviced promptly instead of waiting for the next
    // cron ping. `attempts` is reset only when no scan is live, so a fresh burst
    // gets the full catch-up budget without an in-flight loop clobbering its own
    // counter.
    if (!this.scanRunning) {
      await this.state.storage.put({ attempts: 0 });
    }
    await this.state.storage.setAlarm(Date.now());
    return new Response('queued', { status: 202 });
  }

  /** One catch-up iteration: scan once, then re-arm or finish. */
  async alarm(): Promise<void> {
    // Synchronously (before any await) mark a scan live, so any concurrent
    // `fetch()` trigger sees `scanRunning` and won't arm a second scan. Cleared
    // in `finally` no matter how we exit, so the DO can never wedge "running".
    this.scanRunning = true;
    try {
      // Honor the rollout gate INSIDE the alarm (Codex #764 round 5). If an
      // operator turns `CHAIN_INGEST_VIA_DO` off after it was on, `scheduled()`
      // immediately reverts to the legacy inline scan — but alarms already
      // armed in this DO would keep scanning, and the legacy cron + a DO alarm
      // writing the same chain is exactly the two-writer state the flag exists
      // to prevent. So bail (and stop re-arming) until it's re-enabled. We gate
      // on the var only: being INSIDE the DO already implies the namespace
      // binding exists, so the `CHAIN_INGEST_DO` half of `doIngestEnabled` is
      // moot here.
      if (this.env.CHAIN_INGEST_VIA_DO !== 'true') {
        await this.clearLoopState();
        return;
      }
      const chainId = await this.state.storage.get<number>('chainId');
      if (typeof chainId !== 'number') {
        await this.clearLoopState();
        return;
      }
      const attempts = (await this.state.storage.get<number>('attempts')) ?? 0;

      let scannedTo: bigint | null = null;
      let retryableFailure = false;
      // Hoisted so the caught-up branch below can run the #765 per-chain sweep
      // with the already-resolved env (no second `resolveEnv`).
      let resolved: Awaited<ReturnType<typeof resolveEnv>> | null = null;
      try {
        resolved = await resolveEnv(this.env);
        const chain = getChainConfigs(resolved).find((c) => c.id === chainId);
        if (!chain) {
          // Chain not configured here (no RPC / no deployment) — nothing to do.
          await this.clearLoopState();
          return;
        }
        const result = await runChainIndexerForChain(resolved, chain);
        scannedTo = result.scannedTo;
        // A soft RPC/log-fetch failure returns `skipped: 'rpc-error'` with
        // `scannedTo` rewound to the previous cursor instead of throwing
        // (Codex #764 round 5). Treat it as retryable so the caught-up check
        // below doesn't mistake a failed pass (whose `scannedTo` is usually
        // `>= target`, e.g. target 0 for a block-less webhook) for success and
        // drop the already-acked webhook's only retry until the next cron tick.
        retryableFailure = result.skipped === 'rpc-error';
        // Phase B hook — broadcast an invalidation to subscribed clients after
        // the D1 write. No-op stub until Phase B wires the WebSocket fan-out.
        this.broadcast(chainId, result);
      } catch (err) {
        // Retry (bounded) on failure; the event re-processes next iteration /
        // next cron tick (handlers are re-scan-idempotent, #760).
        // eslint-disable-next-line no-console
        console.error(`[chainIngestDO] scan failed for chain ${chainId}`, err);
        await this.rearmOrFinish(attempts);
        return;
      }

      // Re-read the target AFTER the awaited scan — a trigger may have raised it.
      const target = BigInt(
        (await this.state.storage.get<string>('pendingTarget')) ?? '0',
      );
      if (!retryableFailure && scannedTo !== null && scannedTo >= target) {
        // #765 — run this chain's OpenSea republish sweep HERE, on the caught-up
        // path: serialized AFTER the scan's `prepay_listings` writes (so it sees
        // the just-written rows and never races a concurrent scan writer), and
        // only once per catch-up (≈ once per cron cadence per chain) rather than
        // on every backlog iteration. Best-effort: isolated catch so a sweep
        // failure can't disrupt the cursor / loop completion.
        if (resolved) {
          await sweepUnpublishedListings(resolved, chainId).catch((err) => {
            // eslint-disable-next-line no-console
            console.error(
              `[chainIngestDO] sweep failed for chain ${chainId}`,
              err,
            );
          });
        }
        await this.clearLoopState(); // genuinely caught up
      } else {
        await this.rearmOrFinish(attempts); // more work, or retry a soft failure
      }
    } finally {
      this.scanRunning = false;
    }
  }

  private async rearmOrFinish(attempts: number): Promise<void> {
    if (attempts + 1 < MAX_ALARM_ATTEMPTS) {
      await this.state.storage.put({ attempts: attempts + 1 });
      await this.state.storage.setAlarm(Date.now() + ALARM_DELAY_MS);
    } else {
      // Budget exhausted — defer the rest to the cron backstop.
      await this.clearLoopState();
    }
  }

  private async clearLoopState(): Promise<void> {
    await this.state.storage.delete('attempts');
  }

  /** Phase B placeholder — broadcast a lightweight invalidation key to the DO's
   *  Hibernating WebSocket clients. Intentionally a no-op in Phase A. */
  private broadcast(_chainId: number, _result: unknown): void {
    // Phase B: derive the invalidation key(s) from `_result` and
    // `this.state.getWebSockets()?.forEach(ws => ws.send(...))`.
  }
}
