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
 * IMPORTANT (design §3.1): the DO input gate does NOT keep the object closed
 * across awaited network work, so the input gate alone is not enough. The
 * single-writer guarantee is an IN-MEMORY `scanRunning` flag, set synchronously
 * at the very top of `alarm()` and cleared in its `finally`. Because Cloudflare
 * runs exactly one instance per DO id and JS is single-threaded — a concurrent
 * `fetch()` trigger only interleaves at this instance's `await` points — that
 * boolean is an EXACT "is a scan executing right now" signal, with none of the
 * guesswork of a time-based lease (which could lapse mid-scan and let a trigger
 * spuriously start a second scan — Codex #764 round 3). It also fails SAFE
 * across eviction/crash: a fresh instance reads `false`, so a genuinely dead
 * alarm chain is restarted by the next trigger rather than wedged shut. The
 * coalesced `pendingTarget` (the only cross-hop state a trigger must survive)
 * stays persisted in DO STORAGE.
 *
 * Catch-up loop (alarm-driven, Hibernation-friendly): each `alarm()` runs ONE
 * `runChainIndexerForChain` (one cursor-derived, safe-head-bounded scan) and
 * re-arms itself until the cursor reaches `pendingTarget` or an attempt budget
 * is hit. A target above the safe head simply keeps the loop scanning (cheaply,
 * empty range) until the block finalizes. On scan failure the alarm retries
 * (bounded). A migrated/overlapping instance can't corrupt state either: the
 * event handlers are re-scan-idempotent (block-pinned absolute reads, #760).
 */

import { resolveEnv, getChainConfigs, type WorkerEnv } from './env';
import { runChainIndexerForChain } from './chainIndexer';

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
   * In-memory single-flight guard: `true` only while THIS instance's `alarm()`
   * is actively scanning. A concurrent `fetch()` trigger (same instance, only
   * interleaved at our awaits) reads it synchronously to decide whether to arm
   * a new alarm — so two scans never overlap, and a fresh instance (eviction /
   * crash) reads `false` and correctly restarts a dead chain. NOT persisted on
   * purpose: persistence is exactly what made the old time-lease unsafe.
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

    // Arm the catch-up loop only when no scan is executing in this instance. If
    // one IS running it will re-read `pendingTarget` after its scan and keep
    // going (so we don't start a second). `scanRunning` is the EXACT liveness
    // signal — not `getAlarm()` (returns null mid-alarm) nor a time-lease (can
    // lapse mid-scan). `setAlarm` holds a single slot, so even a flood of
    // triggers during the inter-hop gap collapses to one alarm, never two
    // scans. `attempts` is reset here because a fresh external trigger is fresh
    // demand and deserves the full catch-up budget.
    if (!this.scanRunning) {
      await this.state.storage.put({ attempts: 0 });
      await this.state.storage.setAlarm(Date.now());
    }
    return new Response('queued', { status: 202 });
  }

  /** One catch-up iteration: scan once, then re-arm or finish. */
  async alarm(): Promise<void> {
    // Synchronously (before any await) mark a scan live, so any concurrent
    // `fetch()` trigger sees `scanRunning` and won't arm a second scan. Cleared
    // in `finally` no matter how we exit, so the DO can never wedge "running".
    this.scanRunning = true;
    try {
      const chainId = await this.state.storage.get<number>('chainId');
      if (typeof chainId !== 'number') {
        await this.clearLoopState();
        return;
      }
      const attempts = (await this.state.storage.get<number>('attempts')) ?? 0;

      let scannedTo: bigint | null = null;
      try {
        const resolved = await resolveEnv(this.env);
        const chain = getChainConfigs(resolved).find((c) => c.id === chainId);
        if (!chain) {
          // Chain not configured here (no RPC / no deployment) — nothing to do.
          await this.clearLoopState();
          return;
        }
        const result = await runChainIndexerForChain(resolved, chain);
        scannedTo = result.scannedTo;
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
      if (scannedTo !== null && scannedTo >= target) {
        await this.clearLoopState(); // caught up
      } else {
        await this.rearmOrFinish(attempts);
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
