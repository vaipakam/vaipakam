/**
 * T-031 Layer 4a — cross-chain reconciliation watchdog.
 *
 * Listens for `BridgedBuyProcessed(requestId, originEid, buyer,
 * ethAmountPaid, ...)` on Base (the canonical {VPFIBuyReceiver}) and
 * cross-references each event against a matching
 * `BuyRequested(requestId, buyer, dstEid, amountIn, ...)` on the
 * named source chain's `VPFIBuyAdapter`. Mismatch = a forged
 * BUY_REQUEST landed on Base via a compromised LZ DVN; alert + log
 * for the operator. The Layer 2 adapter-side cross-check has
 * *already* prevented value extraction by then (forged compose lands
 * VPFI on the adapter, no `pendingBuys` match, VPFI stays stuck) —
 * the watchdog's job is to surface the forge so governance can
 * `pause()` and investigate.
 *
 * Kill switch: reads `receiver.reconciliationWatchdogEnabled()`
 * before each pass. When `false`, the function exits quietly. The
 * flag is governance-controlled via the receiver's `onlyOwner`
 * setter, same auth path as every other protocol lever.
 *
 * Auto-pause is intentionally NOT implemented in this first cut —
 * it would require the watchdog to hold a signing key with pause
 * authority, which raises its own operational concerns (key
 * management, rotation, blast radius if the watchdog itself is
 * compromised). For now the watchdog alerts + relies on the
 * operator to manually call `receiver.pause()` from the multisig.
 * A future extension can wire a constrained pauser-multisig key
 * here (gated to the single `pause()` function, not full owner).
 */

import { createPublicClient, http, parseAbi, getAddress, type Address } from 'viem';
import type { Env } from './env';
import { getDeployment } from './deployments';

const RECEIVER_ABI = parseAbi([
  'event BridgedBuyProcessed(uint64 indexed requestId, uint32 indexed originEid, address indexed buyer, uint256 ethAmountPaid, uint256 vpfiOut, bytes32 oftGuid)',
  'event BridgedBuyFailed(uint64 indexed requestId, uint32 indexed originEid, address indexed buyer, uint8 reason)',
  'function reconciliationWatchdogEnabled() view returns (bool)',
]);

const ADAPTER_ABI = parseAbi([
  'event BuyRequested(uint64 indexed requestId, address indexed buyer, uint32 indexed dstEid, uint256 amountIn, uint256 minVpfiOut, bytes32 lzGuid)',
]);

/**
 * Map a LayerZero V2 endpoint id (the `originEid` carried in the
 * receiver event) to the concrete (chainId, RPC env-var key) for that
 * chain. Source-of-truth for the eid → chainId mapping is the
 * project-side LZ V2 endpoint registry; mirrors what
 * `Deployments.lzEidForChain` returns server-side.
 *
 * Returns `null` for an eid the watchdog isn't configured to monitor —
 * the buy lands on Base anyway but reconciliation skips. Add new
 * lanes here as the protocol opens to additional source chains.
 */
function resolveSourceChain(env: Env, eid: number): { chainId: number; rpc: string | undefined } | null {
  // Mainnet eids (V2 production lane: 30000-series).
  if (eid === 30101) return { chainId: 1, rpc: env.RPC_ETH };
  if (eid === 30110) return { chainId: 42161, rpc: env.RPC_ARB };
  if (eid === 30111) return { chainId: 10, rpc: env.RPC_OP };
  if (eid === 30109) return { chainId: 137, rpc: env.RPC_POLYGON };
  if (eid === 30102) return { chainId: 56, rpc: env.RPC_BNB };
  if (eid === 30184) return { chainId: 8453, rpc: env.RPC_BASE };
  // Testnet eids (40000-series).
  if (eid === 40161) return { chainId: 11155111, rpc: env.RPC_SEPOLIA };
  if (eid === 40231) return { chainId: 421614, rpc: env.RPC_ARB_SEPOLIA };
  if (eid === 40232) return { chainId: 11155420, rpc: env.RPC_OP_SEPOLIA };
  if (eid === 40267) return { chainId: 80002, rpc: env.RPC_POLYGON_AMOY };
  if (eid === 40102) return { chainId: 97, rpc: env.RPC_BNB_TESTNET };
  if (eid === 40245) return { chainId: 84532, rpc: env.RPC_BASE_SEPOLIA };
  return null;
}

// How many recent blocks on Base to scan for `BridgedBuyProcessed`
// events on each pass. Conservative 1-min cadence × ~2s blocks +
// margin = 60. Larger windows on chains with longer block times
// (Polygon, BNB) absorb their own slack on the source-chain lookup.
const BASE_LOOKBACK_BLOCKS = 60n;

// How many recent blocks to search on the source chain for the
// matching `BuyRequested`. The source-chain event was emitted before
// the Base event by the LZ message latency (~30s typical, up to 5min
// on congestion). 2000 blocks is generous enough for any chain we
// monitor while keeping the RPC quote-cost bounded.
const SOURCE_LOOKBACK_BLOCKS = 2000n;

interface BuyWatchdogResult {
  scanned: number;
  matched: number;
  mismatches: Array<{
    requestId: bigint;
    originEid: number;
    buyer: Address;
    ethAmountPaid: bigint;
    reason: string;
  }>;
  skipped: boolean;
}

export async function runBuyWatchdog(env: Env): Promise<BuyWatchdogResult> {
  const baseRpc = env.RPC_BASE;
  if (!baseRpc) {
    console.log('[buyWatchdog] RPC_BASE unset — skipping pass');
    return { scanned: 0, matched: 0, mismatches: [], skipped: true };
  }

  // Resolve the canonical-Base receiver address from the deployments
  // bundle. Same source the rest of the watcher reads from.
  const baseDeployment = getDeployment(8453) ?? getDeployment(84532); // mainnet OR base-sepolia
  if (!baseDeployment) {
    console.log('[buyWatchdog] no Base deployment in deployments.json — skipping');
    return { scanned: 0, matched: 0, mismatches: [], skipped: true };
  }
  const receiverAddr = (baseDeployment as { vpfiBuyReceiver?: string }).vpfiBuyReceiver;
  if (!receiverAddr) {
    console.log('[buyWatchdog] vpfiBuyReceiver missing in Base deployment — skipping');
    return { scanned: 0, matched: 0, mismatches: [], skipped: true };
  }

  const baseClient = createPublicClient({ transport: http(baseRpc) });

  // Kill switch — governance-controlled flag on the receiver. Read
  // BEFORE any other RPC work so a disabled watchdog is cheap.
  let enabled: boolean;
  try {
    enabled = await baseClient.readContract({
      address: getAddress(receiverAddr),
      abi: RECEIVER_ABI,
      functionName: 'reconciliationWatchdogEnabled',
    });
  } catch (err) {
    console.error('[buyWatchdog] failed to read enable flag', err);
    return { scanned: 0, matched: 0, mismatches: [], skipped: true };
  }
  if (!enabled) {
    console.log('[buyWatchdog] disabled by governance flag — skipping pass');
    return { scanned: 0, matched: 0, mismatches: [], skipped: true };
  }

  // Pull recent successful bridged-buy events on Base.
  const head = await baseClient.getBlockNumber();
  const fromBlock = head > BASE_LOOKBACK_BLOCKS ? head - BASE_LOOKBACK_BLOCKS : 0n;
  const events = await baseClient.getContractEvents({
    address: getAddress(receiverAddr),
    abi: RECEIVER_ABI,
    eventName: 'BridgedBuyProcessed',
    fromBlock,
    toBlock: head,
  });

  const mismatches: BuyWatchdogResult['mismatches'] = [];
  let matched = 0;

  for (const ev of events) {
    const args = ev.args as {
      requestId: bigint;
      originEid: number;
      buyer: Address;
      ethAmountPaid: bigint;
      vpfiOut: bigint;
      oftGuid: `0x${string}`;
    };
    const source = resolveSourceChain(env, Number(args.originEid));
    if (!source || !source.rpc) {
      // Source chain we can't reach (RPC unset). Log + skip — alert
      // operator ops if this is a deploy oversight.
      console.warn(
        `[buyWatchdog] no RPC for source eid ${args.originEid} — skipping reconciliation for requestId=${args.requestId}`,
      );
      continue;
    }

    // Look up matching BuyRequested on the source chain.
    const sourceClient = createPublicClient({ transport: http(source.rpc) });
    const sourceDeployment = getDeployment(source.chainId);
    if (!sourceDeployment) {
      console.warn(`[buyWatchdog] no deployment for chainId ${source.chainId}`);
      continue;
    }
    const adapterAddr = (sourceDeployment as { vpfiBuyAdapter?: string }).vpfiBuyAdapter;
    if (!adapterAddr) {
      console.warn(`[buyWatchdog] no vpfiBuyAdapter for chainId ${source.chainId}`);
      continue;
    }

    const sourceHead = await sourceClient.getBlockNumber();
    const sourceFromBlock =
      sourceHead > SOURCE_LOOKBACK_BLOCKS ? sourceHead - SOURCE_LOOKBACK_BLOCKS : 0n;
    const sourceEvents = await sourceClient.getContractEvents({
      address: getAddress(adapterAddr),
      abi: ADAPTER_ABI,
      eventName: 'BuyRequested',
      args: { requestId: args.requestId },
      fromBlock: sourceFromBlock,
      toBlock: sourceHead,
    });

    if (sourceEvents.length === 0) {
      // CRITICAL: Base says a bridged buy was processed for this id,
      // but the named source chain has no record of `buy()` ever
      // being called with this id. This is the forged-BUY_REQUEST
      // signature.
      mismatches.push({
        requestId: args.requestId,
        originEid: Number(args.originEid),
        buyer: args.buyer,
        ethAmountPaid: args.ethAmountPaid,
        reason: 'no-matching-buy-requested-on-source',
      });
      continue;
    }

    // Sanity-check the matched event's payload. A compromised DVN
    // could land a forged BUY_REQUEST that *replays* an old real
    // requestId but with different (buyer, amount) fields — surface
    // as mismatch even when an event for that id exists on source.
    const sourceEv = sourceEvents[0];
    const sourceArgs = sourceEv.args as {
      requestId: bigint;
      buyer: Address;
      dstEid: number;
      amountIn: bigint;
      minVpfiOut: bigint;
    };
    if (
      sourceArgs.amountIn !== args.ethAmountPaid ||
      sourceArgs.buyer.toLowerCase() !== args.buyer.toLowerCase()
    ) {
      mismatches.push({
        requestId: args.requestId,
        originEid: Number(args.originEid),
        buyer: args.buyer,
        ethAmountPaid: args.ethAmountPaid,
        reason: `payload-divergence-source-buyer=${sourceArgs.buyer}-source-amount=${sourceArgs.amountIn}`,
      });
      continue;
    }

    matched++;
  }

  if (mismatches.length > 0) {
    // Surface mismatches via console.error — Cloudflare Worker logs
    // pipe straight to wrangler tail so the operator sees them in
    // real time. Future extension: hook an outbound alert (Telegram
    // / Push / pagerduty) here. Auto-pause via a constrained pauser
    // key is also a future extension.
    console.error(
      `[buyWatchdog] ${mismatches.length} cross-chain reconciliation mismatch(es) detected:`,
      JSON.stringify(
        mismatches.map((m) => ({
          ...m,
          requestId: m.requestId.toString(),
          ethAmountPaid: m.ethAmountPaid.toString(),
        })),
      ),
    );
  }

  return {
    scanned: events.length,
    matched,
    mismatches,
    skipped: false,
  };
}
