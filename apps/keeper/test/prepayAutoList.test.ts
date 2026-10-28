/**
 * #2984 — the grace auto-list pass: `autoListAtFloorOnGrace` for NFT-collateral
 * loans in their grace window, run against a fake Diamond that applies the
 * contract's own admission rules to each call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { SCAN_WINDOW } from '../src/activeLoanWindow';
import { SEND_RESERVE_MS, STAGE_RESERVE_MS } from '../src/runWindow';
import { ABI, MAX_ATTEMPTS_PER_RUN, autoListOnce, describeReport, listingEvent, notApplicable } from '../src/prepayAutoList';
import type { KeeperContext } from '../src/keeper';

const CHAIN = 84532;
const DIAMOND: Address = '0x00000000000000000000000000000000000000c1';
const KEEPER: Address = '0x00000000000000000000000000000000000000ee';
const HOLDER: Address = '0x00000000000000000000000000000000000000b0';
const NOW = 1_000_000n;
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;

function revert(errorName: string, args: readonly unknown[] = []): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({ abi: ABI, data: encodeErrorResult({ abi: ABI, errorName, args } as never), functionName: 'x' });
}

function logOf(eventName: string, args: Record<string, unknown>): { address: Address; data: Hex; topics: Hex[] } {
  const ev = ABI.find((x) => x.type === 'event' && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as never) as Hex[];
  const plain = ev.inputs.filter((i) => !i.indexed);
  return { address: DIAMOND, topics, data: encodeAbiParameters(plain, plain.map((i) => args[i.name!])) };
}

const common = { lister: KEEPER, conduit: DIAMOND, executor: DIAMOND, mode: 0, feeLegs: [] };
const posted = (loanId: bigint, askPrice: bigint) =>
  logOf('PrepayListingPosted', { ...common, loanId, orderHash: ZERO_HASH, askPrice, conduitKey: ZERO_HASH, salt: 0n, endAskPrice: askPrice, auctionEndTime: 0n });
const updated = (loanId: bigint, newAskPrice: bigint) =>
  logOf('PrepayListingUpdated', {
    ...common,
    loanId,
    oldOrderHash: ZERO_HASH,
    newOrderHash: ZERO_HASH,
    newAskPrice,
    newConduitKey: ZERO_HASH,
    newSalt: 0n,
    newEndAskPrice: newAskPrice,
    newAuctionEndTime: 0n,
  });

interface Loan {
  status: number;
  assetType: number;
  collateralAssetType: number;
  allowsPrepayListing: boolean;
  maturity: bigint;
  graceEnd: bigint;
  optedOut: boolean;
  holder: Address;
  sanctioned: boolean;
  /** The listed ask, or null with none up. */
  ask: bigint | null;
  floor: bigint;
}

const inGraceLoan = (over: Partial<Loan> = {}): Loan => ({
  status: 0,
  assetType: 0,
  collateralAssetType: 1,
  allowsPrepayListing: true,
  maturity: NOW - 60n,
  graceEnd: NOW + 3600n,
  optedOut: false,
  holder: HOLDER,
  sanctioned: false,
  ask: null,
  floor: 1000n,
  ...over,
});

class FakeDiamond {
  chainServed = CHAIN;
  now = NOW;
  paused = false;
  enabled = true;
  bufferBps = 500n;
  loans = new Map<bigint, Loan>();
  sent: bigint[] = [];
  lastLogs: ReturnType<typeof logOf>[] = [];
  /** A read that fails, by function name. */
  failing = new Set<string>();

  readContract = async ({ functionName, args = [] }: { functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
    if (this.failing.has(functionName)) throw new Error(`${functionName} unavailable`);
    const a = args as readonly any[];
    switch (functionName) {
      case 'getPrepayListingEnabled':
        return this.enabled;
      case 'getPrepayListingBufferBps':
        return this.bufferBps;
      case 'getActiveLoansCount':
        return BigInt([...this.loans.values()].filter((l) => l.status === 0).length);
      case 'getActiveLoansPaginated': {
        const ids = [...this.loans].filter(([, l]) => l.status === 0).map(([id]) => id);
        return ids.slice(Number(a[0]), Number(a[0]) + Number(a[1]));
      }
      case 'getLoanDeadlines': {
        const l = this.loans.get(a[0])!;
        return [l.maturity, 0n, l.maturity, l.graceEnd];
      }
      case 'getLoanDetails': {
        const l = this.loans.get(a[0])!;
        return { status: l.status, assetType: l.assetType, collateralAssetType: l.collateralAssetType, allowsPrepayListing: l.allowsPrepayListing };
      }
      case 'getPrepayListingAutoListOptedOut':
        return this.loans.get(a[0])!.optedOut;
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };

  multicall = async ({ contracts }: { contracts: { functionName: string; args?: readonly unknown[] }[] }) =>
    Promise.all(
      contracts.map(async (c) => {
        try {
          return { status: 'success' as const, result: await this.readContract(c) };
        } catch (error) {
          return { status: 'failure' as const, error };
        }
      }),
    );

  /** The contract's order of checks, in the parts the pass can meet. */
  private admit(loanId: bigint, caller: Address): () => void {
    if (this.paused) throw revert('EnforcedPause');
    const l = this.loans.get(loanId)!;
    if (l.status !== 0) throw revert('PrepayLoanNotActive', [loanId, l.status]);
    if (!this.enabled) throw revert('PrepayListingDisabled');
    if (l.optedOut) throw revert('AutoListBorrowerOptedOut', [loanId]);
    if (this.now < l.maturity) throw revert('GraceNotStarted', [loanId, this.now, l.maturity]);
    if (this.now >= l.graceEnd) throw revert('GraceExpired', [loanId, this.now, l.graceEnd]);
    if (caller === l.holder) throw revert('NotEligibleAutoLister', [caller]);
    if (l.sanctioned) throw revert('BorrowerSanctioned', [loanId, l.holder]);
    if (l.ask !== null && l.ask <= l.floor) throw revert('AutoListAlreadyAtOrBelowFloor', [loanId]);
    return () => {
      this.lastLogs = [l.ask === null ? posted(loanId, l.floor) : updated(loanId, l.floor)];
      l.ask = l.floor;
    };
  }

  simulateContract = async ({ args, account }: { args: readonly unknown[]; account: { address: Address } }) => {
    this.admit(args[0] as bigint, account.address);
    return { result: undefined };
  };

  getChainId = async () => this.chainServed;
  getBlockNumber = async () => 120n;
  getBlock = async () => ({ number: 120n, timestamp: this.now });
  getTransactionCount = async () => 7;
  waitForTransactionReceipt = async () => ({ status: 'success', logs: this.lastLogs, blockNumber: 121n });

  client(): PublicClient {
    return this as unknown as PublicClient;
  }

  ctx(keeper: Address = KEEPER): KeeperContext {
    return {
      client: this.client(),
      diamond: DIAMOND,
      chainId: CHAIN,
      notAfterMs: Number.POSITIVE_INFINITY,
      wallet: {
        account: { address: keeper },
        writeContract: async ({ args }: { args: readonly unknown[] }) => {
          this.admit(args[0] as bigint, keeper)();
          this.sent.push(args[0] as bigint);
          return `0x${'1'.repeat(64)}`;
        },
      },
    } as unknown as KeeperContext;
  }
}

describe('notApplicable', () => {
  it('rules out what the contract refuses for the whole grace window, and nothing else', () => {
    const base = { status: 0, assetType: 0, collateralAssetType: 1, allowsPrepayListing: true };
    expect(notApplicable(base, false)).toBeNull();
    expect(notApplicable({ ...base, collateralAssetType: 2 }, false), 'an ERC-1155 is an NFT').toBeNull();
    expect(notApplicable({ ...base, status: 1 }, false)).toBe('no longer active');
    expect(notApplicable({ ...base, allowsPrepayListing: false }, false)).toBe('its terms do not allow a prepay listing');
    expect(notApplicable({ ...base, collateralAssetType: 0 }, false)).toBe('its collateral is not an NFT');
    expect(notApplicable({ ...base, assetType: 1 }, false)).toBe('its principal is not an ERC-20');
    expect(notApplicable(base, true)).toBe('the borrower opted out of auto-listing');
  });
});

describe('listingEvent', () => {
  it('reads the ask from the Diamond\'s own event for this loan only', () => {
    expect(listingEvent(DIAMOND, 1n, [posted(1n, 900n)])).toEqual({ kind: 'posted', ask: 900n });
    expect(listingEvent(DIAMOND, 1n, [updated(1n, 800n)])).toEqual({ kind: 'rotated', ask: 800n });
    expect(listingEvent(DIAMOND, 1n, [posted(2n, 900n)]), 'another loan').toBeNull();
    expect(listingEvent(DIAMOND, 1n, [{ ...posted(1n, 900n), address: KEEPER }]), 'another contract').toBeNull();
  });
});

describe('a run', () => {
  let d: FakeDiamond;

  beforeEach(() => {
    d = new FakeDiamond();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const run = (opts: { keeper?: Address; visit?: number; sendDeadline?: number } = {}) =>
    autoListOnce(CHAIN, DIAMOND, {
      client: d.client(),
      readClient: d.client(),
      context: () => d.ctx(opts.keeper),
      sendDeadline: opts.sendDeadline ?? Number.POSITIVE_INFINITY,
      visit: opts.visit ?? 0,
    });

  it('posts a floor listing for an in-grace NFT loan with none up, and rotates one above the floor', async () => {
    d.loans.set(1n, inGraceLoan());
    d.loans.set(2n, inGraceLoan({ ask: 5000n, floor: 1200n }));
    const r = await run();
    expect(d.sent).toEqual([1n, 2n]);
    expect(r.posted).toEqual([{ loanId: 1n, ask: 1000n }]);
    expect(r.rotated).toEqual([{ loanId: 2n, ask: 1200n }]);
    expect(r.inGrace).toBe(2);
    expect(describeReport(r)).toContain('posted=1@1000 rotated=2@1200');
  });

  it('leaves loans before maturity and past grace alone, without a simulation', async () => {
    d.loans.set(1n, inGraceLoan({ maturity: NOW + 10n, graceEnd: NOW + 3610n }));
    d.loans.set(2n, inGraceLoan({ maturity: NOW - 3700n, graceEnd: NOW - 100n }));
    d.loans.set(3n, inGraceLoan({ maturity: NOW, graceEnd: NOW + 3600n }));
    const simulate = vi.spyOn(d, 'simulateContract');
    const r = await run();
    expect(r.inGrace, 'maturity is the first second of grace').toBe(1);
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(d.sent).toEqual([3n]);
  });

  it('names in-grace loans the call cannot apply to, and sends nothing for them', async () => {
    d.loans.set(1n, inGraceLoan({ collateralAssetType: 0 }));
    d.loans.set(2n, inGraceLoan({ optedOut: true }));
    d.loans.set(3n, inGraceLoan({ allowsPrepayListing: false }));
    const r = await run();
    expect(d.sent).toEqual([]);
    expect(r.notApplicable).toEqual([
      'loan 1: its collateral is not an NFT',
      'loan 2: the borrower opted out of auto-listing',
      'loan 3: its terms do not allow a prepay listing',
    ]);
  });

  it('names the contract\'s loan refusals and keeps going; they are not the run\'s refusals', async () => {
    d.loans.set(1n, inGraceLoan({ ask: 1000n })); // already at the floor
    d.loans.set(2n, inGraceLoan({ sanctioned: true }));
    d.loans.set(3n, inGraceLoan({ holder: KEEPER }));
    d.loans.set(4n, inGraceLoan());
    const r = await run();
    expect(d.sent).toEqual([4n]);
    expect(r.declined).toEqual([
      'loan 1: already listed at or below the floor, on live legs',
      'loan 2: the borrower-position holder is sanctioned, so no sale surplus may go to them',
      'loan 3: this keeper holds the borrower position, so the auto-list is not its call',
    ]);
    expect(r.refused.size).toBe(0);
    expect(r.stopped).toBeNull();
  });

  it('records a deployment refusal as the run\'s, for an operator', async () => {
    d.loans.set(1n, inGraceLoan());
    vi.spyOn(d, 'simulateContract').mockRejectedValue(revert('ExecutorNotSet'));
    const r = await run();
    expect(d.sent).toEqual([]);
    expect(r.declined).toEqual([]);
    expect(r.refused.size).toBe(1);
    expect(describeReport(r)).toContain('ExecutorNotSet');
  });

  it('stops the chain\'s run on a pause', async () => {
    d.loans.set(1n, inGraceLoan());
    d.loans.set(2n, inGraceLoan());
    d.paused = true;
    const simulate = vi.spyOn(d, 'simulateContract');
    const r = await run();
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(r.stopped).not.toBeNull();
  });

  it('takes at most MAX_ATTEMPTS_PER_RUN loans a run, and successive runs take the rest', async () => {
    const n = MAX_ATTEMPTS_PER_RUN + 3;
    for (let i = 1; i <= n; i += 1) d.loans.set(BigInt(i), inGraceLoan());
    const first = await run({ visit: 0 });
    expect(d.sent).toHaveLength(MAX_ATTEMPTS_PER_RUN);
    expect(first.deferred).toBe(3);
    await run({ visit: 1 });
    expect(new Set(d.sent).size, 'every loan listed across the two runs').toBe(n);
  });

  it('rotates a window\'s candidates by visits to that window, so a multi-window book reaches every one', async () => {
    // Two windows. Window 0 holds 2 × MAX_ATTEMPTS_PER_RUN loans in grace;
    // window 1 holds only loans before maturity. Window 0 is visited on
    // visits 0 and 2. Rotating by the global visit would take the same batch
    // on both (offset 0 and 2 × width ≡ 0), and the second half never.
    const n = MAX_ATTEMPTS_PER_RUN * 2;
    for (let i = 1; i <= SCAN_WINDOW * 2; i += 1) {
      d.loans.set(BigInt(i), i <= n ? inGraceLoan() : inGraceLoan({ maturity: NOW + 60n }));
    }
    const first = await run({ visit: 0 });
    expect(first.window).toEqual({ index: 0, count: 2, total: SCAN_WINDOW * 2, round: 0 });
    expect(d.sent).toHaveLength(MAX_ATTEMPTS_PER_RUN);
    const other = await run({ visit: 1 });
    expect(other.window?.index).toBe(1);
    expect(other.inGrace).toBe(0);
    const again = await run({ visit: 2 });
    expect(again.window).toEqual({ index: 0, count: 2, total: SCAN_WINDOW * 2, round: 1 });
    expect(new Set(d.sent).size, 'every in-grace loan of window 0 across its two visits').toBe(n);
  });

  it('stops its reads early enough to leave the sends their reserve', async () => {
    d.loans.set(1n, inGraceLoan());
    // Inside the send reserve plus the two stage reserves: the scan must not
    // start, so no read eats the time the send needs.
    const r = await run({ sendDeadline: Date.now() + SEND_RESERVE_MS + 2 * STAGE_RESERVE_MS - 1_000 });
    expect(d.sent).toEqual([]);
    expect(r.unread.get('run')).toContain('run deadline');
    // With the reserves clear, the same loan is listed.
    await run({ sendDeadline: Date.now() + SEND_RESERVE_MS + 2 * STAGE_RESERVE_MS + 60_000 });
    expect(d.sent).toEqual([1n]);
  });

  it('says why nothing can be listed when listings are off or no buffer is set', async () => {
    d.loans.set(1n, inGraceLoan());
    d.enabled = false;
    expect((await run()).skipped).toContain('disabled');
    d.enabled = true;
    d.bufferBps = 0n;
    expect((await run()).skipped).toContain('buffer is not configured');
    expect(d.sent).toEqual([]);
  });

  it('works a chain only when the RPC answers for it', async () => {
    d.loans.set(1n, inGraceLoan());
    d.chainServed = 1;
    const r = await run();
    expect(r.skipped).toContain('serves chain 1');
    expect(d.sent).toEqual([]);
  });

  it('states a loan whose record it could not read, and still lists the rest', async () => {
    d.loans.set(1n, inGraceLoan());
    d.failing.add('getPrepayListingAutoListOptedOut');
    const r = await run();
    expect(d.sent).toEqual([]);
    expect(describeReport(r)).toContain('unread=autoList:1(its loan record or opt-out flag)');
  });
});
