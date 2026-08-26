/**
 * A selector-aware JSON-RPC mock, for CPU profiling the keeper's passes
 * off-Cloudflare (#1896).
 *
 * WHY THIS SHAPE. The thing we are trying to measure is CPU, and on a Worker
 * the CPU in an RPC-heavy pass is not the waiting — it is `JSON.parse` of the
 * response plus viem's ABI decode of the result. A mock that returns `0x` for
 * every call would therefore measure almost nothing and rank every pass as
 * free. So every `eth_call` here is answered with a REAL ABI-encoded result
 * for the selector that was asked for, built from the compiled Diamond ABI,
 * with arrays filled to a configurable length. The decode work the pass then
 * does is the same work it does in production.
 *
 * WHAT IT IS NOT. This runs on Node, not workerd. Absolute milliseconds here
 * are not workerd milliseconds — V8 is the same engine but the build, the
 * limits and the I/O model are not. Read the output as a RANKING and as an
 * order-of-magnitude bound, which is what #1896 actually needs: the open
 * question is *which* pass is expensive, and a ranking answers it.
 */
import {
  encodeFunctionResult,
  decodeFunctionData,
  toFunctionSelector,
  type Abi,
  type AbiFunction,
  type AbiParameter,
} from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';

/** How many entries every dynamic array result carries. */
export const ARRAY_LEN = Number(process.env.BENCH_ARRAY_LEN ?? 25);

/** What a count-shaped uint answers — bounds every pagination loop. */
export const COUNT_VALUE = Number(process.env.BENCH_COUNT ?? 50);

/**
 * The fixture's configured chains, mirroring passCpu's RPC_KEYS
 * (Base Sepolia, Arbitrum Sepolia, BNB Testnet). A reward-topology chain-id
 * list (`getExpectedSourceChainIds` etc.) must be these UNIQUE ids, not
 * ARRAY_LEN copies of one — `remitFromCanonical` does not dedupe, so filling
 * the array with one mirror ran its remittance workflow ARRAY_LEN times and
 * reported ARRAY_LEN/ARRAY_LEN for a two-mirror fixture (Codex #1945 r11).
 */
const FIXTURE_CHAIN_IDS = [84532n, 421614n, 97n] as const;

/** What an enum-shaped uint answers — must be IN RANGE or work is discarded. */
export const ENUM_VALUE = Number(process.env.BENCH_ENUM ?? 1);

/**
 * How many FULL pages one selector serves before it starts answering with an
 * empty array. Without this a paginated read is infinite: every page comes
 * back full, so the caller always asks for one more.
 */
export const MAX_PAGES = Number(process.env.BENCH_PAGES ?? 2);

/**
 * Hard ceiling on RPC calls one pass may make before the mock refuses to
 * answer.
 *
 * A timeout cannot fix a runaway loop here: `Promise.race` abandons the
 * waiter, it does not cancel the pass, so a spinning pass keeps burning CPU in
 * the background and the next pass profiles on a loaded machine. Bounding it
 * at the SOURCE is what actually stops it — the mock throws, the pass's own
 * catch unwinds it, and the run continues.
 *
 * Exceeding this is itself a finding, not a harness failure: a pass issuing
 * thousands of calls per tick against three chains is the CPU problem.
 */
export const CALL_BUDGET = Number(process.env.BENCH_CALL_BUDGET ?? 3000);

/**
 * Per-(chain, selector) page counter, reset between passes.
 *
 * Keying on the selector ALONE shared exhaustion across independent chain
 * scans: with MAX_PAGES=2 and three chains, the third chain's FIRST page was
 * served as page 3 and came back empty, so affected passes profiled two
 * chains out of three (Codex #1945 r1).
 */
const pageCounts = new Map<string, number>();
let budgetLeft = CALL_BUDGET;
/** Set when a pass blew the budget, so the runner can report it as unbounded. */
export const budget = { exceeded: false };

export function resetPages(): void {
  pageCounts.clear();
  budgetLeft = CALL_BUDGET;
  budget.exceeded = false;
}

const ADDRESS = '0x1111111111111111111111111111111111111111' as const;
// A loan's asset pair must NOT collide with the generic offer-book asset
// (`ADDRESS`), or preGraceWatcher's viable-lender pre-check finds a match and
// skips the warning before `ownerOf` / dispatch — leaving the notification
// half unmeasured (Codex #1945 r6). `getLoanDetails` is the only reader that
// compares an asset it fetched against the offer book.
const ADDRESS_ALT = '0x2222222222222222222222222222222222222222' as const;
// The pre-grace borrower resolved by `ownerOf` must be a SEEDED subscriber or
// `checkLoan` returns at `subsByWallet.get(...)`. This is `WALLET(0)` from
// bench/d1Stub.ts (`0x…01`), so the seeded `user_thresholds` row is found and
// the throttle / format / state-write path runs (Codex #1945 r6).
const SUBSCRIBER = '0x0000000000000000000000000000000000000001' as const;

/**
 * Multicall3's `aggregate3`, which viem uses for `publicClient.multicall`.
 * It is not on the Diamond ABI, so it needs handling of its own: the inner
 * calldata is unwrapped and each sub-call answered on its own selector, which
 * is what makes a batched read cost realistic decode work rather than one
 * cheap blob.
 */
const MULTICALL3_ABI = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const satisfies Abi;

/**
 * External contracts the passes call that are NOT on the Diamond. The keeper
 * dispatches these to their own `to` address by their own ABI, so a
 * Diamond-only selector map answers them `0x` and the pass silently discards
 * the result: `liquidityConfidence` quotes PancakeSwap/Uniswap V3 through
 * `QuoterV2.quoteExactInputSingle` (not on `DIAMOND_ABI_VIEM`), so every
 * fee-tier quote returned `0x`, viem treated it as failed, and the pass skipped
 * its whole tier state machine rather than profiling its core work
 * (Codex #1945 r3). Answering the selector with a real, coherent quote lets the
 * pass run — the only fixture chain of the three with a configured V3 quoter is
 * BNB Testnet, so without this the pass has no successful route at all.
 */
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
] as const satisfies Abi;

/** selector -> function item, across the Diamond surface plus external ABIs. */
const BY_SELECTOR = new Map<string, AbiFunction>();
for (const abi of [DIAMOND_ABI_VIEM, QUOTER_V2_ABI] as readonly Abi[]) {
  for (const item of abi as readonly AbiFunction[]) {
    if (item.type !== 'function') continue;
    try {
      BY_SELECTOR.set(toFunctionSelector(item), item);
    } catch {
      // Overloads that fail to serialise are not worth aborting the harness for.
    }
  }
}

/**
 * A plausible, correctly-typed value for one ABI output parameter.
 *
 * `fnName` is not decoration: `getActiveLoansCount`'s output is UNNAMED in the
 * ABI, so a parameter-name-only heuristic misses it, answers 1e18, and the
 * caller then walks ~1e16 pages. That is precisely how preGraceWatcher came
 * out at 20,025 calls and 5.9 s and looked like the worst pass in the tree.
 */
function defaultFor(p: AbiParameter, fnName = '', chainKey = ''): unknown {
  const t = p.type;
  if (t.endsWith('[]')) {
    const inner = { ...p, type: t.slice(0, -2) } as AbiParameter;
    return Array.from({ length: ARRAY_LEN }, () => defaultFor(inner, fnName, chainKey));
  }
  const fixed = t.match(/^(.*)\[(\d+)\]$/);
  if (fixed) {
    const inner = { ...p, type: fixed[1] } as AbiParameter;
    return Array.from({ length: Number(fixed[2]) }, () => defaultFor(inner, fnName, chainKey));
  }
  if (t === 'tuple') {
    const comps = (p as { components?: readonly AbiParameter[] }).components ?? [];
    return comps.map((c) => defaultFor(c, fnName, chainKey));
  }
  if (t === 'address') {
    // `ownerOf` resolves the borrower NFT holder; it must be a seeded
    // subscriber so preGraceWatcher's notification half runs (Codex #1945 r6).
    if (/ownerof/i.test(fnName)) return SUBSCRIBER;
    // A loan's own asset pair is deliberately OFF the offer-book asset so the
    // viable-lender pre-check does not skip the warning (Codex #1945 r6).
    if (/getloandetails/i.test(fnName)) return ADDRESS_ALT;
    return ADDRESS;
  }
  if (t === 'bool') {
    // A blanket `false` closes every on-chain gate, so a pass returns after
    // one RPC per chain and — because its RPC count is non-zero — is reported
    // as MEASURED rather than gated. `autoLifecycle` read
    // `getAutoExtendEnabled`, got false, and its 3.9 ms was a closed kill
    // switch presented as a cost (Codex #1945 r1).
    //
    // The FUNCTION name has to be consulted, not just the parameter:
    // `getAutoExtendEnabled`'s output is UNNAMED (`('', 'bool')`), so the
    // first cut of this fix keyed on `p.name`, never fired, and left the gate
    // shut. That is the same unnamed-output trap that produced the 1e18 count
    // — made twice in this file, which is why both heuristics now read from
    // the same pair of sources.
    const where = `${p.name ?? ''} ${fnName}`;
    // A canonical-reward-chain flag is a property of the CHAIN, not a blanket
    // true. `runRewardBudgetRemit` is Base-only and returns immediately on
    // mirrors, so answering `isCanonicalRewardChain` true on every endpoint
    // profiled the Base remit workflow on all three chains and inflated the pass
    // (Codex #1945 r5). Only the canonical fixture chain (Base Sepolia) is true.
    if (/canonical/i.test(where)) {
      return /base/i.test(chainKey);
    }
    // Inverted gates first: `paused`/`frozen` true would BLOCK work, which is
    // the opposite of what an open gate means.
    if (/paused|blocked|frozen|sanction|banned|denied|revoked|expired/i.test(where)) {
      return false;
    }
    // A day's commitment-readiness must be FALSE so commitmentReport takes the
    // continuation branch — funded/closed checks, reward-entry range scans,
    // accumulation reads and batch submission — instead of the trivial
    // send-immediately path. A blanket `is[A-Z]` true left only that cheap path
    // measured (Codex #1945 r8). The funding STAMP, by contrast, must be true or
    // the continuation returns at `!funding.stamped` before any batch work.
    if (/daycommitmentready|commitmentready/i.test(fnName)) return false;
    if (/^stamped$/i.test(p.name ?? '')) return true;
    return /enabled|active|allowed|valid|open|exists|\bis[A-Z]|\bhas[A-Z]|\bcan[A-Z]|success|approved|supported/i.test(
      where,
    );
  }
  if (t === 'string') return 'x';
  if (t === 'bytes') return '0x';
  if (/^bytes\d+$/.test(t)) {
    const n = Number(t.slice(5));
    return `0x${'11'.repeat(n)}`;
  }
  if (/^u?int\d*$/.test(t)) {
    // A COUNT and an AMOUNT need different magnitudes, and conflating them
    // hung the first working run of this harness: `getActiveLoansCount`
    // answered 1e18, so the liquidator's pagination loop had 1e18/200 pages
    // to walk and never returned. Names are the only signal available here,
    // and they are reliable enough for a profiling fixture.
    // Parameter names may match loosely; FUNCTION names must not. Testing the
    // whole function name for `len` matched `getActiveLenderIntents` and
    // `getAutoExtendLenderCaps` inside the word "Lender", so amounts, rates,
    // durations and expiries all came back as COUNT_VALUE and drove matcher /
    // lifecycle control flow off fixture artifacts (Codex #1945 r1).
    const COUNTISH_PARAM = /^(count|total|length|len|num|size|pages)$|Count$|Total$|Length$/;
    const COUNTISH_FN = /Count$|Total$|Length$|^count$/;
    if (COUNTISH_PARAM.test(p.name ?? '') || COUNTISH_FN.test(fnName)) {
      return BigInt(COUNT_VALUE);
    }

    // A reward entry only COVERS a commitment day when `startDay <= day <
    // endDay` and its `side` is 0 or 1. Left at the generic 1e18 default,
    // `startDay > day` broke submitSide's scan on the first entry, so
    // commitmentReport measured the reward-entry read but never reached
    // submitCommitmentBatch (Codex #1945 r8). Scoped to getRewardEntriesRange so
    // these common field names don't perturb other selectors. day range is
    // 19995–19999 (see the currentDay/armedFromDay seeds below), so start 1 /
    // end 30000 covers every seeded day; side 0 submits the lender batch.
    if (/getrewardentriesrange/i.test(fnName)) {
      if (/^startday$/i.test(p.name ?? '')) return 1n;
      if (/^endday$/i.test(p.name ?? '')) return 30000n;
      if (/^side$/i.test(p.name ?? '')) return 0n;
    }

    // The on-chain keeper tier must DIFFER from the aggregate the quote resolves
    // to (tier 1), or liquidityConfidence logs `(no change)` and skips keeper
    // signing + setKeeperTier. 2 > 1 is an immediate safety demotion — the
    // transition this every-tick pass exists to perform (Codex #1945 r9).
    if (/getkeepertier/i.test(fnName)) return 2n;

    // An ENUM is uint8 in practice, and a 1e18 enum silently discards work:
    // every mocked `getOffer` had `offerType = 1e18` while the matcher accepts
    // only 0 and 1, so the whole offer book was thrown away with no error
    // logged (Codex #1945 r1). Small, in-range values for narrow ints and for
    // type/status/kind-shaped names.
    if (/^u?int8$/.test(t) || /type|status|kind|state|band|tier|role/i.test(p.name ?? '')) {
      // Loan status and asset type must be the ACTIVE enum values — 0 = active
      // loan, 0 = ERC20 — or `maybeAutonomousLiquidate` returns before quote /
      // sign / submit, leaving the liquidation path unmeasured even with at-risk
      // loans (Codex #1945 r5). Other enums (offerType etc.) keep the in-range
      // ENUM_VALUE the matcher accepts.
      // A remit reservation's ACTIONABLE status is 1 (Pending): remitAck treats
      // status 0 as terminal tail and 2/3 as already-acked, doing its
      // receipt / quote / sign / ack-send work ONLY on Pending. A blanket
      // status 0 left all 200 reservations looking terminal and the ack half
      // unmeasured (Codex #1945 r6). Loan status / asset type stay 0
      // (Active / ERC20).
      if (/^status$/i.test(p.name ?? '') && /remit|reservation/i.test(fnName)) {
        return 1n;
      }
      if (/^status$|asset_?type|assetkind/i.test(p.name ?? '')) {
        return 0n;
      }
      return BigInt(ENUM_VALUE);
    }
    // A CHAIN-ID-shaped field must be a REAL fixture chain, or a pass that reads
    // it and then tries to act on that chain errors out per record with "no
    // configured RPC" — `remitAck` did exactly that on every remit's `dst`,
    // and once the pagination fix let it walk the whole set (Codex #1945 r3)
    // that was hundreds of self-inflicted errors that floored its number. The
    // FUNCTION name is consulted too, because `getExpectedSourceChainIds` /
    // `getBroadcastDestinations` return UNNAMED `uint32[]` whose elements would
    // otherwise fall through to the width-clamped max and fabricate a topology
    // of remittances to a nonexistent chain (Codex #1945 r5). Base Sepolia is
    // always in the fixture set.
    if (
      /chain|^dst$|^src$|dest|source/i.test(p.name ?? '') ||
      /chainids?|sourcechain|broadcastdest|destination|expectedsource|remotechain/i.test(fnName)
    ) {
      // `getExpectedSourceChainIds` enumerates the REMOTE reward mirrors, and
      // rewardBudgetRemit drops the local (Base) id before planning; if every
      // element is Base the mirror list is empty and it exits before a single
      // remittance (Codex #1945 r6). For the expected-source / mirror topology
      // return a non-Base configured mirror; a scalar chain-id (dst / src /
      // localChainId) stays the canonical fixture chain so the mirror-config
      // lookup that drives remitAck still resolves.
      if (/expectedsource|sourcechain|broadcastdest|remotechain|mirror/i.test(fnName)) {
        return 421614n; // Arbitrum Sepolia — a configured non-Base mirror
      }
      return 84532n;
    }
    // A HEALTH FACTOR must come back BELOW the 1e18 liquidation line, or
    // scanChain classifies every loan as safe and the liquidator skips its
    // sort / cap / sign / submit path — the active liquidation work this profile
    // most needs — reporting atRisk=0 with no honesty marker (Codex #1945 r4).
    // 0.95e18 flags every scanned loan as liquidatable.
    if (/healthfactor/i.test(fnName) || /^hf$|healthfactor/i.test(p.name ?? '')) {
      return 950_000_000_000_000_000n;
    }
    // Loan TIME fields must place `endTime = startTime + durationDays*86400`
    // INSIDE preGraceWatcher's 24h pre-grace window, or `checkLoan` returns at
    // the window test before `ownerOf` and the notification path (Codex #1945
    // r6). durationDays = 1 with startTime 12h ago puts endTime 12h out — past
    // `now`, inside the 24h window. (Date.now is real for this pass; it is only
    // pinned for the daily-window pass, which reads no loan times.)
    if (/^durationdays?$|^termdays?$/i.test(p.name ?? '')) {
      return 1n;
    }
    if (/^starttime$/i.test(p.name ?? '')) {
      return BigInt(Math.floor(Date.now() / 1000) - 12 * 60 * 60);
    }
    // Commitment day indices: `getInteractionCurrentDay.day` must sit a few days
    // ABOVE `getGovernorCommitState.armedFromDay`, or reportFromMirror raises
    // `from` to `armedFromDay == currentDay` and `dayList` is empty — leaving
    // commitmentReport's readiness / reward-scan / batch / send work unmeasured
    // (Codex #1945 r7). Kept a SMALL gap (5 days) so the bounded per-day
    // backscan stays well under the call budget.
    if (/getinteractioncurrentday/i.test(fnName)) return 20000n;
    if (/getgovernorcommitstate/i.test(fnName)) return 19995n;
    // Commitment accumulation must be BELOW the day's totals, or submitSide sees
    // `conservation === total` and skips the batch. 0 leaves the day unresolved
    // so the reward-entry scan + submitCommitmentBatch path runs (Codex #1945
    // r8). The cursor (same call's first element) at 0 is a valid scan start.
    if (/getcommitmentaccumulation/i.test(fnName)) return 0n;
    // Non-trivial magnitude otherwise: a zero everywhere would let a pass
    // early-return on "nothing to do" and profile as free, which is the
    // failure mode this harness exists to avoid. Clamp to the type's width so a
    // narrow output still ENCODES — the Quoter's `uint32 initializedTicksCrossed`
    // would otherwise overflow `encodeFunctionResult` and throw (Codex #1945 r3).
    const base = 1_000_000_000_000_000_000n;
    const widthMatch = t.match(/^(u?)int(\d*)$/);
    const bits = widthMatch && widthMatch[2] ? Number(widthMatch[2]) : 256;
    const max =
      widthMatch && widthMatch[1] === 'u'
        ? (1n << BigInt(bits)) - 1n
        : (1n << BigInt(bits - 1)) - 1n;
    return base <= max ? base : max;
  }
  return 0n;
}

/** ABI-encode a plausible result for whatever selector was called. */
function answerCall(data: string, chainKey = ''): string {
  const selector = data.slice(0, 10).toLowerCase();

  if (selector === toFunctionSelector(MULTICALL3_ABI[0]).toLowerCase()) {
    const { args } = decodeFunctionData({
      abi: MULTICALL3_ABI,
      data: data as `0x${string}`,
    });
    const calls = args[0] as readonly { callData: string }[];
    const results = calls.map((c) => ({
      success: true,
      returnData: answerCall(c.callData, chainKey) as `0x${string}`,
    }));
    return encodeFunctionResult({
      abi: MULTICALL3_ABI,
      functionName: 'aggregate3',
      result: results,
    });
  }

  const fn = BY_SELECTOR.get(selector);
  if (!fn || fn.outputs.length === 0) return '0x';

  // Size the TOP-LEVEL array output. Pagination is identified by a
  // cursor/offset-shaped INPUT — a non-paginated array such as
  // `getUserActiveLoans(address)` is a whole per-user list, not a page, and
  // keeps ARRAY_LEN (emptying it after two calls dropped 18 of 20 seeded users
  // and undercounted the watcher — Codex #1945 r1).
  const returnsArray = fn.outputs.some((o) => o.type.endsWith('[]'));
  const offsetIdx = fn.inputs.findIndex((i) =>
    /offset|start|cursor|page|index|from/i.test(i.name ?? ''),
  );
  const limitIdx = fn.inputs.findIndex((i) =>
    /limit|count|size|max|first|take|num/i.test(i.name ?? ''),
  );
  const paginated = returnsArray && offsetIdx >= 0;

  let pageLen = ARRAY_LEN;
  if (paginated) {
    // Serve a slice of ONE coherent COUNT_VALUE-sized dataset. The keeper reads
    // a count (COUNT_VALUE) and then pages by its own limit; a page shorter than
    // the requested limit is its stop signal. Returning a fixed ARRAY_LEN
    // regardless of the limit made a count=50 / limit=200 loop stop after 25 and
    // never scan the other half (Codex #1945 r3). Decode offset+limit and return
    // exactly min(limit, remaining), so the loop walks the whole set and then
    // terminates when it runs out.
    let offset = 0;
    let limit = ARRAY_LEN;
    let decoded = false;
    try {
      const { args } = decodeFunctionData({
        abi: [fn] as Abi,
        data: data as `0x${string}`,
      });
      const a = args as readonly unknown[];
      const off = Number(a[offsetIdx]);
      if (Number.isFinite(off)) {
        offset = off;
        decoded = true;
      }
      if (limitIdx >= 0) {
        const lim = Number(a[limitIdx]);
        if (Number.isFinite(lim) && lim > 0) limit = lim;
      }
    } catch {
      decoded = false;
    }
    if (decoded) {
      pageLen = Math.max(0, Math.min(limit, COUNT_VALUE - offset));
    } else {
      // Cursor/opaque pagination we cannot decode: fall back to the per-(chain,
      // selector) page counter so the read still terminates after MAX_PAGES.
      const pageKey = `${chainKey}|${selector}`;
      const seen = (pageCounts.get(pageKey) ?? 0) + 1;
      pageCounts.set(pageKey, seen);
      pageLen = seen > MAX_PAGES ? 0 : ARRAY_LEN;
    }
  }

  const values = fn.outputs.map((o) => {
    if (!o.type.endsWith('[]')) return defaultFor(o, fn.name, chainKey);
    const inner = { ...o, type: o.type.slice(0, -2) } as AbiParameter;
    // The reward-topology chain-id lists are the fixture's UNIQUE configured
    // chains, not ARRAY_LEN copies of one mirror (Codex #1945 r11). The caller
    // filters its own local id out of this set.
    if (
      /expectedsource|sourcechain|broadcastdest|remotechain/i.test(fn.name) &&
      /^u?int(8|16|32|64|128|256)?$/.test(inner.type)
    ) {
      return FIXTURE_CHAIN_IDS.map((c) => c);
    }
    return Array.from({ length: pageLen }, () => defaultFor(inner, fn.name, chainKey));
  });
  return encodeFunctionResult({
    abi: [fn] as Abi,
    functionName: fn.name,
    result: (fn.outputs.length === 1 ? values[0] : values) as never,
  });
}

const HEX = (n: number | bigint) => `0x${n.toString(16)}`;

/** Answer one JSON-RPC request object. */
function answer(
  req: { method: string; params?: unknown[]; id?: unknown },
  chainKey = '',
): unknown {
  const { method, params = [] } = req;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id ?? 1, result });
  switch (method) {
    case 'eth_chainId':
      return ok(HEX(8453));
    case 'eth_blockNumber':
      return ok(HEX(20_000_000));
    case 'eth_call':
      return ok(
        answerCall(((params[0] as { data?: string })?.data ?? '0x') as string, chainKey),
      );
    case 'eth_getBlockByNumber':
    case 'eth_getBlockByHash':
      return ok({
        number: HEX(20_000_000),
        hash: `0x${'22'.repeat(32)}`,
        parentHash: `0x${'33'.repeat(32)}`,
        timestamp: HEX(Math.floor(Date.now() / 1000)),
        baseFeePerGas: HEX(1_000_000_000),
        gasLimit: HEX(30_000_000),
        gasUsed: HEX(15_000_000),
        miner: ADDRESS,
        extraData: '0x',
        transactions: [],
        logsBloom: `0x${'00'.repeat(256)}`,
        difficulty: '0x0',
      });
    case 'eth_getLogs':
      return ok([]);
    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas':
      return ok(HEX(1_000_000_000));
    case 'eth_estimateGas':
      return ok(HEX(500_000));
    case 'eth_getTransactionCount':
      return ok(HEX(7));
    case 'eth_sendRawTransaction':
      return ok(`0x${'44'.repeat(32)}`);
    case 'eth_getTransactionReceipt':
      return ok({
        transactionHash: `0x${'44'.repeat(32)}`,
        blockNumber: HEX(20_000_000),
        blockHash: `0x${'22'.repeat(32)}`,
        status: '0x1',
        gasUsed: HEX(400_000),
        cumulativeGasUsed: HEX(400_000),
        logs: [],
        logsBloom: `0x${'00'.repeat(256)}`,
        contractAddress: null,
        from: ADDRESS,
        to: ADDRESS,
        transactionIndex: '0x0',
        type: '0x2',
        effectiveGasPrice: HEX(1_000_000_000),
      });
    case 'eth_feeHistory':
      return ok({
        oldestBlock: HEX(19_999_990),
        baseFeePerGas: Array.from({ length: 11 }, () => HEX(1_000_000_000)),
        gasUsedRatio: Array.from({ length: 10 }, () => 0.5),
        reward: Array.from({ length: 10 }, () => [HEX(1_000_000_000)]),
      });
    default:
      return ok(null);
  }
}

/** Counts requests served, so a pass that did nothing cannot look cheap. */
export const rpcStats = { calls: 0 };

/**
 * Serialized-response cache, keyed on (chain, request body).
 *
 * THE MEASUREMENT DEPENDS ON THIS. Without it every mocked request runs
 * `answerCall` -> `encodeFunctionResult` -> `JSON.stringify` inside the same
 * `process.cpuUsage()` interval as the keeper — but in production that ABI
 * encoding and serialization is done by the REMOTE RPC SERVER, not by the
 * Worker. At 1,560 calls each encoding a 25-element array, that fixture work
 * plausibly dominated the reported figure and flattered whichever pass made
 * the most calls (Codex #1945 r1).
 *
 * With the cache plus a warm-up run (see `warmUp` in passCpu.ts), the measured
 * interval pays a Map lookup instead of an encode. Residual fixture cost that
 * is still inside the interval, and therefore still a known floor: the
 * `JSON.parse` of the request body and the `Response` construction.
 */
// Caches the ANSWER OBJECTS (id-free), keyed on url + method + params. The
// per-request JSON-RPC id is patched back on the way out — see the warm-up
// note in installRpcMock (Codex #1945 r10).
const responseCache = new Map<string, unknown[]>();

/** Install the mock as global fetch. Returns a restore function. */
export function installRpcMock(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(
      typeof input === 'string' ? input : (input as { url?: string })?.url ?? '',
    );
    // Anything that is not our fake RPC endpoint (aggregator quotes, Telegram,
    // Push) gets a bland 200 rather than a network attempt.
    if (!url.includes('mock-rpc')) {
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    rpcStats.calls += 1;
    budgetLeft -= 1;
    if (budgetLeft < 0) {
      budget.exceeded = true;
      throw new Error(
        `[bench] RPC call budget of ${CALL_BUDGET} exhausted — this pass is ` +
          'unbounded against the fixture. That is the finding, not a bug.',
      );
    }
    const raw = init?.body ?? '{}';
    const body = JSON.parse(raw);
    const isBatch = Array.isArray(body);
    // viem assigns a FRESH JSON-RPC id to every request (a global counter), so
    // keying the cache on the raw body — id included — means the warm-up (id 0)
    // and the measured call (id 1) never share an entry, and every measured
    // call re-runs answerCall's ABI encode inside the interval: exactly the
    // remote-server work this cache exists to move to the warm-up (Codex #1945
    // r10). Key on method+params only; cache the answer objects, then patch each
    // one's id to the CURRENT request before serializing.
    const reqs = (isBatch ? body : [body]) as {
      method: string;
      params?: unknown[];
      id?: unknown;
    }[];
    const cacheKey = `${url}|${JSON.stringify(reqs.map((r) => [r.method, r.params]))}`;
    let results = responseCache.get(cacheKey);
    if (results === undefined) {
      results = reqs.map((b) => answer(b, url));
      responseCache.set(cacheKey, results);
    }
    const patched = results.map((r, i) => ({
      ...(r as Record<string, unknown>),
      id: reqs[i].id ?? 1,
    }));
    const payload = JSON.stringify(isBatch ? patched : patched[0]);
    return new Response(payload, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}
