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
 * single-writer guarantee is the `scanning` flag + coalesced `pendingTarget`,
 * both persisted in DO STORAGE (so they survive hibernation and an alarm that
 * fires after a memory reset).
 *
 * Catch-up loop (alarm-driven, Hibernation-friendly): each `alarm()` runs ONE
 * `runChainIndexerForChain` (one cursor-derived, safe-head-bounded scan) and
 * re-arms itself until the cursor reaches `pendingTarget` or an attempt budget
 * is hit. A target above the safe head simply keeps the loop scanning (cheaply,
 * empty range) until the block finalizes. On scan failure the alarm retries
 * (bounded), and the `scanning` flag is always cleared in a `finally`-style
 * path so the DO can never wedge "scanning" forever.
 */

import { resolveEnv, getChainConfigs, type WorkerEnv } from './env';
import { runChainIndexerForChain } from './chainIndexer';

/** Max alarm iterations per single-flight session before deferring the rest to
 *  the cron backstop (bounds subrequest/wall cost; a deep backlog finalizes
 *  cron-paced). */
const MAX_ALARM_ATTEMPTS = 12;
/** Delay between catch-up iterations — cheap wait while a target finalizes. */
const ALARM_DELAY_MS = 3_000;
/** Single-flight lease: an `alarm()` renews `leaseUntil = now + this` at its
 *  start, so a trigger arriving while a scan is live sees a valid lease and
 *  does NOT re-arm (which would spawn a concurrent scan). Must exceed one
 *  scan's duration + the inter-iteration delay; a chain whose alarm dies is
 *  resumed by the next trigger once the lease lapses. */
const SCAN_LEASE_MS = 90_000;

interface ChainIngestState {
  storage: DurableObjectStorage;
  getWebSockets?: () => WebSocket[];
}

interface TriggerBody {
  chainId?: number;
  targetBlock?: string; // bigint as decimal string
}

export class ChainIngestDO {
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

    const now = Date.now();
    const scanning = (await this.state.storage.get<boolean>('scanning')) === true;
    const leaseUntil =
      (await this.state.storage.get<number>('leaseUntil')) ?? 0;
    // (Re)start the catch-up loop when it isn't running, OR when a prior run's
    // LEASE has expired (its alarm chain died) — but NOT while a run is live
    // (lease still valid), which would start a second concurrent scan and break
    // the single-writer invariant. We must NOT use `getAlarm()` here: Cloudflare
    // returns null WHILE an alarm handler is executing, so a trigger arriving
    // mid-scan would look "dead" and spuriously re-arm. The lease (renewed at
    // the start of every `alarm()`) is the correct liveness signal.
    if (!scanning || now > leaseUntil) {
      await this.state.storage.put({
        scanning: true,
        attempts: 0,
        leaseUntil: now + SCAN_LEASE_MS,
      });
      await this.state.storage.setAlarm(now);
    }
    return new Response('queued', { status: 202 });
  }

  /** One catch-up iteration: scan once, then re-arm or finish. */
  async alarm(): Promise<void> {
    // Renew the single-flight lease so a concurrent trigger (which sees
    // `getAlarm() === null` while we run) does NOT treat this live scan as dead
    // and start a second one.
    await this.state.storage.put({ leaseUntil: Date.now() + SCAN_LEASE_MS });
    const chainId = await this.state.storage.get<number>('chainId');
    if (typeof chainId !== 'number') {
      await this.clearScanning();
      return;
    }
    const attempts = (await this.state.storage.get<number>('attempts')) ?? 0;

    let scannedTo: bigint | null = null;
    try {
      const resolved = await resolveEnv(this.env);
      const chain = getChainConfigs(resolved).find((c) => c.id === chainId);
      if (!chain) {
        // Chain not configured here (no RPC / no deployment) — nothing to do.
        await this.clearScanning();
        return;
      }
      const result = await runChainIndexerForChain(resolved, chain);
      scannedTo = result.scannedTo;
      // Phase B hook — broadcast an invalidation to subscribed clients after
      // the D1 write. No-op stub until Phase B wires the WebSocket fan-out.
      this.broadcast(chainId, result);
    } catch (err) {
      // §9 P1 — never leave `scanning` stuck. Retry (bounded) on failure; the
      // event re-processes next iteration / next cron tick (handlers are
      // re-scan-idempotent, #760).
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
      await this.clearScanning(); // caught up
    } else {
      await this.rearmOrFinish(attempts);
    }
  }

  private async rearmOrFinish(attempts: number): Promise<void> {
    if (attempts + 1 < MAX_ALARM_ATTEMPTS) {
      await this.state.storage.put({ attempts: attempts + 1 });
      await this.state.storage.setAlarm(Date.now() + ALARM_DELAY_MS);
    } else {
      // Budget exhausted — defer the rest to the cron backstop.
      await this.clearScanning();
    }
  }

  private async clearScanning(): Promise<void> {
    await this.state.storage.delete(['scanning', 'attempts', 'leaseUntil']);
  }

  /** Phase B placeholder — broadcast a lightweight invalidation key to the DO's
   *  Hibernating WebSocket clients. Intentionally a no-op in Phase A. */
  private broadcast(_chainId: number, _result: unknown): void {
    // Phase B: derive the invalidation key(s) from `_result` and
    // `this.state.getWebSockets()?.forEach(ws => ws.send(...))`.
  }
}
