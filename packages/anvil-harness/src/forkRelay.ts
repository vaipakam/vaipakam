/**
 * The deploy rehearsal's CCIP relay between local FORKS of the live testnets
 * (#3892, design `DeployRehearsalDesign.md` §15).
 *
 * Unlike the two-node lane in `./ccipLane`, every CCIP contract here is the
 * one the network itself deployed on the forked chain. On the SOURCE fork
 * nothing is replaced: the protocol's messenger sends through the real
 * router and the real `OnRamp 2.0.0`, which charges its real fee. On the
 * DESTINATION fork one thing is: the code at the real `OffRamp 2.0.0`'s
 * address is replaced with the harness's stand-in
 * (`contracts/script/e2e/RehearsalOffRamp.sol`), so the real router's and the
 * real pools' "who may deliver" checks name it unchanged, and the real pool
 * releases or mints under its real rate limits.
 *
 * The relay then reads the `CCIPMessageSent` events the source on-ramp
 * emitted and hands each message's encoded bytes, exactly as emitted, to the
 * stand-in. It never composes a message. The stand-in calls the receiver
 * through the real router with the message's own gas limit, so a receiver
 * that would run out of gas on the real lane fails here too, and a failed
 * receiver fails the step.
 *
 * Ramp versions are confirmed per lane from the routers on the forks: the
 * stand-in and this relay speak the 2.0.0 message format, so any on-ramp or
 * off-ramp whose `typeAndVersion` is not exactly the 2.0.0 one is refused by
 * name. Older off-ramps the router still lists beside it are reported, not
 * used.
 *
 * What a rehearsal does NOT exercise is stated in {@link FORK_RELAY_LIMITS},
 * which the report carries word for word.
 */
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeDeployData,
  http,
  keccak256,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compiledAbi, compiledArtifact, compileScript } from './fixture';
import { explainMinedRevert } from './minedRevert';
import { anvilControl, assertLoopbackUrl } from './rpc';

const STAND_IN_SOURCE = 'script/e2e/RehearsalOffRamp.sol';

/** The only ramp versions the stand-in and this relay understand. */
export const ON_RAMP_VERSION = 'OnRamp 2.0.0';
export const OFF_RAMP_VERSION = 'OffRamp 2.0.0';

/** What a rehearsal's CCIP leg does not exercise; printed in every report. */
export const FORK_RELAY_LIMITS: readonly string[] = [
  "The messaging network's own verification is not rehearsed: no verifier attests a message; the relay's key stands in for the network.",
  "The network's delays are not rehearsed: a message is delivered when the plan's step asks for it.",
  'Manual execution is not rehearsed: a delivery that fails fails the step instead of waiting to be re-executed.',
  'The gas-limit override a manual execution may carry is not rehearsed: every receiver is called with the gas limit its message carries.',
];

/** One fork the relay works across. */
export interface ForkEnd {
  /** A short name for the report (the chain's slug). */
  name: string;
  /** The fork's local URL. Refused unless it is on this machine. */
  url: string;
  chainId: number;
  /** The chain's CCIP selector, as a decimal string (it is past 2^53). */
  chainSelector: string;
  /** The real CCIP router on the forked chain. */
  router: Address;
  /** The fork's first block: messages are read from here on, never from
   *  the forked chain's own history. */
  fromBlock: bigint;
}

/** The ramps found for one direction of one lane. */
export interface LaneRamps {
  from: string;
  to: string;
  onRamp: Address;
  offRamp: Address;
  /** Other off-ramps the destination router still lists for this source,
   *  with their versions; reported, never used. */
  otherOffRamps: { address: Address; version: string }[];
}

/** A message the relay delivered, for the report. */
export interface ForkRelayedMessage {
  messageId: Hex;
  from: string;
  to: string;
  sender: Address;
  sourceTx: Hex;
  destinationTx: Hex;
  feeToken: Address;
  /** The sum of the message's fee receipts, in `feeToken`. */
  fee: bigint;
  /** The gas the receiver call was given: the message's own limit (0 for a
   *  token-only transfer, which calls no receiver). */
  gasLimit: bigint;
  gasUsed: bigint;
  receiverCalled: boolean;
  /** The token amount the message carried before pool fees (0 if none). */
  tokenAmount: bigint;
}

/** What the rehearsal report prints for the CCIP leg. */
export interface ForkRelayReport {
  lanes: LaneRamps[];
  messages: ForkRelayedMessage[];
  limits: readonly string[];
}

/** A `CCIPMessageSent` as the source on-ramp emitted it. */
export interface SentMessage {
  destChainSelector: bigint;
  sender: Address;
  messageId: Hex;
  feeToken: Address;
  tokenAmountBeforeTokenPoolFees: bigint;
  encodedMessage: Hex;
  receipts: readonly { issuer: Address; destGasLimit: number; destBytesOverhead: number; feeTokenAmount: bigint; extraArgs: Hex }[];
  sourceTx: Hex;
}

/**
 * Pick the messages an on-ramp emitted toward `destChainSelector` out of
 * `logs`. Only logs the on-ramp itself emitted count, and a message whose id
 * is not the hash of its encoded bytes is refused: the stand-in derives the
 * id from the bytes, so such a message could never be the one the source
 * chain sent.
 */
export function selectSentMessages(
  logs: readonly Pick<Log, 'address' | 'data' | 'topics' | 'transactionHash'>[],
  onRamp: Address,
  destChainSelector: bigint,
  onRampAbi: Abi,
): SentMessage[] {
  const out: SentMessage[] = [];
  for (const l of logs) {
    if (l.address.toLowerCase() !== onRamp.toLowerCase()) continue;
    let decoded: { eventName?: string; args?: unknown };
    try {
      decoded = decodeEventLog({ abi: onRampAbi, data: l.data, topics: l.topics as never });
    } catch {
      continue;
    }
    if (decoded.eventName !== 'CCIPMessageSent') continue;
    const a = decoded.args as Omit<SentMessage, 'sourceTx'>;
    if (a.destChainSelector !== destChainSelector) continue;
    if (keccak256(a.encodedMessage) !== a.messageId) {
      throw new Error(`relay: the on-ramp's message ${a.messageId} is not the hash of its own bytes; refusing to deliver it`);
    }
    out.push({ ...a, sourceTx: l.transactionHash as Hex });
  }
  return out;
}

/**
 * Choose the one 2.0.0 off-ramp among the router's off-ramps for a source,
 * refusing anything else by name. `versions` maps each listed address
 * (lower-cased) to its `typeAndVersion`.
 */
export function chooseOffRamp(
  listed: readonly Address[],
  versions: ReadonlyMap<string, string>,
  lane: string,
): { offRamp: Address; others: { address: Address; version: string }[] } {
  const current = listed.filter((a) => versions.get(a.toLowerCase()) === OFF_RAMP_VERSION);
  const others = listed
    .filter((a) => versions.get(a.toLowerCase()) !== OFF_RAMP_VERSION)
    .map((a) => ({ address: a, version: versions.get(a.toLowerCase()) ?? '(no typeAndVersion)' }));
  if (current.length !== 1) {
    const seen = listed.map((a) => `${a} (${versions.get(a.toLowerCase()) ?? 'no typeAndVersion'})`).join(', ') || 'none';
    throw new Error(
      `relay: lane ${lane} has ${current.length} '${OFF_RAMP_VERSION}' off-ramps on the destination router (listed: ${seen}); the stand-in is built for exactly one`,
    );
  }
  return { offRamp: current[0]!, others };
}

/** Refuse a ramp whose version is not the one the relay was built for. */
export function requireVersion(found: string, want: string, what: string): void {
  if (found !== want) {
    throw new Error(`relay: ${what} reports '${found}', not '${want}'; the rehearsal's stand-in speaks only the ${want} message format`);
  }
}

function chainOf(end: ForkEnd): Chain {
  return {
    id: end.chainId,
    name: `fork-${end.name}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [end.url] } },
  };
}

/** Compile the stand-in (and the ABIs the relay reads with). */
export function compileForkRelay(): void {
  compileScript(STAND_IN_SOURCE);
}

/**
 * The relay (see the header). Build one with {@link ForkCcipRelay.install},
 * which finds each lane's ramps, refuses any version it was not built for,
 * and installs the stand-in on every destination fork.
 */
export class ForkCcipRelay {
  private readonly messages: ForkRelayedMessage[] = [];

  private constructor(
    private readonly ends: Map<number, ForkEnd>,
    private readonly lanes: Map<string, LaneRamps>,
    private readonly relayerKey: Hex,
    private readonly abis: { onRampEvents: Abi; reads: Abi; standIn: Abi },
  ) {}

  /**
   * Find the ramps on every ordered pair of `ends`, check each lane is live
   * on the forks (the source on-ramp addresses the destination's 2.0.0
   * off-ramp, which accepts that on-ramp under the destination router, and
   * the router routes the source to it), then replace each destination
   * off-ramp's code with the stand-in, built from the real off-ramp's own
   * static config. `relayerKey` is a key made for the run; it is funded on
   * each fork and is the only account the stand-in accepts.
   */
  static async install(ends: readonly ForkEnd[], relayerKey: Hex): Promise<ForkCcipRelay> {
    for (const e of ends) assertLoopbackUrl(e.url);
    const abis = {
      onRampEvents: compiledAbi(STAND_IN_SOURCE, 'IOnRampV2Events'),
      reads: compiledAbi(STAND_IN_SOURCE, 'IRehearsalRampReads'),
      standIn: compiledAbi(STAND_IN_SOURCE, 'RehearsalOffRamp'),
    };
    const relayer = privateKeyToAccount(relayerKey);
    const clients = new Map(ends.map((e) => [e.chainId, client(e)]));
    const lanes = new Map<string, LaneRamps>();
    // Destination off-ramp -> the sources (and their on-ramps) it accepts.
    const installs = new Map<number, { offRamp: Address; sources: { selector: bigint; onRamps: Hex[] }[] }>();

    for (const src of ends) {
      for (const dst of ends) {
        if (src.chainId === dst.chainId) continue;
        const lane = `${src.name} -> ${dst.name}`;
        const s = clients.get(src.chainId)!;
        const d = clients.get(dst.chainId)!;
        const read = <T>(c: PublicClient, address: Address, functionName: string, args: unknown[] = []) =>
          c.readContract({ address, abi: abis.reads, functionName, args } as never) as Promise<T>;

        const onRamp = await read<Address>(s, src.router, 'getOnRamp', [BigInt(dst.chainSelector)]);
        if (/^0x0{40}$/i.test(onRamp)) throw new Error(`relay: lane ${lane}: the source router has no on-ramp for ${dst.name}`);
        requireVersion(await read<string>(s, onRamp, 'typeAndVersion'), ON_RAMP_VERSION, `lane ${lane}'s on-ramp ${onRamp}`);

        const routed = await read<readonly { sourceChainSelector: bigint; offRamp: Address }[]>(d, dst.router, 'getOffRamps');
        const listed = routed.filter((r) => r.sourceChainSelector === BigInt(src.chainSelector)).map((r) => r.offRamp);
        const versions = new Map<string, string>();
        for (const a of listed) {
          versions.set(a.toLowerCase(), await read<string>(d, a, 'typeAndVersion').catch(() => '(no typeAndVersion)'));
        }
        const { offRamp, others } = chooseOffRamp(listed, versions, lane);

        const destConfig = await read<{ offRamp: Hex }>(s, onRamp, 'getDestChainConfig', [BigInt(dst.chainSelector)]);
        if (destConfig.offRamp.toLowerCase() !== offRamp.toLowerCase()) {
          throw new Error(`relay: lane ${lane}: the source on-ramp addresses ${destConfig.offRamp}, not the destination's ${OFF_RAMP_VERSION} ${offRamp}`);
        }
        const stat = await read<{ localChainSelector: bigint }>(d, offRamp, 'getStaticConfig');
        if (stat.localChainSelector !== BigInt(dst.chainSelector)) {
          throw new Error(`relay: lane ${lane}: the off-ramp ${offRamp} serves selector ${stat.localChainSelector}, not ${dst.chainSelector}`);
        }
        const cfg = await read<{ router: Address; isEnabled: boolean; onRamps: readonly Hex[] }>(d, offRamp, 'getSourceChainConfig', [
          BigInt(src.chainSelector),
        ]);
        if (cfg.router.toLowerCase() !== dst.router.toLowerCase() || !cfg.isEnabled) {
          throw new Error(`relay: lane ${lane}: the off-ramp's source config is ${cfg.isEnabled ? 'enabled' : 'disabled'} under router ${cfg.router}, expected enabled under ${dst.router}`);
        }
        const encodedOnRamp = encodeAbiParameters([{ type: 'address' }], [onRamp]).toLowerCase();
        if (!cfg.onRamps.some((o) => o.toLowerCase() === encodedOnRamp)) {
          throw new Error(`relay: lane ${lane}: the off-ramp does not accept the source on-ramp ${onRamp}`);
        }

        lanes.set(laneKey(src.chainId, dst.chainId), { from: src.name, to: dst.name, onRamp, offRamp, otherOffRamps: others });
        const inst = installs.get(dst.chainId) ?? { offRamp, sources: [] };
        if (inst.offRamp.toLowerCase() !== offRamp.toLowerCase()) {
          throw new Error(`relay: ${dst.name} routes different sources to different ${OFF_RAMP_VERSION} off-ramps (${inst.offRamp}, ${offRamp})`);
        }
        inst.sources.push({ selector: BigInt(src.chainSelector), onRamps: [...cfg.onRamps] });
        installs.set(dst.chainId, inst);
      }
    }

    const { creation } = compiledArtifact(STAND_IN_SOURCE, 'RehearsalOffRamp');
    for (const [chainId, inst] of installs) {
      const end = ends.find((e) => e.chainId === chainId)!;
      const d = clients.get(chainId)!;
      const control = anvilControl(end.url);
      await control.setBalance(relayer.address, 100n * 10n ** 18n);
      const stat = (await d.readContract({ address: inst.offRamp, abi: abis.reads, functionName: 'getStaticConfig' } as never)) as {
        gasForCallExactCheck: number;
        tokenAdminRegistry: Address;
      };
      const wallet = createWalletClient({ account: relayer, chain: chainOf(end), transport: http(end.url) });
      const deployTx = await wallet.sendTransaction({
        data: encodeDeployData({
          abi: abis.standIn,
          bytecode: creation,
          args: [end.router, stat.tokenAdminRegistry, BigInt(end.chainSelector), stat.gasForCallExactCheck, relayer.address],
        }),
      } as never);
      const deployed = await d.waitForTransactionReceipt({ hash: deployTx, timeout: 60_000 });
      if (deployed.status !== 'success' || !deployed.contractAddress) {
        throw new Error(`relay: deploying the stand-in on ${end.name} failed (tx ${deployTx})`);
      }
      const runtime = await d.getCode({ address: deployed.contractAddress });
      if (!runtime || runtime === '0x') throw new Error(`relay: the stand-in on ${end.name} has no code`);
      await control.rpc('anvil_setCode', [inst.offRamp, runtime]);
      for (const source of inst.sources) {
        const hash = await wallet.writeContract({
          address: inst.offRamp,
          abi: abis.standIn,
          functionName: 'allowOnRamps',
          args: [source.selector, source.onRamps],
        } as never);
        const r = await d.waitForTransactionReceipt({ hash, timeout: 60_000 });
        if (r.status !== 'success') throw new Error(`relay: allowing the on-ramps on ${end.name} failed (tx ${hash})`);
      }
    }

    return new ForkCcipRelay(new Map(ends.map((e) => [e.chainId, e])), lanes, relayerKey, abis);
  }

  private end(chainId: number): ForkEnd {
    const e = this.ends.get(chainId);
    if (!e) throw new Error(`relay: no fork with chain id ${chainId}`);
    return e;
  }

  private lane(from: number, to: number): LaneRamps {
    const l = this.lanes.get(laneKey(from, to));
    if (!l) throw new Error(`relay: no lane from chain ${from} to chain ${to}`);
    return l;
  }

  /** Messages the source on-ramp sent toward `toChainId` since the fork
   *  began that the destination has not delivered, oldest first. */
  async pending(fromChainId: number, toChainId: number): Promise<SentMessage[]> {
    const src = this.end(fromChainId);
    const lane = this.lane(fromChainId, toChainId);
    const logs = await client(src).getLogs({ address: lane.onRamp, fromBlock: src.fromBlock, toBlock: 'latest' });
    const sent = selectSentMessages(logs, lane.onRamp, BigInt(this.end(toChainId).chainSelector), this.abis.onRampEvents);
    return this.undelivered(toChainId, lane.offRamp, sent);
  }

  private async undelivered(toChainId: number, offRamp: Address, sent: SentMessage[]): Promise<SentMessage[]> {
    const d = client(this.end(toChainId));
    const out: SentMessage[] = [];
    for (const m of sent) {
      const done = (await d.readContract({ address: offRamp, abi: this.abis.standIn, functionName: 'executed', args: [m.messageId] } as never)) as boolean;
      if (!done) out.push(m);
    }
    return out;
  }

  /** Deliver every pending message from `fromChainId` to `toChainId`, in
   *  send order. A delivery that fails throws: it is a failed step. */
  async deliver(fromChainId: number, toChainId: number): Promise<ForkRelayedMessage[]> {
    const out: ForkRelayedMessage[] = [];
    for (const m of await this.pending(fromChainId, toChainId)) out.push(await this.deliverOne(fromChainId, toChainId, m));
    return out;
  }

  /**
   * Deliver the messages one source transaction sent toward `toChainId`: what
   * a plan step that waits for a message calls before it continues. Throws if
   * the transaction sent none, or if any was already delivered.
   */
  async deliverFromTx(fromChainId: number, toChainId: number, txHash: Hex): Promise<ForkRelayedMessage[]> {
    const src = this.end(fromChainId);
    const lane = this.lane(fromChainId, toChainId);
    const receipt = await client(src).getTransactionReceipt({ hash: txHash });
    const sent = selectSentMessages(receipt.logs, lane.onRamp, BigInt(this.end(toChainId).chainSelector), this.abis.onRampEvents);
    if (sent.length === 0) throw new Error(`relay: transaction ${txHash} on ${src.name} sent no message toward chain ${toChainId}`);
    const pending = await this.undelivered(toChainId, lane.offRamp, sent);
    if (pending.length !== sent.length) throw new Error(`relay: a message transaction ${txHash} sent was already delivered`);
    const out: ForkRelayedMessage[] = [];
    for (const m of pending) out.push(await this.deliverOne(fromChainId, toChainId, m));
    return out;
  }

  private async deliverOne(fromChainId: number, toChainId: number, m: SentMessage): Promise<ForkRelayedMessage> {
    const src = this.end(fromChainId);
    const dst = this.end(toChainId);
    const lane = this.lane(fromChainId, toChainId);
    const d = client(dst);
    const account = privateKeyToAccount(this.relayerKey);
    const wallet = createWalletClient({ account, chain: chainOf(dst), transport: http(dst.url), pollingInterval: 100 });
    // Simulate first so a refusal surfaces as the destination's own error.
    const { request } = await d.simulateContract({
      account,
      address: lane.offRamp,
      abi: this.abis.standIn,
      functionName: 'execute',
      args: [m.encodedMessage],
    } as never);
    const hash = await wallet.writeContract(request as never);
    const receipt = await d.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== 'success') {
      const why = await explainMinedRevert(d, anvilControl(dst.url).rpc, receipt, [this.abis.standIn]);
      throw new Error(`relay: delivering message ${m.messageId} to ${dst.name} reverted when mined (tx ${hash}): ${why}`);
    }
    let delivered: { gasLimit: bigint; gasUsed: bigint; receiverCalled: boolean } | undefined;
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() !== lane.offRamp.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: this.abis.standIn, data: l.data, topics: l.topics as never });
        if (ev.eventName === 'RehearsalDelivered') delivered = ev.args as unknown as typeof delivered;
      } catch {
        // Another event of the stand-in's.
      }
    }
    if (!delivered) throw new Error(`relay: delivering message ${m.messageId} to ${dst.name} recorded no delivery (tx ${hash})`);
    const row: ForkRelayedMessage = {
      messageId: m.messageId,
      from: src.name,
      to: dst.name,
      sender: m.sender,
      sourceTx: m.sourceTx,
      destinationTx: hash,
      feeToken: m.feeToken,
      fee: m.receipts.reduce((sum, r) => sum + r.feeTokenAmount, 0n),
      gasLimit: delivered.gasLimit,
      gasUsed: delivered.gasUsed,
      receiverCalled: delivered.receiverCalled,
      tokenAmount: m.tokenAmountBeforeTokenPoolFees,
    };
    this.messages.push(row);
    return row;
  }

  /** The CCIP leg of the rehearsal report. */
  report(): ForkRelayReport {
    return { lanes: [...this.lanes.values()], messages: [...this.messages], limits: FORK_RELAY_LIMITS };
  }
}

function laneKey(from: number, to: number): string {
  return `${from}:${to}`;
}

function client(end: ForkEnd): PublicClient {
  return createPublicClient({ chain: chainOf(end), transport: http(end.url), pollingInterval: 100 }) as PublicClient;
}
