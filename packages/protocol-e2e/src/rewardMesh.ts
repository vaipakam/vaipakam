/**
 * The cross-chain reward day, driven by its permissionless and operator
 * entry points the way any caller on a live Base/mirror pair would drive it.
 * Nothing here runs keeper code: the keeper is one possible caller of these
 * functions, and this suite proves the protocol behaviour underneath it.
 *
 *   1. {@link closeDays}: `closeDay` on both chains. Base records its own
 *      report directly; the mirror's leaves over the lane, and the relay lands
 *      it on Base.
 *   2. {@link finalizeDays}: `finalizeDay` on Base, which needs every expected
 *      reporter in (both chains here), so it finalizes on coverage.
 *   3. {@link broadcastDays}: `broadcastGlobal` on Base, paying exactly the
 *      fee `quoteBroadcastGlobal` quotes, and the relay lands each broadcast
 *      on the mirror, which then knows the day's global pair.
 *   4. {@link remitDays}: `remitRewardBudget` from the address Base authorized
 *      to remit (`fixture.ts`), paying `quoteRemittanceFee`, and the relay
 *      lands VPFI and message together on the mirror, whose ingress records
 *      the packet and admits its VPFI into a transport epoch;
 *   5. {@link indexDelivery}: the epoch's day list INDEXED on the mirror
 *      (`materializeTransportBatchChunk`, permissionless, chunk by chunk with
 *      each chunk's Merkle proof). The delivery stamped only the list's root,
 *      so until somebody supplies the list an epoch funds nothing a claim can
 *      find. The list is rebuilt from Base's reservation record and checked
 *      against both roots before anything is sent, with the shared wire rules
 *      (`@vaipakam/lib/d6Wire`) the keeper's delivery-proof pass uses.
 *
 * Each step throws, naming what did not land, rather than leaving a later
 * assertion to fail for a reason it does not state.
 */
import { BaseError, ContractFunctionRevertedError, type Address, type Hex } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { d6Chunk, d6Leaves, d6Proof, d6Root, fundedDaysFromBits } from '@vaipakam/lib/d6Wire';
import { BASE_ID, LANE_NATIVE_FEE, MIRROR_ID } from '@vaipakam/anvil-harness/mesh';
import type { MeshScenario } from '@vaipakam/anvil-harness/meshScenario';
import type { RelayedMessage } from '@vaipakam/anvil-harness/ccipLane';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';

/** `isDayReadyToFinalize`'s reason for a day already finalized. */
const ALREADY_FINALIZED = 1;

/** A remittance batch's ceiling: the VPFI pools' per-lane bucket capacity
 *  (50,000 VPFI), far above anything a few scenario days remit. */
export const REMIT_LANE_CAP = 50_000n * 10n ** 18n;

/**
 * Step 1 for `days`: close each on both chains (a day already closed on a
 * chain is left as it is) and land the mirror's reports on Base. Returns the
 * relayed reports.
 */
export async function closeDays(m: MeshScenario, days: readonly number[]): Promise<RelayedMessage[]> {
  for (const d of days) {
    if ((await m.base.read<bigint>('getChainReportSentAt', [BigInt(d)])) === 0n) {
      await m.base.diamondWrite('other', 'closeDay', [BigInt(d)]);
    }
    if ((await m.mirror.read<bigint>('getChainReportSentAt', [BigInt(d)])) === 0n) {
      // The lane's on-ramp quotes one fixed native fee per message; the
      // messenger forwards what the send costs and refunds the rest.
      await m.mirror.diamondWrite('other', 'closeDay', [BigInt(d)], LANE_NATIVE_FEE);
    }
  }
  return m.relay.deliver(MIRROR_ID, BASE_ID);
}

/** Step 2: finalize each of `days` on Base, on full coverage. */
export async function finalizeDays(m: MeshScenario, days: readonly number[]): Promise<void> {
  for (const d of days) {
    const [ready, reason] = await m.base.read<readonly [boolean, number]>('isDayReadyToFinalize', [BigInt(d)]);
    if (Number(reason) === ALREADY_FINALIZED) continue;
    if (!ready) throw new Error(`Base will not finalize day ${d} (reason ${reason}): a report has not landed`);
    await m.base.diamondWrite('other', 'finalizeDay', [BigInt(d)]);
  }
}

/** Step 3: broadcast each of `days` from Base at its quoted fee and land the
 *  broadcasts on the mirror. Returns the relayed broadcasts. */
export async function broadcastDays(m: MeshScenario, days: readonly number[]): Promise<RelayedMessage[]> {
  for (const d of days) {
    const fee = await m.base.read<bigint>('quoteBroadcastGlobal', [BigInt(d)]);
    await m.base.diamondWrite('other', 'broadcastGlobal', [BigInt(d)], fee);
  }
  return m.relay.deliver(BASE_ID, MIRROR_ID);
}

/** What one remittance moved, measured at both pools and at the mirror. */
export interface Remittance {
  /** `quoteRewardBudget`'s total for the batch, before the send. */
  quoted: bigint;
  /** The VPFI Base's lock/release pool took in. */
  baseLocked: bigint;
  /** The relayed message, VPFI leg included. */
  relayed: RelayedMessage;
  /** The mirror ingress's record of it. */
  packetHash: Hex;
  /** The transport epoch the ingress admitted it into. */
  batchId: Hex;
}

/** Step 4: remit `days`' mirror budget from Base and land it on the mirror. */
export async function remitDays(m: MeshScenario, days: readonly number[]): Promise<Remittance> {
  const dayIds = days.map(BigInt);
  const [quoted] = await m.base.read<readonly [bigint, readonly bigint[]]>('quoteRewardBudget', [MIRROR_ID, dayIds]);
  if (quoted === 0n) throw new Error(`Base quotes no mirror budget for days ${days.join(',')}`);
  const [fee] = await m.base.read<readonly [bigint, bigint]>('quoteRemittanceFee', [MIRROR_ID, dayIds]);
  const pool = m.base.fixture.artifact.vpfiTokenPool as Address;
  const poolBalance = (): Promise<bigint> =>
    m.base.pub.readContract({ address: m.fixture.vpfiToken, abi: TOKEN_ABI, functionName: 'balanceOf', args: [pool] }) as Promise<bigint>;
  const before = await poolBalance();
  await m.base.diamondWrite('keeper', 'remitRewardBudget', [MIRROR_ID, dayIds, REMIT_LANE_CAP], fee);
  const baseLocked = (await poolBalance()) - before;
  const relayed = await m.relay.deliver(BASE_ID, MIRROR_ID);
  if (relayed.length !== 1) throw new Error(`the relay landed ${relayed.length} remittances on the mirror, not 1`);
  const ingress = m.mirror.decodeDiamondLogs((await m.mirror.pub.getTransactionReceipt({ hash: relayed[0].destinationTx })).logs);
  const one = (name: string) => {
    const hits = ingress.filter((e) => e.eventName === name);
    if (hits.length !== 1) throw new Error(`the remittance's ingress emitted ${hits.length} ${name}, not 1`);
    return hits[0];
  };
  const packetHash = one('IngressPacketRecorded').args.packetHash as Hex;
  const batchId = one('TransportBatchAdmitted').args.batchId as Hex;
  return { quoted, baseLocked, relayed: relayed[0], packetHash, batchId };
}

/** A contract refusal, decoded: the error's name and its arguments. */
export interface Refusal {
  name: string;
  args: readonly unknown[];
}

/** The decoded revert inside `err`, or `undefined` for any other failure. */
export function refusalOf(err: unknown): Refusal | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError) || !reverted.data) return undefined;
  return { name: reverted.data.errorName, args: (reverted.data.args ?? []) as readonly unknown[] };
}

/**
 * How Base refuses a remittance of `days`, on the fee quote and on the send
 * alike (they share one rule), or `null` for each that would go through.
 * Nothing is sent: the send is simulated.
 */
export async function remitRefusals(
  m: MeshScenario,
  days: readonly number[],
): Promise<{ quote: Refusal | null; send: Refusal | null }> {
  const dayIds = days.map(BigInt);
  const attempt = async (run: () => Promise<unknown>): Promise<Refusal | null> => {
    try {
      await run();
      return null;
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) throw err;
      return refusal;
    }
  };
  const quote = await attempt(() => m.base.read('quoteRemittanceFee', [MIRROR_ID, dayIds]));
  const send = await attempt(() =>
    m.base.pub.simulateContract({
      address: m.base.diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'remitRewardBudget',
      args: [MIRROR_ID, dayIds, REMIT_LANE_CAP],
      value: LANE_NATIVE_FEE * 10n,
      account: m.base.address('keeper'),
    } as never),
  );
  return { quote, send };
}

/** Step 5: index a delivery's epoch on the mirror. Returns the days indexed. */
export async function indexDelivery(m: MeshScenario, rem: Remittance): Promise<bigint[]> {
  const packet = await m.mirror.read<{ remitter: Address; remitId: bigint; dayListRoot: Hex; batchId: Hex }>('getIngressPacket', [rem.packetHash]);
  if (packet.batchId.toLowerCase() !== rem.batchId.toLowerCase()) throw new Error(`the packet names epoch ${packet.batchId}, not ${rem.batchId}`);
  if (packet.remitter.toLowerCase() !== m.base.diamond.toLowerCase()) throw new Error(`the packet names remitter ${packet.remitter}, not Base's Diamond`);
  const reservation = await m.base.read<{ dayIds: readonly bigint[]; fundedDayBits: readonly bigint[]; dayListRoot: Hex; dstChainId: number }>(
    'getRemitReservation',
    [packet.remitId],
  );
  if (Number(reservation.dstChainId) !== MIRROR_ID) throw new Error(`reservation ${packet.remitId} names chain ${reservation.dstChainId}`);
  const funded = fundedDaysFromBits(reservation.dayIds, reservation.fundedDayBits);
  if (!funded || funded.length === 0) throw new Error(`reservation ${packet.remitId} records no funded day`);
  const leaves = d6Leaves(funded);
  const root = d6Root(leaves);
  if (root.toLowerCase() !== reservation.dayListRoot.toLowerCase() || root.toLowerCase() !== packet.dayListRoot.toLowerCase()) {
    throw new Error(`the rebuilt day list's root ${root} matches neither the reservation's nor the packet's`);
  }
  for (let c = 0; c < leaves.length; c++) {
    await m.mirror.diamondWrite('other', 'materializeTransportBatchChunk', [rem.batchId, BigInt(c), d6Chunk(funded, c), d6Proof(leaves, c), [], []]);
  }
  return funded;
}
