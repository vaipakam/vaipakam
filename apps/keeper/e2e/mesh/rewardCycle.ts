/**
 * The cross-chain reward-budget cycle, driven the way it runs on a live
 * Base/mirror pair, up to the point where the keeper's delivery-proof pass
 * takes over:
 *
 *   1. a real loan on the MIRROR, so the mirror has interest to report;
 *   2. two reward days elapse on both chains (one shared clock);
 *   3. the KEEPER's real day-close pass (`runRewardDayClose`, #2612) closes
 *      each day on both chains — on the mirror `closeDay` sends the day's
 *      report to Base over the lane, paying the messenger's quoted fee; on
 *      Base it records Base's own report — and the relay lands each mirror
 *      report on Base;
 *   4. the next run of that pass finalizes the same days on Base (both
 *      expected reporters are in, so each finalizes on coverage) and
 *      broadcasts each, and the relay lands both broadcasts on the mirror,
 *      which then knows each day's global pair; a third run confirms them
 *      there and sends nothing;
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
import { DayStore } from '../../src/rewardDayClose/store';
import { runRewardDayClose } from '../../src/rewardDayClose';
import { openLoan } from '../harness/lending';
import { tickNow, type KeeperHarness } from '../harness/keeperEnv';
import { TOKEN_ABI, type DecodedEvent } from '../harness/chain';
import type { RelayedMessage } from '@vaipakam/anvil-harness/ccipLane';
import { BASE_ID, MIRROR_ID } from './fixture';
import type { MeshChain, MeshScenario } from './mesh';

const DAY = 86_400;
/** The remit pass's cadence (passSchedule): it runs every five minutes. */
export const FIVE_MIN_MS = 5 * 60_000;
/** The day-close pass's cadence (passSchedule): every quarter hour. */
export const FIFTEEN_MIN_MS = 15 * 60_000;

const SUPPLY_ABI = [
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

/** What the day-close pass did over steps 3–4. */
export interface DayCloseRuns {
  /** Every transaction each chain mined during those runs (sender, hash, to). */
  baseTxs: { from: Address; hash: Hex; to: Address | null }[];
  mirrorTxs: { from: Address; hash: Hex; to: Address | null }[];
  /** The mirror's `closeDay` sends, as Base's ingress and the mirror recorded them. */
  mirrorReportsRelayed: number;
  /** The broadcasts the relay landed on the mirror. */
  broadcastsRelayed: number;
  /** The mirror's known global pair for each closed day, after the broadcasts. */
  mirrorKnows: { day: number; isSet: boolean }[];
}

export interface RemittedDelivery {
  /** Steps 3–4: the keeper's day-close pass. */
  dayClose: DayCloseRuns;
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

  // 3. The keeper's day-close pass closes days 0 and 1 on both chains: the
  // mirror's reports go to Base over the lane; Base records its own and, with
  // the mirror's not yet in, finalizes nothing.
  const baseStart = await base.blockNumber();
  const mirrorStart = await mirror.blockNumber();
  const dayClose = async (): Promise<void> => {
    await m.syncClock();
    await runRewardDayClose(k.env, tickNow(FIFTEEN_MIN_MS));
  };
  await dayClose();
  for (const day of [0, 1]) {
    for (const sc of [base, mirror]) {
      const sent = await sc.read<bigint>('getChainReportSentAt', [BigInt(day)]); // eslint-disable-line no-await-in-loop
      if (sent === 0n) throw new Error(`the day-close pass did not close day ${day} on chain ${sc.chain.id}`);
    }
    const [, reason] = await base.read<readonly [boolean, number]>('isDayReadyToFinalize', [BigInt(day)]); // eslint-disable-line no-await-in-loop
    if (Number(reason) === 1) throw new Error(`Base finalized day ${day} before the mirror's report landed`);
  }
  // Each close's receipt shows its report leaving through the messenger the
  // run checked, so no unchecked dispatch is recorded.
  const dispatched = await new DayStore(k.env, MIRROR_ID, mirror.diamond, `mirror@${BASE_ID}`).dispatches([0, 1]);
  if (dispatched.size > 0) throw new Error(`the day-close pass read a mirror close as sent through an unchecked messenger (${JSON.stringify([...dispatched.values()])})`);
  const reports = await relay.deliver(MIRROR_ID, BASE_ID);
  if (reports.length !== 2) throw new Error(`the relay landed ${reports.length} mirror reports on Base, not 2`);

  // 4. The next run finalizes both on full coverage and broadcasts each; the
  // relay lands the broadcasts on the mirror; a third run confirms them there.
  await dayClose();
  for (const day of [0, 1]) {
    const [, reason] = await base.read<readonly [boolean, number]>('isDayReadyToFinalize', [BigInt(day)]); // eslint-disable-line no-await-in-loop
    if (Number(reason) !== 1) throw new Error(`the day-close pass did not finalize day ${day} on Base (reason ${reason})`);
  }
  // What each broadcast reached is recorded from its receipt, the messenger's
  // own per-destination events, not from the list the run read beforehand.
  const marks = await new DayStore(k.env, BASE_ID, base.diamond, 'canonical').broadcasts([0, 1]);
  for (const day of [0, 1]) {
    if (marks.get(day)?.sentTo[String(MIRROR_ID)]?.proven !== true) {
      throw new Error(`the day-close pass did not record day ${day}'s broadcast to the mirror from its receipt (${JSON.stringify(marks.get(day) ?? null)})`);
    }
  }
  const broadcasts = await relay.deliver(BASE_ID, MIRROR_ID);
  if (broadcasts.length !== 2) throw new Error(`the relay landed ${broadcasts.length} broadcasts on the mirror, not 2`);
  const mirrorKnows: { day: number; isSet: boolean }[] = [];
  for (const day of [0, 1]) {
    const [, , isSet] = await mirror.read<readonly [bigint, bigint, boolean]>('getKnownGlobalInterestNumeraire18', [BigInt(day)]); // eslint-disable-line no-await-in-loop
    mirrorKnows.push({ day, isSet });
  }
  const baseBeforeConfirm = await base.blockNumber();
  await dayClose();
  if ((await base.blockNumber()) !== baseBeforeConfirm) throw new Error('the day-close pass sent again after both broadcasts had landed');
  const dayCloseRuns: DayCloseRuns = {
    baseTxs: await transactionsSince(base, baseStart),
    mirrorTxs: await transactionsSince(mirror, mirrorStart),
    mirrorReportsRelayed: reports.length,
    broadcastsRelayed: broadcasts.length,
    mirrorKnows,
  };

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
    dayClose: dayCloseRuns,
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
