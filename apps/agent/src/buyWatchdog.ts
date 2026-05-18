/**
 * T-031 Layer 4a — cross-chain reconciliation watchdog.
 *
 * Listens for `BridgedBuyProcessed(requestId, sourceChainId, buyer,
 * amountIn, ...)` on Base (the canonical {VpfiBuyReceiver}) and
 * cross-references each event against a matching
 * `BuyRequested(requestId, buyer, destinationChainId, amountIn, ...)`
 * on the named source chain's `VpfiBuyAdapter`. A mismatch means a
 * BUY_REQUEST was processed on Base with no corresponding `buy()` on
 * the source chain — alert + log for the operator. The Layer 2
 * adapter-side two-step release has *already* prevented value
 * extraction by then (an unrecognised delivery lands VPFI on the
 * adapter, no `pendingBuys` match, VPFI stays stuck) — the watchdog's
 * job is to surface the divergence so governance can `pause()` and
 * investigate.
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

import { createPublicClient, http, getAddress, type Address } from 'viem';
import { VpfiBuyReceiverABI, VpfiBuyAdapterABI } from '@vaipakam/contracts/abis';
import type { Env } from './env';
import { getDeployment } from '@vaipakam/contracts/deployments';

// Compiled-bytecode ABIs for the two cross-chain buy contracts.
// Both ABIs carry the full surface (events + functions); event log
// parsing keys by topic-hash so extra entries are harmless, and the
// `reconciliationWatchdogEnabled` view sits on VpfiBuyReceiver per
// the on-chain shape. Drops the previous hand-typed parseAbi list
// — same drift hazard the indexer's diamondAbi.ts file documents.
const RECEIVER_ABI = VpfiBuyReceiverABI;
const ADAPTER_ABI = VpfiBuyAdapterABI;

/**
 * Resolve the RPC URL for a source chain. CCIP carries the real EVM
 * `sourceChainId` in the receiver event, so no endpoint-id translation
 * is needed — the watchdog maps the chain id straight to its RPC
 * env-var.
 *
 * Returns `undefined` for a chain id the watchdog isn't configured to
 * monitor — the buy lands on Base anyway but reconciliation skips. Add
 * new lanes here as the protocol opens to additional source chains.
 */
function rpcForChain(env: Env, chainId: number): string | undefined {
  // Mainnets.
  if (chainId === 1) return env.RPC_ETH;
  if (chainId === 42161) return env.RPC_ARB;
  if (chainId === 10) return env.RPC_OP;
  if (chainId === 137) return env.RPC_POLYGON;
  if (chainId === 56) return env.RPC_BNB;
  if (chainId === 8453) return env.RPC_BASE;
  // Testnets.
  if (chainId === 11155111) return env.RPC_SEPOLIA;
  if (chainId === 421614) return env.RPC_ARB_SEPOLIA;
  if (chainId === 11155420) return env.RPC_OP_SEPOLIA;
  if (chainId === 80002) return env.RPC_POLYGON_AMOY;
  if (chainId === 97) return env.RPC_BNB_TESTNET;
  if (chainId === 84532) return env.RPC_BASE_SEPOLIA;
  return undefined;
}

// How many recent blocks on Base to scan for `BridgedBuyProcessed`
// events on each pass. Conservative 1-min cadence × ~2s blocks +
// margin = 60. Larger windows on chains with longer block times
// (Polygon, BNB) absorb their own slack on the source-chain lookup.
const BASE_LOOKBACK_BLOCKS = 60n;

// How many recent blocks to search on the source chain for the
// matching `BuyRequested`. The source-chain event was emitted before
// the Base event by the CCIP message latency (typically minutes).
// 2000 blocks is generous enough for any chain we monitor while
// keeping the RPC quote-cost bounded.
const SOURCE_LOOKBACK_BLOCKS = 2000n;

interface BuyWatchdogResult {
  scanned: number;
  matched: number;
  mismatches: Array<{
    requestId: bigint;
    sourceChainId: number;
    buyer: Address;
    amountIn: bigint;
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
    // Cast: viem widens readContract's return to `unknown` when the
    // ABI is the JSON-imported full-facet shape (vs a single-fn
    // parseAbi). The actual selector returns bool — assert the
    // shape rather than narrow the ABI, matching the indexer's
    // pattern.
    enabled = (await baseClient.readContract({
      address: getAddress(receiverAddr),
      abi: RECEIVER_ABI,
      functionName: 'reconciliationWatchdogEnabled',
    })) as boolean;
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
    // Cast through `unknown`: viem's `Log<...>` type loses `args` when
    // the ABI is the wide JSON shape (it discriminates on function vs
    // event in narrower ABIs). The runtime shape is correct because
    // we passed `eventName: 'BridgedBuyProcessed'` above; only the
    // compile-time type needs the assertion.
    const args = (ev as unknown as {
      args: {
        requestId: bigint;
        sourceChainId: bigint;
        buyer: Address;
        amountIn: bigint;
        vpfiOut: bigint;
        messageId: `0x${string}`;
      };
    }).args;
    const chainId = Number(args.sourceChainId);
    const rpc = rpcForChain(env, chainId);
    if (!rpc) {
      // Source chain we can't reach (RPC unset). Log + skip — alert
      // operator ops if this is a deploy oversight.
      console.warn(
        `[buyWatchdog] no RPC for source chainId ${chainId} — skipping reconciliation for requestId=${args.requestId}`,
      );
      continue;
    }

    // Look up matching BuyRequested on the source chain.
    const sourceClient = createPublicClient({ transport: http(rpc) });
    const sourceDeployment = getDeployment(chainId);
    if (!sourceDeployment) {
      console.warn(`[buyWatchdog] no deployment for chainId ${chainId}`);
      continue;
    }
    const adapterAddr = (sourceDeployment as { vpfiBuyAdapter?: string }).vpfiBuyAdapter;
    if (!adapterAddr) {
      console.warn(`[buyWatchdog] no vpfiBuyAdapter for chainId ${chainId}`);
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
      // being called with this id — a BUY_REQUEST with no origin.
      mismatches.push({
        requestId: args.requestId,
        sourceChainId: chainId,
        buyer: args.buyer,
        amountIn: args.amountIn,
        reason: 'no-matching-buy-requested-on-source',
      });
      continue;
    }

    // Sanity-check the matched event's payload. A forged BUY_REQUEST
    // could *replay* an old real requestId but with different
    // (buyer, amount) fields — surface as a mismatch even when an
    // event for that id exists on source.
    const sourceEv = sourceEvents[0];
    const sourceArgs = (sourceEv as unknown as {
      args: {
        requestId: bigint;
        buyer: Address;
        destinationChainId: bigint;
        amountIn: bigint;
        minVpfiOut: bigint;
      };
    }).args;
    if (
      sourceArgs.amountIn !== args.amountIn ||
      sourceArgs.buyer.toLowerCase() !== args.buyer.toLowerCase()
    ) {
      mismatches.push({
        requestId: args.requestId,
        sourceChainId: chainId,
        buyer: args.buyer,
        amountIn: args.amountIn,
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
          amountIn: m.amountIn.toString(),
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
