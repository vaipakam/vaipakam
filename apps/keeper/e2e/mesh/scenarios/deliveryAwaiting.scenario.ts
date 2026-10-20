/**
 * #2516 — a delivery that stays NOT WHOLE past ten minutes raises the
 * delivery-proof pass's `delivery-awaiting` operator alert, and the alert
 * clears once the keeper makes the delivery whole. Two chains, the same real
 * cycle as `deliveryProof.scenario.ts` up to the delivery landing on the
 * mirror.
 *
 * WHAT HOLDS THE DELIVERY BACK, stated plainly: the keeper is run with no RPC
 * binding for Base (`RPC_BASE_SEPOLIA` unset), so it cannot rebuild the
 * delivery's rooted day list from Base's reservation and can index nothing —
 * a real misconfiguration the pass names in its log ("cannot rebuild its
 * list"), not a doctored chain. The mirror, its packet and its epoch are
 * exactly what the relayed remittance left. The alert threshold is the
 * pass's own (`AWAITING_ALERT_SEC`, ten minutes after the packet arrived).
 *
 * The keeper's ops bot is configured, pointed at a stand-in for the Telegram
 * API (`opsBotSink`), because only a configured bot RECORDS an alert — and
 * only a recorded alert can be seen clearing. No request leaves the machine.
 *
 * What it proves, in order:
 *   1. Within ten minutes of arrival the stuck delivery raises nothing.
 *   2. Past ten minutes it raises `delivery-awaiting:<mirror>:all`, posted
 *      once, naming the packet, and recorded in the keeper's database; the
 *      keeper sent nothing.
 *   3. With Base's binding restored, the next run indexes the delivery (the
 *      chain shows it whole, every transaction the keeper's) and the alert's
 *      record is gone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../src/env';
import { AWAITING_ALERT_SEC, runDeliveryProof } from '../../../src/deliveryProof';
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
  k = await keeperEnvFor([m.base, m.mirror], ['REWARD_REMIT_ENABLED', 'REWARD_DELIVERY_PROOF_ENABLED'], { indexer: true });
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
  it('raises nothing while the stuck delivery is within ten minutes of arriving', async () => {
    d = await remitOneDayToMirror(m, { ...k, env });
    const p = await ingressPacket(m.mirror, d.packetHash);
    expect(p.batchId).not.toBe(ZERO32);
    // This scenario's hold-back needs a rooted list (rebuilt from Base).
    expect(p.dayListRoot).not.toBe(ZERO32);

    await m.warp(60);
    await k.indexer!.index();
    const now = await m.syncClock();
    expect(now - Number(p.arrivedAt)).toBeLessThanOrEqual(AWAITING_ALERT_SEC);
    const nonce = await keeperNonce();
    await runDeliveryProof(envWithoutBase, tickNow(FIVE_MIN_MS));
    expect(saidCannotRebuild(d.packetHash)).toBe(true);
    expect(await keeperNonce()).toBe(nonce);
    expect(sink.posts).toEqual([]);
    expect(recordedAlerts()).toEqual([]);
    const progress = await batchProgress(m.mirror, d.batchId);
    expect(progress.indexedDays).toBeLessThan(progress.dayCount);
  });

  it('raises delivery-awaiting once the delivery is still not whole past ten minutes', async () => {
    const p = await ingressPacket(m.mirror, d.packetHash);
    await m.warp(AWAITING_ALERT_SEC + 60);
    await k.indexer!.index();
    const now = await m.syncClock();
    expect(now - Number(p.arrivedAt)).toBeGreaterThan(AWAITING_ALERT_SEC);
    const nonce = await keeperNonce();
    warnings.length = 0;
    await runDeliveryProof(envWithoutBase, tickNow(FIVE_MIN_MS));
    expect(saidCannotRebuild(d.packetHash)).toBe(true);
    expect(await keeperNonce()).toBe(nonce);
    expect(sink.posts).toHaveLength(1);
    expect(sink.posts[0]).toContain('not yet whole more than 10 min after arriving');
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
