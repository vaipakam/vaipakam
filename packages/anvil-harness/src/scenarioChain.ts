/**
 * One scenario's chain, and the operations a scenario drives on it.
 *
 * A {@link ScenarioChain} wraps a node a suite started from its fixture's
 * dumped state, so every scenario starts from the same deployment and no
 * scenario sees another's transactions or time travel. It carries:
 *
 *   - clients for the node and wallets for the parties, each an Anvil
 *     well-known dev account (funded at genesis on every Anvil node) or the
 *     fixture's own ephemeral admin;
 *   - the CLOCK. Moving chain time is {@link ScenarioChain.warp}. A suite
 *     whose code under test reads the process clock as well (the keeper reads
 *     `Date.now()` for every age it judges) passes a {@link ClockPin}, and the
 *     chain pins that clock to the new head after every move. A suite that
 *     drives only contracts passes none, and the process clock stays real.
 *
 * Nothing here composes a protocol call a party would not make: writes go
 * through the compiled Diamond ABI and are simulated before they are sent, so
 * a revert surfaces as the contract's own error.
 *
 * Shared by the keeper's Anvil scenarios (`apps/keeper/e2e`) and the
 * protocol's (`packages/protocol-e2e`, #848).
 */
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import type { SpawnedAnvil } from './process';
import { explainMinedRevert } from './minedRevert';
import { ANVIL_DEV_KEYS } from './devKeys';

export type Party = keyof typeof ANVIL_DEV_KEYS | 'admin';

/** A minimal ERC-20 + WETH9 surface (approve / balance / mint / deposit). */
export const TOKEN_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 't', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 't', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
] as const satisfies Abi;

export interface DecodedEvent {
  eventName: string;
  args: Record<string, unknown>;
  transactionHash: Hex;
  blockNumber: bigint;
}

/**
 * What a scenario chain needs of the fixture that built it. Every fixture a
 * suite publishes carries one of these per chain.
 */
export interface ChainFixture {
  diamond: Address;
  adminKey: Hex;
  /** Every address the chain's artifact records (mocks under `testnetMocks`). */
  artifact: Record<string, unknown>;
  rewards: { interactionLaunchTimestamp: number };
}

/**
 * A process clock a suite keeps in step with the chain head (see the
 * header). `pin` is called with the head's unix timestamp after every clock
 * move; `release` when the chain stops.
 */
export interface ClockPin {
  pin(unixSeconds: number): void;
  release(): void;
}

export interface ScenarioChainOptions {
  /** The chain's display name in viem errors. */
  name?: string;
  /** The process clock to keep in step with the head, if any. */
  clock?: ClockPin;
}

export class ScenarioChain<F extends ChainFixture = ChainFixture> {
  readonly chain: Chain;
  readonly pub: PublicClient;
  readonly diamond: Address;
  private readonly accounts: Record<Party, Account>;
  private readonly clock?: ClockPin;

  constructor(
    readonly node: SpawnedAnvil,
    readonly fixture: F,
    chainId: number,
    opts: ScenarioChainOptions = {},
  ) {
    this.chain = {
      id: chainId,
      name: opts.name ?? `e2e-${chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [node.url] } },
    };
    this.clock = opts.clock;
    // A local node mines on demand: poll receipts fast, not at viem's 4s default.
    this.pub = createPublicClient({ chain: this.chain, transport: http(node.url), pollingInterval: 100 }) as PublicClient;
    this.diamond = fixture.diamond;
    this.accounts = {
      lender: privateKeyToAccount(ANVIL_DEV_KEYS.lender),
      borrower: privateKeyToAccount(ANVIL_DEV_KEYS.borrower),
      keeper: privateKeyToAccount(ANVIL_DEV_KEYS.keeper),
      other: privateKeyToAccount(ANVIL_DEV_KEYS.other),
      admin: privateKeyToAccount(fixture.adminKey),
    };
  }

  get url(): string {
    return this.node.url;
  }

  address(who: Party): Address {
    return this.accounts[who].address;
  }

  wallet(who: Party): WalletClient {
    return createWalletClient({ account: this.accounts[who], chain: this.chain, transport: http(this.node.url), pollingInterval: 100 });
  }

  /** Send a contract write as `who` and require it to land; returns the receipt. */
  async write(
    who: Party,
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
    value?: bigint,
  ): Promise<TransactionReceipt> {
    const w = this.wallet(who);
    // The head the simulation runs against, so a mined revert can say how
    // far the chain moved in between (#2892).
    const simulatedAt = await this.blockNumber();
    // Simulate first, so a revert surfaces as the contract's own error.
    const { request } = await this.pub.simulateContract({
      account: this.accounts[who],
      address,
      abi,
      functionName,
      args,
      value,
    } as never);
    const hash = await w.writeContract(request as never);
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== 'success') {
      // It simulated clean and reverted only when mined, so the simulation's
      // error never surfaced. Read the cause from the node before it is gone.
      const why = await explainMinedRevert(this.pub, this.node.control.rpc, receipt, [abi, DIAMOND_ABI_VIEM as Abi]);
      throw new Error(`${functionName} reverted when mined (tx ${hash}, simulated against block ${simulatedAt}): ${why}`);
    }
    return receipt;
  }

  /** A Diamond write as `who`. */
  diamondWrite(who: Party, functionName: string, args: readonly unknown[] = [], value?: bigint): Promise<TransactionReceipt> {
    return this.write(who, this.diamond, DIAMOND_ABI_VIEM, functionName, args, value);
  }

  /** A Diamond read. */
  read<T = unknown>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.pub.readContract({ address: this.diamond, abi: DIAMOND_ABI_VIEM, functionName, args } as never) as Promise<T>;
  }

  /** The Diamond's events in `logs`, decoded by the compiled Diamond ABI. */
  decodeDiamondLogs(logs: readonly Log[]): DecodedEvent[] {
    const out: DecodedEvent[] = [];
    for (const l of logs) {
      if (l.address.toLowerCase() !== this.diamond.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: DIAMOND_ABI_VIEM, data: l.data, topics: l.topics as never, strict: false });
        out.push({
          eventName: String(ev.eventName),
          args: (ev.args ?? {}) as Record<string, unknown>,
          transactionHash: l.transactionHash as Hex,
          blockNumber: l.blockNumber as bigint,
        });
      } catch {
        /* an event the union does not carry — not one a scenario asserts */
      }
    }
    return out;
  }

  /** Every Diamond event named `eventName` in blocks [fromBlock, latest]. */
  async diamondEvents(eventName: string, fromBlock: bigint): Promise<DecodedEvent[]> {
    const logs = await this.pub.getLogs({ address: this.diamond, fromBlock, toBlock: 'latest' });
    return this.decodeDiamondLogs(logs).filter((e) => e.eventName === eventName);
  }

  async blockNumber(): Promise<bigint> {
    // Never viem's cached head: a scenario reads the head just before and
    // just after an action, often inside one polling interval.
    return this.pub.getBlockNumber({ cacheTime: 0 });
  }

  async now(): Promise<number> {
    return this.node.control.latestTimestamp();
  }

  /**
   * Move chain time forward by `seconds`, mine, and pin the suite's clock (if
   * any) to the new head. Returns the new head's timestamp.
   */
  async warp(seconds: number): Promise<number> {
    if (seconds > 0) await this.node.control.increaseTime(seconds);
    return this.syncClock();
  }

  /** Mine the next block at exactly `unixSeconds`, then pin the clock to it. */
  async mineAt(unixSeconds: number): Promise<void> {
    await this.node.control.rpc('evm_setNextBlockTimestamp', [`0x${unixSeconds.toString(16)}`]);
    await this.mineBlocks(1);
    this.clock?.pin(unixSeconds);
  }

  /**
   * Mine `n` empty blocks in one call. A live chain keeps producing blocks;
   * this node mines only on demand, so a scenario whose reader looks a fixed
   * depth behind the head mines past that depth before reading.
   */
  async mineBlocks(n: number): Promise<void> {
    await this.node.control.rpc('anvil_mine', [`0x${n.toString(16)}`]);
  }

  /** Pin the suite's clock (if any) to the chain head; returns the head's timestamp. */
  async syncClock(): Promise<number> {
    const ts = await this.now();
    this.clock?.pin(ts);
    return ts;
  }

  /** The reward day the chain is in (`InteractionRewardsFacet` day index). */
  async rewardDay(): Promise<number> {
    const launch = this.fixture.rewards.interactionLaunchTimestamp;
    return Math.floor(((await this.now()) - launch) / 86_400);
  }

  async stop(): Promise<void> {
    this.clock?.release();
    await this.node.stop();
  }
}

