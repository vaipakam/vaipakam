/**
 * The cross-chain reward-budget cycle, driven the way it runs on a live
 * Base/mirror pair, up to the point where the keeper's delivery-proof pass
 * takes over:
 *
 *   1. a real loan on the MIRROR, so the mirror has interest to report;
 *   2. two reward days elapse on both chains (one shared clock);
 *   3. the mirror closes each day — `closeDay`, permissionless and payable,
 *      which sends the day's report to Base over the lane — and the relay
 *      lands each report on Base;
 *   4. Base closes and finalizes the same days (`finalizeThrough`): both
 *      expected reporters are in, so each finalizes on coverage;
 *   5. the KEEPER's real remit pass (`runRewardBudgetRemit`) funds the mirror
 *      from Base — `remitRewardBudget`, the keeper's own transaction;
 *   6. the relay lands the remittance on the mirror, VPFI and message
 *      together: the Base pool locks it, the mirror pool mints it, and the
 *      mirror's ingress records the packet.
 *
 * Day 0 is never remitted (the remit window starts at day 1), so day 1 is
 * the day whose slice moves.
 */
import type { Address, Hex } from 'viem';
import { runRewardBudgetRemit } from '../../src/rewardBudgetRemit';
import { openLoan } from '../harness/lending';
import { finalizeThrough } from '../harness/rewardDays';
import { tickNow, type KeeperHarness } from '../harness/keeperEnv';
import { TOKEN_ABI, type DecodedEvent } from '../harness/chain';
import type { RelayedMessage } from '@vaipakam/anvil-harness/ccipLane';
import { BASE_ID, LANE_NATIVE_FEE, MIRROR_ID } from './fixture';
import type { MeshChain, MeshScenario } from './mesh';

const DAY = 86_400;
/** The remit pass's cadence (passSchedule): it runs every five minutes. */
export const FIVE_MIN_MS = 5 * 60_000;

/** The mirror's `closeDay` fee: the lane's fixed native fee, with headroom.
 *  The messenger refunds whatever the send did not use. */
const CLOSE_DAY_VALUE = LANE_NATIVE_FEE * 10n;

const SUPPLY_ABI = [
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

export interface RemittedDelivery {
  /** Base's `RewardBudgetRemitted` for the keeper's remit. */
  remitted: { amount: bigint; remitId: bigint; messageId: Hex; tx: Hex };
  /** The relayed remittance, as both ends recorded it. */
  relayed: RelayedMessage;
  /** The mirror's ingress record of it. */
  packetHash: Hex;
  /** The transport epoch the ingress admitted it into (zero hash: none). */
  batchId: Hex;
  /** VPFI Base's lock/release pool took in during the remit pass. */
  baseLocked: bigint;
  /** VPFI the delivery left with the mirror Diamond and with its
   *  reward-custody holder (each the balance change across the delivery). */
  mirrorVpfiReceived: { diamond: bigint; custodyHolder: bigint };
  /** The mirror's reward-custody holder. */
  custodyHolder: Address;
  /** The mirror VPFI's total supply after the delivery (minted only by the pool). */
  mirrorVpfiTotalSupply: bigint;
  /** Every Base transaction of the remit pass (sender, hash). */
  remitTxs: { from: Address; hash: Hex; to: Address | null }[];
}

/** Every transaction mined on `sc` after block `fromBlock`. */
export async function transactionsSince(sc: MeshChain, fromBlock: bigint): Promise<{ from: Address; hash: Hex; to: Address | null }[]> {
  const head = await sc.blockNumber();
  const out: { from: Address; hash: Hex; to: Address | null }[] = [];
  for (let b = fromBlock + 1n; b <= head; b++) {
    // eslint-disable-next-line no-await-in-loop
    const block = await sc.pub.getBlock({ blockNumber: b, includeTransactions: true });
    for (const tx of block.transactions) out.push({ from: tx.from, hash: tx.hash, to: tx.to ?? null });
  }
  return out;
}

function onlyEvent(events: DecodedEvent[], name: string): DecodedEvent {
  const hits = events.filter((e) => e.eventName === name);
  if (hits.length !== 1) throw new Error(`expected exactly one ${name}, found ${hits.length}`);
  return hits[0];
}

/** Steps 1–6 of the header. Throws, naming the step, when one does not land. */
export async function remitOneDayToMirror(m: MeshScenario, k: KeeperHarness): Promise<RemittedDelivery> {
  const { base, mirror, relay } = m;

  // 1. Interest on the mirror.
  await openLoan(mirror, { lender: 'lender', borrower: 'borrower', principalWeth: '1', collateralTliq: '5', rateBps: 1000, days: 30 });

  // 2. Days 0 and 1 elapse everywhere.
  await m.warp(2 * DAY + 60);
  for (const sc of [base, mirror]) {
    const today = await sc.rewardDay(); // eslint-disable-line no-await-in-loop
    if (today !== 2) throw new Error(`chain ${sc.chain.id} is on reward day ${today}, not 2`);
  }

  // 3. The mirror reports days 0 and 1 to Base, over the lane.
  for (const day of [0n, 1n]) {
    await mirror.diamondWrite('other', 'closeDay', [day], CLOSE_DAY_VALUE); // eslint-disable-line no-await-in-loop
  }
  const reports = await relay.deliver(MIRROR_ID, BASE_ID);
  if (reports.length !== 2) throw new Error(`the relay landed ${reports.length} mirror reports on Base, not 2`);

  // 4. Base closes its own days and finalizes both, now on full coverage.
  await finalizeThrough(base, 1);

  // 5. The keeper's remit pass, as the scheduler runs it.
  await m.syncClock();
  const baseVpfi = m.fixture.vpfiToken;
  const basePool = base.fixture.artifact.vpfiTokenPool as Address;
  const poolBalance = async (): Promise<bigint> =>
    (await base.pub.readContract({ address: baseVpfi, abi: TOKEN_ABI, functionName: 'balanceOf', args: [basePool] })) as bigint;
  const poolBefore = await poolBalance();
  const baseFrom = await base.blockNumber();
  await runRewardBudgetRemit(k.env, tickNow(FIVE_MIN_MS));
  const baseLocked = (await poolBalance()) - poolBefore;
  const remitTxs = await transactionsSince(base, baseFrom);
  const remittedEvents = (await base.diamondEvents('RewardBudgetRemitted', baseFrom + 1n)).filter(
    (e) => Number(e.args.dstChainId) === MIRROR_ID,
  );
  const ev = onlyEvent(remittedEvents, 'RewardBudgetRemitted');
  const remitted = {
    amount: BigInt(ev.args.total as bigint),
    remitId: BigInt(ev.args.remitId as bigint),
    messageId: ev.args.messageId as Hex,
    tx: ev.transactionHash,
  };
  if (remitted.amount === 0n) throw new Error('the keeper remitted nothing to the mirror (day 1 carried no slice)');

  // 6. The remittance lands on the mirror. Its VPFI is measured where it
  // rests: the mirror Diamond, and the reward-custody holder the Diamond
  // keeps reward VPFI in once custody is active.
  const vpfi = mirror.fixture.artifact.vpfiMirror as Address;
  const holder = await mirror.read<Address>('rewardCustodyHolder');
  const balances = async (): Promise<{ diamond: bigint; custodyHolder: bigint }> => ({
    diamond: (await mirror.pub.readContract({ address: vpfi, abi: TOKEN_ABI, functionName: 'balanceOf', args: [mirror.diamond] })) as bigint,
    custodyHolder: (await mirror.pub.readContract({ address: vpfi, abi: TOKEN_ABI, functionName: 'balanceOf', args: [holder] })) as bigint,
  });
  const before = await balances();
  const delivered = await relay.deliver(BASE_ID, MIRROR_ID);
  if (delivered.length !== 1) throw new Error(`the relay landed ${delivered.length} remittances on the mirror, not 1`);
  const relayed = delivered[0];
  // The message the lane carried must be the one the remit announced: the
  // event's id is what an operator traces across chains, so it is checked
  // against the ramp, and the ramp's source transaction against the remit's.
  if (relayed.messageId.toLowerCase() !== remitted.messageId.toLowerCase()) {
    throw new Error(`the relay carried message ${relayed.messageId}, but the remit announced ${remitted.messageId}`);
  }
  if (relayed.sourceTx.toLowerCase() !== remitted.tx.toLowerCase()) {
    throw new Error(`the relayed message came from ${relayed.sourceTx}, not the remit transaction ${remitted.tx}`);
  }
  const after = await balances();
  const vpfiTotalSupply = (await mirror.pub.readContract({ address: vpfi, abi: SUPPLY_ABI, functionName: 'totalSupply' })) as bigint;
  const receipt = await mirror.pub.getTransactionReceipt({ hash: relayed.destinationTx });
  const ingress = mirror.decodeDiamondLogs(receipt.logs);
  const packetHash = onlyEvent(ingress, 'IngressPacketRecorded').args.packetHash as Hex;
  const admitted = ingress.filter((e) => e.eventName === 'TransportBatchAdmitted');
  const batchId = (admitted[0]?.args.batchId as Hex | undefined) ?? (`0x${'0'.repeat(64)}` as Hex);
  return {
    remitted,
    relayed,
    packetHash,
    batchId,
    baseLocked,
    mirrorVpfiReceived: { diamond: after.diamond - before.diamond, custodyHolder: after.custodyHolder - before.custodyHolder },
    custodyHolder: holder,
    mirrorVpfiTotalSupply: vpfiTotalSupply,
    remitTxs,
  };
}

/** The mirror's `getIngressPacket` record, by name. */
export interface IngressPacket {
  sourceChainId: number;
  remitter: Address;
  remitId: bigint;
  kind: number;
  batchId: Hex;
  dayListHash: Hex;
  dayListRoot: Hex;
  chunkCount: number;
  chunksIndexed: bigint;
  disposed: bigint;
  arrivedAt: bigint;
  dayCount: bigint;
}

export async function ingressPacket(mirror: MeshChain, packetHash: Hex): Promise<IngressPacket> {
  return mirror.read<IngressPacket>('getIngressPacket', [packetHash]);
}

/** `getTransportBatch` → its index progress. */
export async function batchProgress(mirror: MeshChain, batchId: Hex): Promise<{ dayCount: number; indexedDays: number }> {
  const b = await mirror.read<readonly [Hex, bigint, bigint, number, number, boolean]>('getTransportBatch', [batchId]);
  return { dayCount: Number(b[3]), indexedDays: Number(b[4]) };
}
