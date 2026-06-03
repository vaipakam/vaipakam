/**
 * T-086 step 14 — orchestration that pulls together every input the
 * canonical `OrderComponents` shape needs, builds it, verifies it
 * against Seaport's own `getOrderHash`, then POSTs to the agent
 * Worker's `/opensea/listing` proxy.
 *
 * Why JS reconstruction + chain-side verify (instead of a single
 * "trust the chain, just POST" approach): OpenSea's marketplace
 * validates the order before surfacing it by calling
 * `isValidSignature` on the borrower's vault. The vault's ERC-1271
 * returns the magic value ONLY for the exact orderHash recorded by
 * `_buildAndRecord`. A JS shape that hashes to a different orderHash
 * fails OpenSea's check silently. The defensive recompute via
 * Seaport catches the divergence before we POST and surfaces a
 * clear error.
 */

import { type PublicClient, type Hex, decodeEventLog } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import {
  buildPrepayOrderComponents,
  openSeaAssetUrl,
  SEAPORT_VERIFY_ABI,
  type PrepayOrderInput,
  type SeaportOrderComponents,
} from '@vaipakam/lib/prepayOrderShape';

export interface OpenSeaPublishResult {
  /** True iff the on-chain orderHash matched our JS reconstruction
   *  AND the agent proxy returned 2xx from OpenSea. */
  published: boolean;
  /** Deep-link to the OpenSea asset page. The listing surfaces here
   *  once OpenSea ingests + validates the order (typically seconds). */
  assetUrl: string | null;
  /** OpenSea's raw response body, useful for diagnostics. */
  openseaResponse?: unknown;
  /** Populated when the publish path failed — caller surfaces this
   *  alongside the (still-successful) on-chain tx. */
  error?: string;
}

export interface OpenSeaPublishInput {
  publicClient: PublicClient;
  /** Resolved agent origin (e.g. https://agent.vaipakam.io). When
   *  unset (local dev without the agent), we skip the publish and
   *  return `{ published: false, error: 'agent-not-configured' }`. */
  agentOrigin: string | null;
  diamondAddress: `0x${string}`;
  chainId: number;
  /** Post tx receipt — used to read the block timestamp and to find
   *  the `PrepayListingPosted` event for the canonical orderHash. */
  txReceipt: { blockNumber: bigint; logs: ReadonlyArray<{ address: string; topics: readonly Hex[]; data: Hex }> };
  loanId: bigint;
  askPrice: bigint;
  salt: bigint;
  conduitKey: `0x${string}`;
  /** T-086 Round-5 Block A (#313) — the fee legs the borrower
   *  signed with at post / update time. Same shape the diamond
   *  recorded; threading them here is what keeps the JS-rebuilt
   *  canonical components in lockstep with the on-chain orderHash
   *  when the listing is on a fee-enforced collection. Empty for
   *  fee-free collections. */
  feeLegs?: ReadonlyArray<{
    recipient: string;
    startAmount: bigint;
    endAmount: bigint;
  }>;
  /** T-086 Round-5 Block C v1.1 (#332) — Dutch decay parameters
   *  for the canonical-order rebuild. When set, this helper also
   *  reads `getPrepayContext(loanId, dutch.auctionEndTime)` to
   *  resolve the projected lender + treasury legs (matching the
   *  facet's `LibPrepayOrder.buildAndHashDutch` flow) and threads
   *  them into `buildPrepayOrderComponents`'s `dutch` field. The
   *  Seaport `OrderComponents.endTime` then becomes
   *  `auctionEndTime` rather than `graceEnd`, and the consideration
   *  legs Seaport interpolates between span the Dutch decay
   *  (start: offer.value-derived; end: same as the fixed-price
   *  shape applied at the projected legs).
   *
   *  Omitting this field (default) keeps the helper on the
   *  fixed-price + Block A multi-leg shape. */
  dutch?: {
    endAskPrice: bigint;
    auctionEndTime: bigint;
  };
}

/**
 * Run the publish flow. Caller awaits this after `tx.wait()`
 * resolves — the receipt + post-tx block.timestamp + the
 * `PrepayListingPosted` orderHash are all available by then.
 *
 * Never throws: the publish path is a best-effort UX overlay on
 * top of an already-successful on-chain tx. Any failure
 * (divergence, agent down, OpenSea reject) collapses to a
 * `published: false` result with the diagnostic string.
 */
export async function publishPrepayListingToOpenSea(
  input: OpenSeaPublishInput,
): Promise<OpenSeaPublishResult> {
  const {
    publicClient,
    agentOrigin,
    diamondAddress,
    chainId,
    txReceipt,
    loanId,
    askPrice,
    salt,
    conduitKey,
  } = input;

  if (!agentOrigin) {
    return { published: false, assetUrl: null, error: 'agent-not-configured' };
  }

  try {
    // 1. Read block timestamp at the post tx — that's the exact
    //    value the diamond's `block.timestamp` resolved to inside
    //    the call.
    const block = await publicClient.getBlock({
      blockNumber: txReceipt.blockNumber,
    });
    const startTime = BigInt(block.timestamp);

    // 2. Pull the snapshot context the diamond consumed when it
    //    built the order. `getPrepayContext(loanId, asOfTimestamp)`
    //    re-runs the live-floor math at the post-tx timestamp.
    const ctx = await readGetPrepayContext(
      publicClient,
      diamondAddress,
      loanId,
      startTime,
    );

    // 3. Resolve the pinned-executor + its Seaport + the vault's
    //    Seaport counter — these go into the canonical components
    //    verbatim. The executor address is taken from the event
    //    payload (it's emitted on `PrepayListingPosted` /
    //    `PrepayListingUpdated` from T-086 step 14 round 2) so the
    //    JS recompute stays correct across a governance executor
    //    rotation between the post tx and this publish call.
    const executor = findEventExecutor(txReceipt, diamondAddress);
    if (!executor) {
      return {
        published: false,
        assetUrl: null,
        error: 'no-executor-in-event',
      };
    }

    const seaport = await publicClient.readContract({
      address: executor,
      abi: SEAPORT_ABI_FRAGMENT,
      functionName: 'seaport',
    }) as `0x${string}`;

    const counter = await publicClient.readContract({
      address: seaport,
      abi: SEAPORT_VERIFY_ABI,
      functionName: 'getCounter',
      args: [ctx.borrowerVault],
    }) as bigint;

    // 4. For Dutch listings — resolve the projected lender +
    //    treasury legs at `auctionEndTime` (matching what the
    //    facet's `LibPrepayOrder.buildAndHashDutch` reads via
    //    `getPrepayContext(loanId, auctionEndTime)`).
    let dutchInput: PrepayOrderInput['dutch'] | undefined;
    if (input.dutch) {
      const projectedCtx = await readGetPrepayContext(
        publicClient,
        diamondAddress,
        loanId,
        input.dutch.auctionEndTime,
      );
      dutchInput = {
        startAskPrice: askPrice,
        endAskPrice: input.dutch.endAskPrice,
        projectedLenderLeg: projectedCtx.lenderLeg,
        projectedTreasuryLeg: projectedCtx.treasuryLeg,
        auctionEndTime: input.dutch.auctionEndTime,
      };
    }

    // 5. Build canonical components. Field order, item ordering,
    //    and units must mirror `LibPrepayOrder._components` exactly.
    const components = buildPrepayOrderComponents({
      vault: ctx.borrowerVault,
      executor,
      collateralAssetType: Number(ctx.collateralAssetType),
      collateralAsset: ctx.collateralAsset,
      collateralTokenId: ctx.collateralTokenId,
      collateralQuantity: ctx.collateralQuantity,
      principalAsset: ctx.principalAsset,
      lenderLeg: ctx.lenderLeg,
      treasuryLeg: ctx.treasuryLeg,
      askPrice,
      lenderNftOwner: ctx.lenderNftOwner,
      borrowerNftOwner: ctx.borrowerNftOwner,
      // T-086 Round-5 Block A (#313) — pass through the caller's
      // fee legs so the JS reconstruction matches the on-chain
      // orderHash for fee-enforced collections. Empty for fee-free.
      feeLegs: input.feeLegs,
      treasury: ctx.treasury,
      startTime,
      graceEnd: ctx.graceEnd,
      salt,
      conduitKey,
      counter,
      dutch: dutchInput,
    });

    // 5. Defensive — verify JS-recomputed orderHash matches the
    //    on-chain emitted hash. Any divergence aborts the publish
    //    with a clear error instead of letting OpenSea silently
    //    reject the signature later.
    //
    // viem's typed ABI demands `0x${string}` for the address /
    // bytes32 fields on the struct args; our `SeaportOrderComponents`
    // uses the wider `string` type for the JSON payload. Cast at the
    // boundary — the JS components hash to the same value as a
    // strictly-typed-then-recasted version because the on-chain
    // canonicalisation only cares about the hex content.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recomputedHash = (await publicClient.readContract({
      address: seaport,
      abi: SEAPORT_VERIFY_ABI,
      functionName: 'getOrderHash',
      args: [components as unknown as any],
    })) as Hex;

    const onChainHash = findPostedOrderHash(txReceipt, diamondAddress);
    if (!onChainHash) {
      return {
        published: false,
        assetUrl: openSeaAssetUrl(chainId, ctx.collateralAsset, ctx.collateralTokenId),
        error: 'no-posted-event-in-receipt',
      };
    }
    if (recomputedHash.toLowerCase() !== onChainHash.toLowerCase()) {
      return {
        published: false,
        assetUrl: openSeaAssetUrl(chainId, ctx.collateralAsset, ctx.collateralTokenId),
        error: `orderhash-divergence (js=${recomputedHash} chain=${onChainHash})`,
      };
    }

    // 6. POST to the agent proxy. The proxy forwards to OpenSea
    //    with the server-held API key, returning OpenSea's
    //    response verbatim (re-serialised through our CORS gate).
    const res = await fetch(`${agentOrigin}/opensea/listing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chainId,
        // OpenSea Listings API requires `totalOriginalConsiderationItems`
        // on the parameters envelope. NOT part of the EIP-712
        // `OrderComponents` Seaport hashes — we keep `components`
        // intact for the local `getOrderHash` verify above and add
        // the field only when serialising for the API POST. Codex
        // round-1 P2 fix on PR #312.
        parameters: {
          ...(components as unknown as Record<string, unknown>),
          totalOriginalConsiderationItems: components.consideration.length,
        },
        // Empty signature — OpenSea calls `isValidSignature` on the
        // vault (the offerer), which returns the magic value for the
        // bound orderHash; no off-chain signing happens.
        signature: '0x',
        protocol_address: seaport,
      }),
    });

    const openseaResponse = await res.json().catch(() => ({ error: 'non-json' }));
    if (!res.ok) {
      return {
        published: false,
        assetUrl: openSeaAssetUrl(chainId, ctx.collateralAsset, ctx.collateralTokenId),
        error: `opensea-status-${res.status}`,
        openseaResponse,
      };
    }

    return {
      published: true,
      assetUrl: openSeaAssetUrl(chainId, ctx.collateralAsset, ctx.collateralTokenId),
      openseaResponse,
    };
  } catch (err) {
    return {
      published: false,
      assetUrl: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Internals ─────────────────────────────────────────────────────────

/** Minimal ABI for the executor's `seaport()` immutable getter. */
const SEAPORT_ABI_FRAGMENT = [
  {
    type: 'function',
    name: 'seaport',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

/** Shape returned by `DIAMOND_ABI_VIEM.getPrepayContext`. Mirrors
 *  `IVaipakamPrepayContext.PrepayContext`. Decode via viem's
 *  tuple-decode — the runtime shape depends on the consumer ABI. */
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

async function readGetPrepayContext(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
  loanId: bigint,
  asOfTimestamp: bigint,
): Promise<PrepayContextOnChain> {
  const raw = await publicClient.readContract({
    address: diamondAddress,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getPrepayContext',
    args: [loanId, asOfTimestamp],
  });
  // viem decodes struct returns as objects keyed by field name.
  return raw as unknown as PrepayContextOnChain;
}

/** Find the `PrepayListingPosted` event in a tx receipt and
 *  return its `orderHash`. Returns `null` if the event isn't
 *  present (e.g. the receipt is for an `updatePrepayListing` —
 *  caller should pass the `PrepayListingUpdated` event matcher
 *  instead via the receipt-side decode below). */
function findPostedOrderHash(
  receipt: OpenSeaPublishInput['txReceipt'],
  diamondAddress: `0x${string}`,
): Hex | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== diamondAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: DIAMOND_ABI_VIEM,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      // viem's typed event-decode returns `readonly unknown[] | undefined`
      // for tuple shapes; the runtime payload is always the
      // named-args object. Two-step cast keeps the runtime shape
      // intact without widening to `any`.
      const args = decoded.args as unknown as Record<string, unknown>;
      if (decoded.eventName === 'PrepayListingPosted') {
        return args.orderHash as Hex;
      }
      if (decoded.eventName === 'PrepayListingUpdated') {
        return args.newOrderHash as Hex;
      }
    } catch {
      // Not one of our diamond's events — skip.
    }
  }
  return null;
}

/** Find the executor address pinned on `PrepayListingPosted` /
 *  `PrepayListingUpdated`. T-086 step 14 round 2 — we read the
 *  executor from the event rather than the current
 *  `getCollateralListingExecutor()` so the JS reconstruction stays
 *  correct across a governance executor rotation between post and
 *  publish. */
function findEventExecutor(
  receipt: OpenSeaPublishInput['txReceipt'],
  diamondAddress: `0x${string}`,
): `0x${string}` | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== diamondAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: DIAMOND_ABI_VIEM,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      const args = decoded.args as unknown as Record<string, unknown>;
      if (
        decoded.eventName === 'PrepayListingPosted' ||
        decoded.eventName === 'PrepayListingUpdated'
      ) {
        return args.executor as `0x${string}`;
      }
    } catch {
      // Not one of our diamond's events — skip.
    }
  }
  return null;
}

export type { SeaportOrderComponents };
