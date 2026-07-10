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
  type ChainIndexerResult,
} from './chainIndexer';

/** Max alarm iterations per single-flight session before deferring the rest to
 *  the cron backstop (bounds subrequest/wall cost; a deep backlog finalizes
 *  cron-paced). */
const MAX_ALARM_ATTEMPTS = 12;
/** Delay between catch-up iterations — cheap wait while a target finalizes. */
const ALARM_DELAY_MS = 3_000;

interface TriggerBody {
  chainId?: number;
  targetBlock?: string; // bigint as decimal string
}

/**
 * #757 Phase B — the typed invalidation keys the DO pushes to subscribed dapp
 * clients after each D1 write. Each key names a coarse data slice that changed;
 * the client maps it to a refetch (it carries the SIGNAL, never authoritative
 * data — the client re-reads via the existing REST/RPC surface, so the trust
 * model is unchanged). Derived from the scan's `ChainIndexerResult` counts.
 */
export type InvalidationKey =
  | 'offer.created'
  | 'offer.changed' // cancel / accept / detail refresh (coarse — no per-id yet)
  | 'loan.created'
  | 'loan.updated' // repay / default / liquidation / transfer
  | 'activity.appended';

/** Push frame the DO `ws.send`s. `t` discriminates the frame kind. */
type PushFrame =
  | { t: 'hello'; chainId: number | null; ingestActive: boolean }
  | { t: 'invalidate'; chainId: number; keys: InvalidationKey[]; scannedTo: string };

/** Map a completed scan's result counts → the coarse invalidation keys to push.
 *  Pure + exported so the shape is unit-reasoned and testable in isolation. */
export function invalidationKeysFromResult(
  result: ChainIndexerResult,
): InvalidationKey[] {
  const keys: InvalidationKey[] = [];
  if (result.newOffers > 0) keys.push('offer.created');
  // `signedOfferUpdates` rides the coarse offer.changed key (Codex #1145
  // r8 P3): a signed-book lifecycle flip (fill / cancel / nonce burn) is
  // an offer change in this signal's coarse sense, and the desk consumes
  // the signed book + the signed-aware /offers/markets — without it a
  // scan containing ONLY signed lifecycle events would broadcast nothing
  // and WS clients would show cancelled signed rows until the poll.
  if (
    result.statusUpdates > 0 ||
    result.detailRefreshes > 0 ||
    (result.signedOfferUpdates ?? 0) > 0
  ) {
    keys.push('offer.changed');
  }
  if (result.newLoans > 0) keys.push('loan.created');
  // `loanStatusUpdates` = a status transition; `loanDetailRefreshes` = a stub
  // row healed to canonical metadata (P3 — a heal-only pass would otherwise
  // push nothing, leaving clients on incomplete loan data until a slow poll).
  if (result.loanStatusUpdates > 0 || result.loanDetailRefreshes > 0) {
    keys.push('loan.updated');
  }
  if (result.activityEvents > 0) keys.push('activity.appended');
  return keys;
}

/** Coarse "refetch everything" set used to recover a push that was lost when a
 *  prior post-write scan threw (its counts never reached `broadcast()`). The
 *  client's nudge is global, so this just guarantees a refetch. */
const RECOVERY_KEYS: InvalidationKey[] = [
  'offer.changed',
  'loan.updated',
  'activity.appended',
];

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
    private readonly state: DurableObjectState,
    private readonly env: WorkerEnv,
  ) {
    // #757 Phase B — keep idle subscribers cheap. The runtime answers a
    // client `ping` with `pong` WITHOUT waking the Hibernating DO, so a
    // browser keepalive never costs a wall-clock charge. Idempotent; safe to
    // set on every (re)instantiation.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );
  }

  /**
   * Two roles on one object (design §3.2):
   *   - `Upgrade: websocket` → #757 Phase B subscribe: accept a Hibernatable
   *     browser socket so `broadcast()` can push invalidation keys to it.
   *   - otherwise → the enqueue-only TRIGGER from the webhook route / cron ping:
   *     durably raise `pendingTarget`, arm the catch-up loop if idle, and return
   *     a fast ack — the scan happens in `alarm()`. This is what lets the webhook
   *     Worker await a durable accept before recording its dedupe row and
   *     returning 200 (design §3.3).
   */
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') === 'websocket') {
      return await this.handleWebSocketUpgrade(req);
    }

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
        // A soft RPC/log-fetch failure returns `skipped: 'rpc-error'` with
        // `scannedTo` rewound to the previous cursor instead of throwing
        // (Codex #764 round 5). Treat it as retryable so the caught-up check
        // below doesn't mistake a failed pass (whose `scannedTo` is usually
        // `>= target`, e.g. target 0 for a block-less webhook) for success and
        // drop the already-acked webhook's only retry until the next cron tick.
        retryableFailure = result.skipped === 'rpc-error';
        // #757 Phase B — broadcast the coarse invalidation keys to subscribed
        // clients AFTER the D1 write, so a connected dapp refetches the changed
        // slice within seconds instead of waiting for its next poll. If a PRIOR
        // attempt wrote D1 then threw before returning (P3), its counts were
        // lost and this idempotent retry yields zero — so a pending flag forces
        // a recovery broadcast even when this pass's counts are empty.
        const pendingBroadcast =
          (await this.state.storage.get<boolean>('pendingBroadcast')) ?? false;
        this.broadcast(chainId, result, pendingBroadcast);
        if (pendingBroadcast) {
          await this.state.storage.delete('pendingBroadcast');
        }
      } catch (err) {
        // Retry (bounded) on failure; the event re-processes next iteration /
        // next cron tick (handlers are re-scan-idempotent, #760). A throw may
        // have landed AFTER some D1 writes (e.g. the final cursor advance), so
        // mark a pending broadcast: the next successful pass will emit a
        // recovery invalidation even though its idempotent re-scan counts zero.
        await this.state.storage.put({ pendingBroadcast: true });
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

  /**
   * #757 Phase B — accept a browser WebSocket as a Hibernatable subscriber.
   * `acceptWebSocket` hands the socket to the runtime, so an idle subscriber
   * costs nothing (the DO can evict from memory and is re-instantiated on the
   * next event); `getWebSockets()` re-materialises them in `broadcast()`. We
   * immediately send a `hello` frame so the client can distinguish a LIVE push
   * channel (DO ingest enabled) from a connected-but-silent one (ingest off →
   * the client keeps polling and shows "Polling", never a false "Live").
   */
  private async handleWebSocketUpgrade(req: Request): Promise<Response> {
    const chainParam = Number(new URL(req.url).searchParams.get('chain'));
    const chainId =
      Number.isInteger(chainParam) && chainParam > 0 ? chainParam : null;

    // `ingestActive` must reflect whether THIS chain will actually be scanned +
    // broadcast, not just the global rollout flag (Codex P2). The public route
    // forwards any numeric chain id, but cron/webhook only scan chains in
    // `getChainConfigs` (RPC secret + deployment both present). A chain missing
    // either — local Anvil (31337), an app chain without an indexer RPC — would
    // otherwise show a permanent false "Live"; report `false` so the client
    // stays on honest polling. Mirrors the same gate the alarm uses.
    let ingestActive = false;
    if (this.env.CHAIN_INGEST_VIA_DO === 'true' && chainId !== null) {
      try {
        const resolved = await resolveEnv(this.env);
        ingestActive = getChainConfigs(resolved).some((c) => c.id === chainId);
      } catch {
        ingestActive = false; // env resolution failed → honest polling
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);

    const hello: PushFrame = {
      t: 'hello',
      chainId,
      ingestActive,
    };
    try {
      server.send(JSON.stringify(hello));
    } catch {
      // A socket that dies between accept and the first send is reaped by the
      // runtime; nothing to clean up here.
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * #757 Phase B — after a scan's D1 write, push the coarse invalidation keys to
   * every subscribed client for this chain. Carries the SIGNAL only (which slice
   * changed + the scanned-through block), never the data, so the client refetches
   * via the existing REST/RPC surface and the trust model is unchanged. A scan
   * that changed nothing pushes nothing (no wake, no traffic). Per-socket `send`
   * is wrapped so one dead socket can't abort the fan-out.
   */
  private broadcast(
    chainId: number,
    result: ChainIndexerResult,
    recoverPending = false,
  ): void {
    let keys = invalidationKeysFromResult(result);
    if (keys.length === 0) {
      // Nothing changed THIS pass. Only push if a prior post-write failure left
      // a pending recovery — then fan out the coarse "refetch everything" set.
      if (!recoverPending) return;
      keys = RECOVERY_KEYS;
    }
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) return;
    const frame: PushFrame = {
      t: 'invalidate',
      chainId,
      keys,
      scannedTo: result.scannedTo.toString(),
    };
    const payload = JSON.stringify(frame);
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        // Dead/closing socket — the runtime reaps it; skip and keep fanning out.
      }
    }
  }

  /**
   * Hibernation message handler. The push channel is server→client only; the
   * sole expected inbound is a `ping` keepalive, which `setWebSocketAutoResponse`
   * already answers without waking us. Anything else is ignored (defensive —
   * a client must not be able to drive DO work over the subscribe socket).
   */
  async webSocketMessage(_ws: WebSocket, _message: ArrayBuffer | string): Promise<void> {
    // No-op: subscribers never command the DO. Auto-response handles `ping`.
  }

  /** Hibernation close handler — acknowledge the close so the socket is freed. */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    try {
      // 1000–4999 are the app-closable range; 1006 (abnormal) must not be
      // echoed back as a close code or the runtime throws.
      ws.close(code >= 1000 && code < 5000 ? code : 1000);
    } catch {
      // Already closing — nothing to do.
    }
  }

  /** Hibernation error handler — log and let the runtime drop the socket. */
  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    // eslint-disable-next-line no-console
    console.error('[chainIngestDO] websocket error', error);
  }
}
