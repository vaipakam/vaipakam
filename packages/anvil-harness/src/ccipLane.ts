/**
 * A local CCIP lane between two anvil nodes, and the relay that carries it.
 *
 * The vendored chainlink-local simulator delivers a message inside ONE chain:
 * its router hands tokens straight to the receiver and calls it on the
 * sending chain. A scenario that spans two nodes needs what a live lane does
 * instead — tokens locked or burned by the source pool, released or minted
 * by the destination pool, the message routed into the destination receiver
 * — so each node gets the REAL CCIP router, RMN and token admin registry,
 * plus the two ramps of `contracts/script/e2e/E2ELocalCcip.sol`, where
 * Chainlink's DONs sit on a live lane ({@link deployLocalLane}).
 *
 * {@link CcipRelay} is what carries a message across: it reads the
 * `CCIPMessageSent` events the SOURCE node's on-ramp emitted and hands each
 * message, exactly as emitted, to the DESTINATION node's off-ramp, which
 * releases its tokens through the real pool and routes it through the real
 * router. The relay never composes a message: it can only deliver what the
 * source chain's contracts sent. A scenario calls it explicitly, so it decides
 * WHEN a message lands — as a live lane's latency would — and never WHAT.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compiledAbi, compileScript, readContractsJson, REPO_ROOT, runForgeScript } from './fixture';

const LANE_SCRIPT = 'script/e2e/DeployE2ELocalCcip.s.sol';
const RAMPS_SOURCE = 'script/e2e/E2ELocalCcip.sol';

/** One node's half of the lane, as `DeployE2ELocalCcip` recorded it. */
export interface LocalLane {
  router: Address;
  rmnProxy: Address;
  rmnRemote: Address;
  tokenAdminRegistry: Address;
  registryModuleOwnerCustom: Address;
  onRamp: Address;
  offRamp: Address;
  relayer: Address;
  localChainSelector: string;
  remoteChainSelector: string;
  remoteChainId: number;
  laneNativeFeeWei: string;
}

/** Compile the lane script (and the ramps it deploys). */
export function compileLocalLane(): void {
  compileScript(LANE_SCRIPT);
}

/**
 * Deploy one node's half of the lane toward `remoteChainId` on the node at
 * `url` (which must already present its own chain id and carry the canonical
 * WETH9 — `deployFromSource` installs it). `outRelative` is where the
 * addresses are recorded, a file under `contracts/deployments/.forge-test/`.
 */
export function deployLocalLane(
  url: string,
  opts: { deployerKey: Hex; remoteChainId: number; relayer: Address; nativeFeeWei: bigint; outRelative: string },
): LocalLane {
  fs.mkdirSync(path.dirname(path.join(REPO_ROOT, 'contracts', opts.outRelative)), { recursive: true });
  runForgeScript(LANE_SCRIPT, url, {
    DEPLOYER_PRIVATE_KEY: opts.deployerKey,
    E2E_REMOTE_CHAIN_ID: String(opts.remoteChainId),
    E2E_RELAYER_ADDRESS: opts.relayer,
    E2E_LANE_NATIVE_FEE_WEI: opts.nativeFeeWei.toString(),
    E2E_CCIP_OUT: opts.outRelative,
  });
  const raw = readContractsJson<Record<string, unknown>>(opts.outRelative);
  return {
    router: raw.router as Address,
    rmnProxy: raw.rmnProxy as Address,
    rmnRemote: raw.rmnRemote as Address,
    tokenAdminRegistry: raw.tokenAdminRegistry as Address,
    registryModuleOwnerCustom: raw.registryModuleOwnerCustom as Address,
    onRamp: raw.onRamp as Address,
    offRamp: raw.offRamp as Address,
    relayer: raw.relayer as Address,
    localChainSelector: decimalString(raw.localChainSelector, 'localChainSelector'),
    remoteChainSelector: decimalString(raw.remoteChainSelector, 'remoteChainSelector'),
    remoteChainId: Number(raw.remoteChainId),
    laneNativeFeeWei: decimalString(raw.laneNativeFeeWei, 'laneNativeFeeWei'),
  };
}

/** A figure the lane script records as a decimal string (a CCIP selector is
 *  past 2^53, so a JSON number would arrive rounded). Refuses anything else. */
function decimalString(v: unknown, what: string): string {
  if (typeof v !== 'string' || !/^[0-9]+$/.test(v)) {
    throw new Error(`the lane record's ${what} is ${JSON.stringify(v)}, not a decimal string`);
  }
  return v;
}

/** One end of the lane: a node, the chain id it presents, and its half. */
export interface LaneEnd {
  url: string;
  chainId: number;
  lane: LocalLane;
}

/** A message the relay carried, as both ends recorded it. */
export interface RelayedMessage {
  messageId: Hex;
  sequenceNumber: bigint;
  /** The sending contract on the source chain (the source CcipMessenger). */
  sender: Address;
  /** The receiving contract on the destination chain. */
  receiver: Address;
  /** Each token leg: the amount the source pool locked or burned. */
  tokenAmounts: { sourcePool: Address; amount: bigint }[];
  sourceTx: Hex;
  destinationTx: Hex;
}

/** The decoded `Internal.EVM2AnyRampMessage` an on-ramp emits. */
interface RampMessage {
  header: { messageId: Hex; sourceChainSelector: bigint; destChainSelector: bigint; sequenceNumber: bigint; nonce: bigint };
  sender: Address;
  data: Hex;
  receiver: Hex;
  extraArgs: Hex;
  feeToken: Address;
  feeTokenAmount: bigint;
  feeValueJuels: bigint;
  tokenAmounts: readonly { sourcePoolAddress: Address; destTokenAddress: Hex; extraData: Hex; amount: bigint; destExecData: Hex }[];
}

function chainOf(end: LaneEnd): Chain {
  return {
    id: end.chainId,
    name: `anvil-${end.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [end.url] } },
  };
}

/**
 * The relay (see the header). `relayerKey` must be the key each off-ramp was
 * deployed to accept messages from.
 */
export class CcipRelay {
  private readonly onRampAbi: Abi;
  private readonly offRampAbi: Abi;
  private readonly ends: Map<number, LaneEnd>;

  constructor(
    ends: readonly LaneEnd[],
    private readonly relayerKey: Hex,
  ) {
    this.onRampAbi = compiledAbi(RAMPS_SOURCE, 'E2ELocalOnRamp');
    this.offRampAbi = compiledAbi(RAMPS_SOURCE, 'E2ELocalOffRamp');
    this.ends = new Map(ends.map((e) => [e.chainId, e]));
    const relayer = privateKeyToAccount(relayerKey).address.toLowerCase();
    for (const e of ends) {
      if (e.lane.relayer.toLowerCase() !== relayer) {
        throw new Error(`the off-ramp on chain ${e.chainId} accepts ${e.lane.relayer}, not this relay's key (${relayer})`);
      }
    }
  }

  private end(chainId: number): LaneEnd {
    const e = this.ends.get(chainId);
    if (!e) throw new Error(`the relay has no lane end on chain ${chainId}`);
    return e;
  }

  private client(end: LaneEnd): PublicClient {
    return createPublicClient({ chain: chainOf(end), transport: http(end.url), pollingInterval: 100 }) as PublicClient;
  }

  /** Every message the source on-ramp sent toward `toChainId` that the
   *  destination off-ramp has NOT executed yet, oldest first. */
  async pending(fromChainId: number, toChainId: number): Promise<{ message: RampMessage; sourceTx: Hex }[]> {
    const src = this.end(fromChainId);
    const dst = this.end(toChainId);
    const srcClient = this.client(src);
    const dstClient = this.client(dst);
    const logs = await srcClient.getLogs({ address: src.lane.onRamp, fromBlock: 0n, toBlock: 'latest' });
    const out: { message: RampMessage; sourceTx: Hex }[] = [];
    for (const l of logs) {
      let decoded: { eventName?: string; args?: unknown };
      try {
        decoded = decodeEventLog({ abi: this.onRampAbi, data: l.data, topics: l.topics as never });
      } catch {
        continue;
      }
      if (decoded.eventName !== 'CCIPMessageSent') continue;
      const message = (decoded.args as { message: RampMessage }).message;
      if (message.header.destChainSelector.toString() !== dst.lane.localChainSelector) continue;
      // eslint-disable-next-line no-await-in-loop
      const done = (await dstClient.readContract({
        address: dst.lane.offRamp,
        abi: this.offRampAbi,
        functionName: 'executed',
        args: [message.header.messageId],
      })) as boolean;
      if (!done) out.push({ message, sourceTx: l.transactionHash as Hex });
    }
    return out;
  }

  /**
   * Deliver every pending message from `fromChainId` to `toChainId`, in send
   * order, each in its own destination transaction. A message whose
   * execution reverts (a receiver that refuses it, a pool that refuses the
   * release) throws with the off-ramp's error: on a live lane it would sit
   * failed and manually re-executable, which a scenario must not mistake
   * for a delivery.
   */
  async deliver(fromChainId: number, toChainId: number): Promise<RelayedMessage[]> {
    const dst = this.end(toChainId);
    const dstClient = this.client(dst);
    const account = privateKeyToAccount(this.relayerKey);
    const wallet = createWalletClient({ account, chain: chainOf(dst), transport: http(dst.url), pollingInterval: 100 });
    const delivered: RelayedMessage[] = [];
    for (const { message, sourceTx } of await this.pending(fromChainId, toChainId)) {
      // Simulate first so a refusal surfaces as the destination's own error.
      // eslint-disable-next-line no-await-in-loop
      const { request } = await dstClient.simulateContract({
        account,
        address: dst.lane.offRamp,
        abi: this.offRampAbi,
        functionName: 'execute',
        args: [message],
        gas: 25_000_000n,
      } as never);
      // eslint-disable-next-line no-await-in-loop
      const hash = await wallet.writeContract(request as never);
      // eslint-disable-next-line no-await-in-loop
      const receipt = await dstClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (receipt.status !== 'success') throw new Error(`relay: executing message ${message.header.messageId} on chain ${toChainId} reverted (tx ${hash})`);
      delivered.push({
        messageId: message.header.messageId,
        sequenceNumber: message.header.sequenceNumber,
        sender: message.sender,
        receiver: `0x${message.receiver.slice(-40)}` as Address,
        tokenAmounts: message.tokenAmounts.map((t) => ({ sourcePool: t.sourcePoolAddress, amount: t.amount })),
        sourceTx,
        destinationTx: hash,
      });
    }
    return delivered;
  }
}
