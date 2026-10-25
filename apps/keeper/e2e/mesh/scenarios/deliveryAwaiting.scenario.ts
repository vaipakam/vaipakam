/**
 * #2516 / #2775 — a delivery that stays NOT WHOLE two scans after the keeper
 * FOUND it raises the delivery-proof pass's `delivery-awaiting` operator
 * alert, and the alert clears once the keeper makes the delivery whole. Two
 * chains, the same real cycle as `deliveryProof.scenario.ts` up to the
 * delivery landing on the mirror.
 *
 * WHAT HOLDS THE DELIVERY BACK, stated plainly: the keeper is run with no RPC
 * binding for Base (`RPC_BASE_SEPOLIA` unset), so it cannot rebuild the
 * delivery's rooted day list from Base's reservation and can index nothing —
 * a real misconfiguration the pass names in its log ("cannot rebuild its
 * list"), not a doctored chain. The mirror, its packet and its epoch are
 * exactly what the relayed remittance left. The alert threshold is the
 * pass's own (`AWAITING_ALERT_SEC`, counted from when the pass queued the
 * delivery).
 *
 * WHAT MAKES IT LATE TO BE FOUND: the scenario's indexer runs only when the
 * scenario asks, so the delivery reaches the keeper's ledger well after it
 * arrived — the shape Arbitrum's `safe` head gave the first live deliveries
 * (#2775), where the old arrival clock had spent most of the allowance before
 * the keeper could see them.
 *
 * The keeper's ops bot is configured, pointed at a stand-in for the Telegram
 * API (`opsBotSink`), because only a configured bot RECORDS an alert — and
 * only a recorded alert can be seen clearing. No request leaves the machine.
 *
 * What it proves, in order:
 *   1. A delivery found long after it arrived raises nothing on the scan that
 *      found it.
 *   2. Nor on the next full scan.
 *   3. On the scan after that it raises `delivery-awaiting:<mirror>:all`,
 *      posted once, naming the packet, and recorded in the keeper's database;
 *      the keeper sent nothing.
 *   4. With Base's binding restored, the next run indexes the delivery (the
 *      chain shows it whole, every transaction the keeper's) and the alert's
 *      record is gone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../src/env';
import { AWAITING_ALERT_SEC, PASS_CADENCE_SEC, runDeliveryProof } from '../../../src/deliveryProof';
import { keeperEnvFor, tickNow, type KeeperHarness } from '../../harness/keeperEnv';
import { opsBotSink, type OpsBotSink } from '../../harness/opsAlerts';
import { openMeshScenario, type MeshScenario } from '../mesh';
import { batchProgress, FIVE_MIN_MS, ingressPacket, remitOneDayToMirror, transactionsSince, type RemittedDelivery } from '../rewardCycle';
import { MIRROR_ID } from '../fixture';

const ZERO32 = `0x${'0'.repeat(64)}`;
const AWAITING_KEY = `delivery-awaiting:${MIRROR_ID}:all`;

let m: MeshScenario;
let k: KeeperHarness;
let sink: OpsBotSink;
let d: RemittedDelivery;
/** The keeper's env with the ops bot configured. */
let env: Env;
/** The same env with no RPC binding for Base. */
let envWithoutBase: Env;
/** The keeper's warnings, as it logged them. */
const warnings: string[] = [];

beforeAll(async () => {
  m = await openMeshScenario();
  k = await keeperEnvFor([m.base, m.mirror], ['REWARD_DAY_CLOSE_ENABLED', 'REWARD_REMIT_ENABLED', 'REWARD_DELIVERY_PROOF_ENABLED'], { indexer: true });
  sink = opsBotSink();
  env = { ...k.env, ...sink.env } as Env;
  envWithoutBase = { ...env, RPC_BASE_SEPOLIA: undefined } as Env;
  const original = console.warn.bind(console);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
    original(...args);
  });
});

/** Whether the pass said, for this packet, why it could not work it. */
function saidCannotRebuild(packetHash: string): boolean {
  return warnings.some((w) => w.toLowerCase().includes(packetHash.toLowerCase()) && w.includes('cannot rebuild its list'));
}

afterAll(async () => {
  await m?.stop();
});

function recordedAlerts(): string[] {
  return (k.keeperDb.db.prepare('SELECT alert_key FROM keeper_ops_alert').all() as { alert_key: string }[]).map((r) => r.alert_key);
}

async function keeperNonce(): Promise<number> {
  return m.mirror.pub.getTransactionCount({ address: m.mirror.address('keeper') });
}

describe('deliveryProof awaiting alert across a Base/mirror pair on Anvil', () => {
  /** One scheduled scan: the indexer catches up, the clock is synced, and the
   *  pass runs without Base. Returns the chain time it ran at. */
  async function scanWithoutBase(): Promise<number> {
    await k.indexer!.index();
    const now = await m.syncClock();
    warnings.length = 0;
    const nonce = await keeperNonce();
    await runDeliveryProof(envWithoutBase, tickNow(FIVE_MIN_MS));
    expect(saidCannotRebuild(d.packetHash)).toBe(true);
    expect(await keeperNonce(), 'the keeper sent nothing').toBe(nonce);
    return now;
  }

  it('raises nothing on the scan that finds a delivery long after it arrived', async () => {
    d = await remitOneDayToMirror(m, { ...k, env });
    const p = await ingressPacket(m.mirror, d.packetHash);
    expect(p.batchId).not.toBe(ZERO32);
    // This scenario's hold-back needs a rooted list (rebuilt from Base).
    expect(p.dayListRoot).not.toBe(ZERO32);

    // Unindexed for longer than the whole allowance, then found.
    await m.warp(2 * AWAITING_ALERT_SEC);
    const now = await scanWithoutBase();
    expect(now - Number(p.arrivedAt)).toBeGreaterThan(AWAITING_ALERT_SEC);
    expect(sink.posts).toEqual([]);
    expect(recordedAlerts()).toEqual([]);
    const progress = await batchProgress(m.mirror, d.batchId);
    expect(progress.indexedDays).toBeLessThan(progress.dayCount);
  });

  it('raises nothing on the full scan after the one that found it', async () => {
    await m.warp(PASS_CADENCE_SEC);
    await scanWithoutBase();
    expect(sink.posts).toEqual([]);
    expect(recordedAlerts()).toEqual([]);
  });

  it('raises delivery-awaiting once two scans after finding it have left it not whole', async () => {
    await m.warp(PASS_CADENCE_SEC);
    await scanWithoutBase();
    expect(sink.posts).toHaveLength(1);
    expect(sink.posts[0]).toContain(`not yet whole two scans after this keeper found it (more than ${AWAITING_ALERT_SEC / 60} min`);
    expect(sink.posts[0].toLowerCase()).toContain(d.packetHash.toLowerCase());
    expect(recordedAlerts()).toEqual([AWAITING_KEY]);
  });

  it('clears the alert once the keeper, with Base reachable again, makes the delivery whole', async () => {
    sink.clear();
    await m.warp(5 * 60);
    await k.indexer!.index();
    await m.syncClock();
    const from = await m.mirror.blockNumber();
    await runDeliveryProof(env, tickNow(FIVE_MIN_MS));

    const p = await ingressPacket(m.mirror, d.packetHash);
    const progress = await batchProgress(m.mirror, d.batchId);
    expect(progress.indexedDays).toBe(progress.dayCount);
    const all = (1n << BigInt(p.chunkCount)) - 1n;
    expect(BigInt(p.chunksIndexed) & all).toBe(all);
    const txs = await transactionsSince(m.mirror, from);
    expect(txs.length).toBeGreaterThan(0);
    for (const t of txs) {
      expect(t.from.toLowerCase()).toBe(m.mirror.address('keeper').toLowerCase());
      expect(t.to?.toLowerCase()).toBe(m.mirror.diamond.toLowerCase());
    }
    // Cleared, not re-posted.
    expect(recordedAlerts()).toEqual([]);
    expect(sink.posts).toEqual([]);
  });
});
