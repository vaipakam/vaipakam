/**
 * T-086 step 14 — indexer-side autonomous OpenSea republish.
 *
 * Called from the `PrepayListingPosted` and `PrepayListingUpdated`
 * event handlers in `chainIndexer.ts`. The frontend's
 * immediate-after-tx publish (via the agent Worker's
 * `/opensea/listing` proxy) is the low-latency UX path; THIS
 * module is the canonical safety net that runs from the event
 * itself — so a browser that closed between tx-confirm and the
 * dapp's POST still gets its listing onto OpenSea's marketplace UI
 * within the indexer's next scan tick.
 *
 * The on-chain event was extended in step 14 to emit `conduitKey`
 * and `salt`, which (combined with the on-chain reads
 * `getPrepayContext` + `seaport.getCounter(vault)`) are enough to
 * reconstruct the canonical Seaport `OrderComponents` shape
 * `LibPrepayOrder._components` builds. The reconstruction itself
 * lives in `@vaipakam/lib/prepayOrderShape` — single source of
 * truth shared with the frontend so divergence is impossible.
 *
 * Idempotent against the agent-proxy / frontend-direct path:
 * OpenSea dedupes by orderHash, so both producers can race
 * harmlessly. The `opensea_published_at` column on
 * `prepay_listings` is the indexer's local idempotency cache —
 * non-NULL means "we've already confirmed a 2xx for this
 * orderHash"; the handler then skips the API call entirely.
 *
 * On failure we DO NOT throw — the event handler must continue
 * to mark the row as persisted regardless of OpenSea's status.
 * The next ingest pass (#311 fully tracks an explicit cron retry)
 * will re-attempt for rows whose `opensea_published_at` is still
 * NULL.
 */

import { type PublicClient, type Hex } from 'viem';
import {
  buildPrepayOrderComponents,
  SEAPORT_VERIFY_ABI,
  type SeaportOrderComponents,
} from '@vaipakam/lib/prepayOrderShape';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import type { Env } from './env';

/**
 * OpenSea chain map — identical to the agent-side proxy's
 * `OPENSEA_CHAINS` map. Mainnet only — OpenSea sunset their
 * testnet API + marketplace UI on 2025-07-23
 * (`support.opensea.io/en/articles/11833955-farewell-testnets`).
 * For testnet chains the indexer's republish path returns
 * `unsupported-chain-<id>` and the row's `opensea_published_at`
 * stays NULL forever; the on-chain order is still valid + fillable.
 * Kept duplicated from the agent-side map for now since the two
 * Workers maintain their own env types.
 */
const OPENSEA_CHAINS: Record<number, { host: string; slug: string }> = {
  1: { host: 'api.opensea.io', slug: 'ethereum' },
  8453: { host: 'api.opensea.io', slug: 'base' },
  42161: { host: 'api.opensea.io', slug: 'arbitrum' },
  10: { host: 'api.opensea.io', slug: 'optimism' },
};

const SEAPORT_ABI_FRAGMENT = [
  {
    type: 'function',
    name: 'seaport',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export interface IndexerPublishInput {
  publicClient: PublicClient;
  diamondAddress: `0x${string}`;
  chainId: number;
  loanId: bigint;
  /** Post / update tx hash — used to fetch the receipt's block,
   *  whose timestamp anchors the canonical `OrderComponents`
   *  `startTime` field. */
  txHash: `0x${string}`;
  askPrice: bigint;
  salt: bigint;
  conduitKey: `0x${string}`;
  /** Executor address pinned to THIS order at post/update time —
   *  read from the event's `executor` arg (T-086 step 14 round 2).
   *  Using the current `getCollateralListingExecutor()` would race
   *  a governance rotation between post and indexer-ingest: the
   *  diamond's storage gets updated, the indexer reads the new
   *  one, the JS recompute hashes to a different orderHash, and
   *  the defensive comparison rejects a perfectly valid listing. */
  executor: `0x${string}`;
  /** Expected canonical orderHash from the event — we defensively
   *  recompute via Seaport.getOrderHash and abort the POST when
   *  the JS reconstruction diverges (would silently fail
   *  OpenSea's downstream ERC-1271 check). */
  expectedOrderHash: `0x${string}`;
  /** T-086 Round-5 Block A (#313) — the fee legs recorded with
   *  this listing. Threaded through `buildPrepayOrderComponents`
   *  so the JS reconstruction matches the on-chain hash for fee-
   *  enforced collections. The chain indexer reads them straight
   *  out of the event's `feeLegs` data tail and passes them
   *  through. Empty for fee-free posts. */
  feeLegs?: ReadonlyArray<{
    recipient: string;
    startAmount: bigint;
    endAmount: bigint;
  }>;
}

export interface IndexerPublishResult {
  published: boolean;
  /** Diagnostic string — populated on every failure path so the
   *  handler can log it before returning to event ingest. */
  error?: string;
  /** OpenSea's raw response body, kept for diagnostics. */
  openseaResponse?: unknown;
}

/**
 * Reconstruct the canonical `OrderComponents` and POST to
 * OpenSea's Listings API directly (no proxy — this Worker IS the
 * server-side caller).
 *
 * Never throws. Failures are diagnostic-only: the caller (event
 * handler) should record the row as persisted regardless.
 */
export async function indexerPublishPrepayListing(
  input: IndexerPublishInput,
  env: Env,
): Promise<IndexerPublishResult> {
  if (!env.OPENSEA_API_KEY) {
    return { published: false, error: 'opensea-not-configured' };
  }
  const chain = OPENSEA_CHAINS[input.chainId];
  if (!chain) {
    return { published: false, error: `unsupported-chain-${input.chainId}` };
  }

  try {
    // 1. Read the post tx's block timestamp — the canonical
    //    `startTime` is `block.timestamp` AT THE POST CALL,
    //    same as the diamond used.
    const receipt = await input.publicClient.getTransactionReceipt({
      hash: input.txHash,
    });
    const block = await input.publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    const startTime = BigInt(block.timestamp);

    // 2. Pull the diamond's snapshot context the post call
    //    consumed — `getPrepayContext(loanId, asOfTimestamp)`
    //    re-runs the live-floor math at the post-tx block.
    const ctx = (await input.publicClient.readContract({
      address: input.diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getPrepayContext',
      args: [input.loanId, startTime],
    })) as PrepayContextOnChain;

    // 3. Resolve Seaport + the vault's Seaport counter. The
    //    `executor` for THIS order was pinned at post/update time
    //    and emitted on the event — we use the caller-supplied
    //    value to stay safe across a governance executor rotation
    //    between the post tx and this indexer-ingest pass.
    const seaport = (await input.publicClient.readContract({
      address: input.executor,
      abi: SEAPORT_ABI_FRAGMENT,
      functionName: 'seaport',
    })) as `0x${string}`;

    const counter = (await input.publicClient.readContract({
      address: seaport,
      abi: SEAPORT_VERIFY_ABI,
      functionName: 'getCounter',
      args: [ctx.borrowerVault],
    })) as bigint;

    // 4. Build canonical components — shared with frontend so the
    //    construction can't diverge.
    const components = buildPrepayOrderComponents({
      vault: ctx.borrowerVault,
      executor: input.executor,
      collateralAssetType: Number(ctx.collateralAssetType),
      collateralAsset: ctx.collateralAsset,
      collateralTokenId: ctx.collateralTokenId,
      collateralQuantity: ctx.collateralQuantity,
      principalAsset: ctx.principalAsset,
      lenderLeg: ctx.lenderLeg,
      treasuryLeg: ctx.treasuryLeg,
      askPrice: input.askPrice,
      lenderNftOwner: ctx.lenderNftOwner,
      borrowerNftOwner: ctx.borrowerNftOwner,
      treasury: ctx.treasury,
      startTime,
      graceEnd: ctx.graceEnd,
      salt: input.salt,
      conduitKey: input.conduitKey,
      counter,
      // T-086 Round-5 Block A (#313) — Codex P1 (PR #324 review):
      // thread the recorded fee legs through so the JS
      // reconstruction matches the on-chain hash on fee-enforced
      // collections. Empty for fee-free posts; the call collapses
      // to the Round-4 3-leg shape.
      feeLegs: input.feeLegs,
    });

    // 5. Defensive — recompute the orderHash via Seaport, compare
    //    against the event payload. Divergence aborts the POST
    //    (OpenSea's downstream isValidSignature check would fail
    //    silently otherwise).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recomputed = (await input.publicClient.readContract({
      address: seaport,
      abi: SEAPORT_VERIFY_ABI,
      functionName: 'getOrderHash',
      args: [components as unknown as any],
    })) as Hex;
    if (
      recomputed.toLowerCase() !== input.expectedOrderHash.toLowerCase()
    ) {
      return {
        published: false,
        error: `orderhash-divergence (recomputed=${recomputed} expected=${input.expectedOrderHash})`,
      };
    }

    // 6. POST to OpenSea. Empty signature `0x` — OpenSea calls
    //    `isValidSignature` on the offerer (vault) which returns
    //    the magic value for the bound orderHash. OpenSea's
    //    Listings API also requires `totalOriginalConsiderationItems`
    //    on the parameters envelope (it is NOT part of the EIP-712
    //    `OrderComponents` Seaport hashes, but the API uses it to
    //    validate the payload). Codex round-1 P2 fix on PR #312.
    const url = `https://${chain.host}/api/v2/orders/${chain.slug}/seaport/listings`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-API-KEY': env.OPENSEA_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        parameters: {
          ...components,
          totalOriginalConsiderationItems: components.consideration.length,
        },
        signature: '0x',
        protocol_address: seaport,
      }),
    });
    const openseaResponse = await res.json().catch(() => ({ error: 'non-json' }));
    if (!res.ok) {
      return {
        published: false,
        error: `opensea-status-${res.status}`,
        openseaResponse,
      };
    }
    return { published: true, openseaResponse };
  } catch (err) {
    return {
      published: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface PrepayContextOnChain {
  status: number;
  assetType: number;
  collateralAssetType: number;
  principalAsset: string;
  collateralAsset: string;
  collateralTokenId: bigint;
  collateralQuantity: bigint;
  lenderLeg: bigint;
  treasuryLeg: bigint;
  graceEnd: bigint;
  lenderNftOwner: `0x${string}`;
  borrowerNftOwner: `0x${string}`;
  treasury: `0x${string}`;
  borrowerVault: `0x${string}`;
}

export type { SeaportOrderComponents };
