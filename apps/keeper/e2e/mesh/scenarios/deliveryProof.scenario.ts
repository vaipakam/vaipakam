/**
 * #2516 — the keeper's delivery-proof pass, end to end across TWO chains.
 *
 * A canonical chain (presenting Base Sepolia) and a mirror (presenting
 * Sepolia), each the repository's current contracts deployed from source and
 * wired by the operator scripts themselves, joined by a local CCIP lane: the
 * real router, RMN, token admin registry and VPFI pools on each side, and a
 * relay that delivers only what a source on-ramp emitted (`mesh/fixture.ts`,
 * `@vaipakam/anvil-harness/ccipLane`). What it proves, in order:
 *
 *   1. The real cycle runs: the mirror closes its days and its reports land
 *      on Base; Base finalizes them; the KEEPER's own remit pass funds the
 *      mirror (`remitRewardBudget`, the only transaction of that pass, signed
 *      by the keeper); the relayed remittance mints the remitted VPFI on the
 *      mirror and the mirror's ingress records the packet in a transport
 *      epoch whose days are not yet indexed.
 *   2. The indexer runs on both chains (`runChainIndexerForChain`, writing the
 *      one shared database), and then the keeper's real `runDeliveryProof`:
 *      it discovers the delivery from the indexer's rows, rebuilds its rooted
 *      day list from Base's reservation, and indexes it — after which the
 *      chain itself shows the delivery WHOLE (every chunk landed, the epoch's
 *      index complete).
 *   3. Every transaction the pass sent is the keeper's own, to the mirror
 *      Diamond, and the pass raised no operator alert.
 *   4. A second run finds nothing to do: it sends nothing, and the delivery
 *      has left the keeper's open-work queue.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDeliveryProof } from '../../../src/deliveryProof';
import { keeperEnvFor, tickNow, type KeeperHarness } from '../../harness/keeperEnv';
import { collectOpsAlerts, type OpsAlertLog } from '../../harness/opsAlerts';
import { openMeshScenario, type MeshScenario } from '../mesh';
import { batchProgress, FIVE_MIN_MS, ingressPacket, remitOneDayToMirror, transactionsSince, type RemittedDelivery } from '../rewardCycle';
import { BASE_ID } from '../fixture';

const ZERO32 = `0x${'0'.repeat(64)}`;

let m: MeshScenario;
let k: KeeperHarness;
let alerts: OpsAlertLog;
let d: RemittedDelivery;

beforeAll(async () => {
  m = await openMeshScenario();
  k = await keeperEnvFor([m.base, m.mirror], ['REWARD_REMIT_ENABLED', 'REWARD_DELIVERY_PROOF_ENABLED'], { indexer: true });
  alerts = collectOpsAlerts();
});

afterAll(async () => {
  await m?.stop();
});

function openWork(): number {
  const row = k.keeperDb.db
    .prepare(`SELECT COUNT(*) AS n FROM keeper_work_open WHERE chain_id = ? AND kind = 'delivery_proof'`)
    .get(m.mirror.chain.id) as { n: number };
  return Number(row.n);
}

function recordedAlerts(): string[] {
  return (k.keeperDb.db.prepare('SELECT alert_key FROM keeper_ops_alert').all() as { alert_key: string }[]).map((r) => r.alert_key);
}

describe('deliveryProof across a Base/mirror pair on Anvil', () => {
  it('runs the real cycle: mirror reports, Base finalizes, the keeper remits, the lane delivers', async () => {
    d = await remitOneDayToMirror(m, k);

    // The remit pass sent exactly one transaction, the keeper's own.
    const keeper = m.base.address('keeper').toLowerCase();
    expect(d.remitTxs.map((t) => t.from.toLowerCase())).toEqual([keeper]);
    expect(d.remitTxs[0].hash).toBe(d.remitted.tx);
    expect(d.remitTxs[0].to?.toLowerCase()).toBe(m.base.diamond.toLowerCase());

    // Base's pool locked the remitted amount; the lane carried it as one
    // token leg; the mirror pool minted exactly that (the mirror token's
    // whole supply), and it rests in the mirror's reward custody.
    expect(d.baseLocked).toBe(d.remitted.amount);
    expect(d.relayed.tokenAmounts.map((t) => t.amount)).toEqual([d.remitted.amount]);
    expect(d.mirrorVpfiTotalSupply).toBe(d.remitted.amount);
    expect(d.mirrorVpfiReceived).toEqual({ diamond: 0n, custodyHolder: d.remitted.amount });

    // The ingress recorded the packet, from Base, in an epoch not yet indexed.
    const p = await ingressPacket(m.mirror, d.packetHash);
    expect(Number(p.sourceChainId)).toBe(BASE_ID);
    expect(BigInt(p.remitId)).toBe(d.remitted.remitId);
    expect(p.batchId).not.toBe(ZERO32);
    expect(p.batchId).toBe(d.batchId);
    const before = await batchProgress(m.mirror, d.batchId);
    expect(before.dayCount).toBeGreaterThan(0);
    expect(before.indexedDays).toBeLessThan(before.dayCount);
    expect(alerts.texts).toEqual([]);
  });

  it('indexes both chains, then the keeper makes the delivery whole on the mirror', async () => {
    await m.warp(60);
    await k.indexer!.index();
    await m.syncClock();
    const from = await m.mirror.blockNumber();
    await runDeliveryProof(k.env, tickNow(FIVE_MIN_MS));

    // The chain shows the delivery whole.
    const p = await ingressPacket(m.mirror, d.packetHash);
    const progress = await batchProgress(m.mirror, d.batchId);
    expect(progress.indexedDays).toBe(progress.dayCount);
    if (p.dayListRoot !== ZERO32) {
      const all = (1n << BigInt(p.chunkCount)) - 1n;
      expect(BigInt(p.chunksIndexed) & all).toBe(all);
    }

    // Every transaction since the pass started is the keeper's, to the Diamond.
    const txs = await transactionsSince(m.mirror, from);
    expect(txs.length).toBeGreaterThan(0);
    for (const t of txs) {
      expect(t.from.toLowerCase()).toBe(m.mirror.address('keeper').toLowerCase());
      expect(t.to?.toLowerCase()).toBe(m.mirror.diamond.toLowerCase());
    }
    expect(alerts.texts).toEqual([]);
    expect(recordedAlerts()).toEqual([]);
  });

  it('finds nothing left on the next run: no send, and the delivery has left the open-work queue', async () => {
    await m.warp(5 * 60);
    await k.indexer!.index();
    await m.syncClock();
    const nonce = await m.mirror.pub.getTransactionCount({ address: m.mirror.address('keeper') });
    await runDeliveryProof(k.env, tickNow(FIVE_MIN_MS));
    expect(await m.mirror.pub.getTransactionCount({ address: m.mirror.address('keeper') })).toBe(nonce);
    expect(openWork()).toBe(0);
    expect(alerts.texts).toEqual([]);
    expect(recordedAlerts()).toEqual([]);
  });
});
