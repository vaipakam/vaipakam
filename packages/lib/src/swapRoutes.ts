/**
 * Swap-route building for forced closes — the ONE place that knows how a
 * try-list for `LibSwap.swapWithFailover` is put together.
 *
 * A liquid forced close (`DefaultedFacet.triggerDefault`, and the HF
 * liquidation paths) takes a caller-ranked `AdapterCall[]`: each entry
 * names a registered swap adapter BY ITS INDEX in the Diamond's
 * `swapAdapters` array and carries that venue's own encoded data. The
 * contract enforces the oracle-derived minimum output on every attempt,
 * so a try-list cannot make a sale worse than the protocol allows; what a
 * try-list CAN get wrong is the wiring — an index that points at a
 * different adapter than the calldata was packed for, or a packing the
 * adapter cannot decode. Both are silent until a close-out fails.
 *
 * So this module holds every rule a builder needs and none of the I/O
 * choices that differ between builders (the app reaches aggregators
 * through the agent's key-holding proxy; a Worker can call them
 * directly):
 *
 *  - **Indexes come from the chain.** {@link resolveAdapterRoster} maps
 *    each venue kind to its position in `getSwapAdapters()`, identified by
 *    the adapter's own `adapterName()`, skipping governance-disabled
 *    entries. A hand-kept index table is correct until governance adds,
 *    removes or reorders an adapter, and then it is wrong without any
 *    signal (#2468).
 *  - **One wire format per venue.** The packers below match the on-chain
 *    decoders (`AggregatorAdapterBase`, `UniV3Adapter`, `BalancerV2Adapter`).
 *  - **One parser per aggregator response**, so a field rename upstream is
 *    fixed once.
 *  - **One ranking rule.** Best quoted output first; a venue that cannot
 *    quote ahead of time goes last rather than being guessed at. The
 *    testnet mock is not such a venue: {@link quoteTestnetMock} reads the
 *    state its `execute` depends on and quotes it like any other.
 *
 * Framework-agnostic: viem only, no browser or Worker globals.
 */
import {
  encodeAbiParameters,
  encodeFunctionData,
  decodeFunctionResult,
  isAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

/** The venues a try-list can contain. */
export type SwapVenueKind =
  | 'zeroex'
  | 'oneinch'
  | 'univ3'
  | 'balancerv2'
  /** The testnet `MockSwapAdapter`. Recognised ONLY at the address the
   *  chain's deployment record declares for it — see
   *  {@link resolveAdapterRoster}. */
  | 'testnetMock';

/** `adapterName()` of each production adapter in `contracts/src/adapters/`.
 *  The testnet mock is deliberately absent: its name is a constructor
 *  argument, so a name match would recognise any contract that chose to
 *  call itself that. */
export const ADAPTER_NAME_KIND: Readonly<Record<string, SwapVenueKind>> = {
  ZeroEx: 'zeroex',
  OneInch: 'oneinch',
  UniswapV3: 'univ3',
  BalancerV2: 'balancerv2',
};

/** One entry of the Diamond's adapter list, as read from the chain. */
export interface SwapAdapterEntry {
  address: Address;
  /** `adapterName()`, or `undefined` when the read failed. */
  name: string | undefined;
  /** `AdminFacet.isSwapAdapterDisabled`, or `undefined` when unread. */
  disabled: boolean | undefined;
}

/** Where one venue sits in the Diamond's adapter list. */
export interface RosterSlot {
  /** Index into the Diamond's `swapAdapters` array — what `AdapterCall`
   *  carries. */
  idx: number;
  /** The adapter contract itself. For an aggregator venue this is the
   *  0x / 1inch TAKER: the adapter, not the Diamond, holds the input and
   *  calls the swap target, so a quote made for any other address is
   *  calldata for the wrong caller. */
  address: Address;
}

/** Venue kind → its slot in the Diamond's adapter list. */
export type AdapterRoster = Partial<Record<SwapVenueKind, RosterSlot>>;

/**
 * Work out which index each venue sits at.
 *
 * An entry is used only when its disabled flag was READ and is false: a
 * failed read is not evidence that the venue is enabled, and putting a
 * disabled venue on the list only spends an attempt the contract skips.
 * When two enabled adapters share a kind, the earlier one wins — the
 * Diamond's order is governance's priority order.
 *
 * `testnetMockAdapter` is the chain deployment's declared
 * `testnetMocks.mockSwapAdapter`, or `undefined` on any chain without
 * one (every mainnet). Only an adapter at exactly that address is
 * treated as the mock, whatever it calls itself.
 */
export function resolveAdapterRoster(
  entries: readonly SwapAdapterEntry[],
  opts: { testnetMockAdapter?: Address } = {},
): AdapterRoster {
  const roster: AdapterRoster = {};
  const mock = opts.testnetMockAdapter?.toLowerCase();
  entries.forEach((entry, idx) => {
    if (entry.disabled !== false) return;
    const kind: SwapVenueKind | undefined =
      mock !== undefined && entry.address.toLowerCase() === mock
        ? 'testnetMock'
        : entry.name === undefined
          ? undefined
          : ADAPTER_NAME_KIND[entry.name];
    if (kind === undefined || roster[kind] !== undefined) return;
    roster[kind] = { idx, address: entry.address };
  });
  return roster;
}

const ADAPTER_LIST_ABI = [
  {
    type: 'function',
    name: 'getSwapAdapters',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'adapters', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'isSwapAdapterDisabled',
    stateMutability: 'view',
    inputs: [{ name: 'adapter', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

const ADAPTER_NAME_ABI = [
  {
    type: 'function',
    name: 'adapterName',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

/**
 * Read the Diamond's adapter list with each entry's name and disabled
 * flag. A failure on the LIST read throws — there is no roster without
 * it. A failure on one entry's name or flag leaves that field
 * `undefined`, which {@link resolveAdapterRoster} treats as unusable
 * rather than guessing.
 */
export async function readSwapAdapterEntries(
  client: Pick<PublicClient, 'readContract'>,
  diamond: Address,
): Promise<SwapAdapterEntry[]> {
  const addresses = (await client.readContract({
    address: diamond,
    abi: ADAPTER_LIST_ABI,
    functionName: 'getSwapAdapters',
  })) as readonly Address[];
  return Promise.all(
    addresses.map(async (address) => {
      const [name, disabled] = await Promise.all([
        client
          .readContract({ address, abi: ADAPTER_NAME_ABI, functionName: 'adapterName' })
          .then((v) => v as string)
          .catch(() => undefined),
        client
          .readContract({
            address: diamond,
            abi: ADAPTER_LIST_ABI,
            functionName: 'isSwapAdapterDisabled',
            args: [address],
          })
          .then((v) => v as boolean)
          .catch(() => undefined),
      ]);
      return { address, name, disabled };
    }),
  );
}

// ─── Wire formats (must match the on-chain decoders) ────────────────────

/** `AggregatorAdapterBase` decodes `(address swapTarget, bytes swapCalldata)`.
 *  The adapter checks `swapTarget` against its owner-managed allowlist
 *  before forwarding, so the target is carried rather than assumed. */
export function packAggregatorData(swapTarget: Address, swapCalldata: Hex): Hex {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes' }],
    [swapTarget, swapCalldata],
  );
}

/** `UniV3Adapter` decodes the pool fee tier. */
export function packUniV3Data(fee: number): Hex {
  return encodeAbiParameters([{ type: 'uint24' }], [fee]);
}

/** `BalancerV2Adapter` decodes the pool id. */
export function packBalancerV2Data(poolId: Hex): Hex {
  return encodeAbiParameters([{ type: 'bytes32' }], [poolId]);
}

/** The testnet mock ignores its adapter data. */
export const TESTNET_MOCK_DATA: Hex = '0x';

// ─── Aggregator responses ───────────────────────────────────────────────

/** What a builder needs from one aggregator quote. */
export interface AggregatorQuote {
  swapTarget: Address;
  swapCalldata: Hex;
  expectedOutput: bigint;
}

const DECIMAL_INT = /^[0-9]{1,78}$/;

function hexData(v: unknown): Hex | null {
  return typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(v) && v.length > 2
    ? (v as Hex)
    : null;
}

function quote(to: unknown, data: unknown, out: unknown): AggregatorQuote | null {
  const swapCalldata = hexData(data);
  if (typeof to !== 'string' || !isAddress(to, { strict: false })) return null;
  if (!swapCalldata) return null;
  if (typeof out !== 'string' || !DECIMAL_INT.test(out)) return null;
  const expectedOutput = BigInt(out);
  if (expectedOutput === 0n) return null;
  return { swapTarget: to as Address, swapCalldata, expectedOutput };
}

/** A 0x v2 (allowance-holder) quote body: `transaction.{to,data}` and
 *  `buyAmount`. `null` for anything else, including an error body. */
export function parseZeroExQuote(body: unknown): AggregatorQuote | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as { transaction?: { to?: unknown; data?: unknown }; buyAmount?: unknown };
  return quote(b.transaction?.to, b.transaction?.data, b.buyAmount);
}

/** A 1inch v6 swap body: `tx.{to,data}` and `dstAmount` (older bodies
 *  call it `toAmount`). `null` for anything else. */
export function parseOneInchQuote(body: unknown): AggregatorQuote | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as {
    tx?: { to?: unknown; data?: unknown };
    dstAmount?: unknown;
    toAmount?: unknown;
  };
  return quote(b.tx?.to, b.tx?.data, b.dstAmount ?? b.toAmount);
}

// ─── Uniswap V3 (and V3 forks) — quoted on-chain ────────────────────────

/** Per-chain V3 QuoterV2 and the fee tiers worth asking it about.
 *  Venue facts only — WHERE the UniV3 adapter sits in the Diamond's list
 *  comes from {@link resolveAdapterRoster}, never from here. */
export interface UniV3Venue {
  quoter: Address;
  feeTiers: readonly number[];
}

const UNISWAP_FEE_TIERS = [100, 500, 3000, 10000] as const;
/** PancakeSwap V3 uses 0.25% where Uniswap uses 0.3%. */
const PANCAKE_FEE_TIERS = [100, 500, 2500, 10000] as const;

export const UNIV3_VENUES: Readonly<Record<number, UniV3Venue>> = {
  1: { quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', feeTiers: UNISWAP_FEE_TIERS },
  8453: { quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', feeTiers: UNISWAP_FEE_TIERS },
  42161: { quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', feeTiers: UNISWAP_FEE_TIERS },
  10: { quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', feeTiers: UNISWAP_FEE_TIERS },
  // BNB testnet routes through PancakeSwap V3 (factory-matched to the
  // oracle's UNISWAP_V3_FACTORY on that chain).
  97: { quoter: '0xbC203d7f83677c7ed3F7acEc959963E7F4ECC5C2', feeTiers: PANCAKE_FEE_TIERS },
};

const QUOTER_V2_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

/** The best fee tier the chain's V3 quoter reports for this sale, or
 *  `null` when the chain has no venue or no tier quotes. QuoterV2 is
 *  non-view (it reverts internally to return), hence `call`. */
export async function quoteUniV3(
  client: Pick<PublicClient, 'call'>,
  chainId: number,
  sale: { sellToken: Address; buyToken: Address; sellAmount: bigint },
): Promise<{ fee: number; expectedOutput: bigint } | null> {
  const venue = UNIV3_VENUES[chainId];
  if (!venue) return null;
  let best: { fee: number; expectedOutput: bigint } | null = null;
  for (const fee of venue.feeTiers) {
    try {
      const data = encodeFunctionData({
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn: sale.sellToken,
            tokenOut: sale.buyToken,
            amountIn: sale.sellAmount,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      const result = await client.call({ to: venue.quoter, data });
      if (!result.data) continue;
      const [amountOut] = decodeFunctionResult({
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle',
        data: result.data,
      });
      if (amountOut > 0n && (!best || amountOut > best.expectedOutput)) {
        best = { fee, expectedOutput: amountOut };
      }
    } catch {
      continue;
    }
  }
  return best;
}

const TESTNET_MOCK_ABI = [
  { type: 'function', name: 'shouldRevert', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'restrictedTo', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'outputMultiplierBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'tokenUsdPrice8',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/**
 * What the testnet mock adapter would pay for this sale, or `null` when it
 * would not pay at all.
 *
 * The mock has no market: `execute` pays `sellAmount × priceIn / priceOut
 * × multiplier` (flat `sellAmount × multiplier` when either price is
 * unset) out of its OWN balance, and reverts when it is switched to
 * revert or called by anyone but its `restrictedTo`. Each of those is
 * readable, so this reads them rather than sending the mock on hope — a
 * mock that would revert or that cannot cover the payout is not a route,
 * and offering it would hand the lender a close-out that drops into the
 * full-collateral fallback while the card said a sale was coming.
 *
 * `caller` is the address that will call `execute` — the Diamond. Any
 * failed read means `null`: an unread mock is not evidence of a working
 * one.
 */
export async function quoteTestnetMock(
  client: Pick<PublicClient, 'readContract'>,
  mock: Address,
  caller: Address,
  sale: { sellToken: Address; buyToken: Address; sellAmount: bigint },
): Promise<bigint | null> {
  try {
    const at = { address: mock, abi: TESTNET_MOCK_ABI } as const;
    const [shouldRevert, restrictedTo, bps, pIn, pOut, balance] = await Promise.all([
      client.readContract({ ...at, functionName: 'shouldRevert' }),
      client.readContract({ ...at, functionName: 'restrictedTo' }),
      client.readContract({ ...at, functionName: 'outputMultiplierBps' }),
      client.readContract({ ...at, functionName: 'tokenUsdPrice8', args: [sale.sellToken] }),
      client.readContract({ ...at, functionName: 'tokenUsdPrice8', args: [sale.buyToken] }),
      client.readContract({
        address: sale.buyToken,
        abi: BALANCE_OF_ABI,
        functionName: 'balanceOf',
        args: [mock],
      }),
    ]);
    if (shouldRevert) return null;
    const zero = '0x0000000000000000000000000000000000000000';
    if (restrictedTo.toLowerCase() !== zero && restrictedTo.toLowerCase() !== caller.toLowerCase()) {
      return null;
    }
    const base = pIn !== 0n && pOut !== 0n ? (sale.sellAmount * pIn) / pOut : sale.sellAmount;
    const out = (base * bps) / 10_000n;
    if (out === 0n || out > balance) return null;
    return out;
  } catch {
    return null;
  }
}

// ─── Ranking ────────────────────────────────────────────────────────────

/** `LibSwap.AdapterCall`. */
export interface AdapterCall {
  adapterIdx: bigint;
  data: Hex;
}

/** One candidate route, before ranking. */
export interface RouteCandidate {
  kind: SwapVenueKind;
  /** The venue's quoted output, or `null` when it cannot quote ahead of
   *  time. Ranking only — the contract's own minimum is what binds. */
  expectedOutput: bigint | null;
  call: AdapterCall;
}

/**
 * Order candidates for the try-list: highest quoted output first, venues
 * that could not quote after every venue that could, ties in input order.
 * The contract tries them in this order and stops at the first that
 * meets its minimum.
 */
export function rankRoutes(candidates: readonly RouteCandidate[]): RouteCandidate[] {
  return candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const x = a.c.expectedOutput;
      const y = b.c.expectedOutput;
      if (x === null && y === null) return a.i - b.i;
      if (x === null) return 1;
      if (y === null) return -1;
      if (x !== y) return x > y ? -1 : 1;
      return a.i - b.i;
    })
    .map(({ c }) => c);
}
