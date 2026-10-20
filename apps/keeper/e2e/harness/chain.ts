/**
 * One scenario's chain, and the operations a scenario drives on it.
 *
 * {@link openScenario} starts a fresh node from the fixture's dumped state
 * (`fixture.ts`), so every scenario starts from the same canonical reward
 * deployment and no scenario sees another's transactions or time travel. It
 * returns:
 *
 *   - clients for the node and wallets for the parties, each an Anvil
 *     well-known dev account (funded at genesis on every Anvil node) or the
 *     fixture's own ephemeral admin;
 *   - the CLOCK: the keeper reads `Date.now()` for every age it judges (an
 *     observation is due, an entry is due, a deadline has passed), so a
 *     scenario that moves chain time must move the keeper's clock with it.
 *     {@link ScenarioChain.warp} does both — it advances anvil, then pins the
 *     process's `Date` (only `Date`: timers and I/O stay real) to the new
 *     head's timestamp.
 *
 * Nothing here signs as the keeper: the keeper signs with its own key, from
 * its own code, through the env the scenario builds (`keeperEnv.ts`).
 */
import { vi } from 'vitest';
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
import type { SpawnedAnvil } from '@vaipakam/anvil-harness/process';
import { E2E_CHAIN_ID, loadFixture, startScenarioChain, type KeeperFixture } from './fixture';

/**
 * Anvil's well-known development keys (the `test test … junk` mnemonic,
 * indices 1–4). Public by design and funded with 10,000 ETH at every Anvil
 * genesis — no secret, and meaningless on any real chain. Index 0 is left
 * alone: nothing here needs it, and leaving it out keeps the scenarios clear
 * of whatever else a developer's local tooling does with it.
 */
export const ANVIL_DEV_KEYS = {
  lender: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  borrower: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  keeper: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  other: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
} as const satisfies Record<string, Hex>;

export type Party = keyof typeof ANVIL_DEV_KEYS | 'admin';

/** A minimal ERC-20 + WETH9 surface (approve / balance / mint / deposit). */
export const TOKEN_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 't', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
] as const satisfies Abi;

/** The overlay's owner-only flag setter (`TestnetSanctionsOverlay`). */
export const OVERLAY_ABI = [
  { type: 'function', name: 'setFlagged', stateMutability: 'nonpayable', inputs: [{ name: 'who', type: 'address' }, { name: 'flagged', type: 'bool' }], outputs: [] },
] as const satisfies Abi;

/** The indexer's settled-head depth fallback (`SAFE_FALLBACK_BUFFER`). */
export const SETTLED_DEPTH = 32;

export interface DecodedEvent {
  eventName: string;
  args: Record<string, unknown>;
  transactionHash: Hex;
  blockNumber: bigint;
}

export class ScenarioChain {
  readonly chain: Chain;
  readonly pub: PublicClient;
  readonly diamond: Address;
  private readonly accounts: Record<Party, Account>;

  constructor(
    readonly node: SpawnedAnvil,
    readonly fixture: KeeperFixture,
  ) {
    this.chain = {
      id: E2E_CHAIN_ID,
      name: 'keeper-e2e',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [node.url] } },
    };
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
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted (tx ${hash})`);
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
    return this.pub.getBlockNumber();
  }

  async now(): Promise<number> {
    return this.node.control.latestTimestamp();
  }

  /**
   * Move chain time forward by `seconds`, mine, and pin the keeper's clock
   * to the new head (see the header). Returns the new head's timestamp.
   */
  async warp(seconds: number): Promise<number> {
    if (seconds > 0) await this.node.control.increaseTime(seconds);
    return this.syncClock();
  }

  /**
   * Mine `n` empty blocks in one call. A live chain keeps producing blocks;
   * this node mines only on demand, so a scenario mines past the indexer's
   * settled-head depth (32 blocks, `apps/indexer/src/settledHead.ts`) before
   * an indexer pass, or the pass would not yet see the latest transactions.
   */
  async mineBlocks(n: number): Promise<void> {
    await this.node.control.rpc('anvil_mine', [`0x${n.toString(16)}`]);
  }

  /** Pin the process's `Date` to the chain head's timestamp. */
  async syncClock(): Promise<number> {
    const ts = await this.now();
    vi.setSystemTime(ts * 1000);
    return ts;
  }

  /** The reward day the chain is in (`InteractionRewardsFacet` day index). */
  async rewardDay(): Promise<number> {
    const launch = this.fixture.rewards.interactionLaunchTimestamp;
    return Math.floor(((await this.now()) - launch) / 86_400);
  }

  async stop(): Promise<void> {
    vi.useRealTimers();
    await this.node.stop();
  }
}

/**
 * Start a scenario: a fresh node from the fixture state, with the process's
 * `Date` faked (and only `Date`) and pinned to the chain head.
 */
export async function openScenario(): Promise<ScenarioChain> {
  const fixture = loadFixture();
  const node = await startScenarioChain();
  const sc = new ScenarioChain(node, fixture);
  // A node started from a dump serves state from the load point on, so a
  // read pinned below it (the indexer's settled head, 32 blocks back) is out
  // of range. Start every scenario clear of that depth.
  await sc.mineBlocks(SETTLED_DEPTH + 8);
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  await sc.syncClock();
  return sc;
}
