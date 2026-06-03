/**
 * T-086 Round-5 Block C v1.1 (#331) — shared parser for the OpenSea
 * `/api/v2/collections/{slug}` response's `fees` array.
 *
 * The agent proxy at `GET /opensea/collection/{slug}` passes the
 * OpenSea body through unchanged. This helper turns that raw JSON
 * into a typed schedule the dapp consumes in two places:
 *
 *   1. `OpenSeaOffersSection` polls the proxy once per slug and uses
 *      the schedule's `totalBps` to scale `useOpenSeaOffers`'
 *      threshold filter so offers are classified acceptable against
 *      the post-fee borrower remainder, not the gross.
 *   2. The Match-button click handler re-fetches the proxy at confirm
 *      time and uses `computeFeeLegs(schedule, offer.value)` to build
 *      the on-chain `FeeLegInput[]` for `updatePrepayListing`'s
 *      `feeLegs` calldata.
 *
 * **Why two field names are tolerated** (`basis_points` AND `fee`):
 * OpenSea has shipped both shapes at different times — recent
 * `/api/v2/collections/{slug}` responses carry `fee` (a basis-points
 * integer despite the misleading name); older deploys + some legacy
 * subgraph mirrors still carry `basis_points`. The existing fee-free
 * vs fee-enforced gate in `OpenSeaOffersSection` (rounds 7 + 8 of PR
 * #328) already special-cased the same drift. Permissive read here
 * keeps the dapp working against both.
 *
 * **Required-only filter** (Block A semantics): only fees with
 * `required: true` AND `basisPoints > 0` enter the on-chain feeLegs
 * array. Optional fees (creator royalties marked as off-chain
 * promotional, etc.) stay on OpenSea's marketplace UI but never
 * appear in the protocol's multi-leg consideration. This matches
 * the §14.x "consideration = lender + treasury + required-fees +
 * borrower-remainder" rule.
 */

import type { FeeLegInput } from '../hooks/useNFTPrepayListing';

export interface ParsedFeeScheduleEntry {
  /** Recipient address normalized to lowercase 0x-hex (matches the
   *  on-chain `FeeLeg.recipient` slot's case-insensitive comparison
   *  shape; explicit lowercase here means the dapp's identity check
   *  against the agent's preflight result is exact). */
  recipient: `0x${string}`;
  basisPoints: number;
}

export interface ParsedFeeSchedule {
  /** Only required + non-zero fees. The on-chain settlement shape is
   *  this array verbatim, scaled to amounts. */
  fees: readonly ParsedFeeScheduleEntry[];
  /** Sum of all required-fee basis points. Drives the threshold
   *  scaling in `useOpenSeaOffers.computeAcceptable`. Zero on
   *  fee-free collections; non-zero on fee-enforced ones. */
  totalBps: number;
}

/** Shape we accept from the agent proxy. The proxy is a pass-through
 *  of OpenSea's `/api/v2/collections/{slug}` body, which has the
 *  `fees` array near the top level. */
interface OpenSeaCollectionResponse {
  fees?: unknown;
}

/** Per-fee shape we'll see inside `body.fees[]`. Both field names
 *  (`basis_points` AND `fee`) carry the same value depending on
 *  OpenSea API era. `recipient` is the payout address. */
interface OpenSeaFeeRow {
  basis_points?: number;
  fee?: number;
  required?: boolean;
  recipient?: string;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const HEX40_RE = /^0x[0-9a-fA-F]{40}$/;

/** Hex-address sanity check kept inline (no viem `isAddress`
 *  dependency) so this helper stays import-light. Required-fee rows
 *  with a malformed / missing recipient are dropped — there's no
 *  safe way to settle to "the address the schedule meant to name"
 *  and a fallback to `address(0)` would burn the fee at
 *  `updatePrepayListing` time.
 *  Codex P2 caveat: returning false for non-string preserves the
 *  "drop the row, log nothing" stance the rest of the dapp uses for
 *  malformed agent-proxy data. */
function isHexAddress(s: unknown): s is `0x${string}` {
  return typeof s === 'string' && HEX40_RE.test(s);
}

/**
 * Parse an OpenSea-collection-body's `fees` array into the typed
 * schedule the dapp consumes. Empty or malformed input → fee-free
 * schedule (totalBps=0, fees=[]). This is the safe default:
 * downstream code treats `totalBps === 0` as "no fee-leg adjustment
 * needed", which matches the v1 Block C-on-fee-free path exactly.
 */
export function parseOpenSeaFeeSchedule(body: unknown): ParsedFeeSchedule {
  if (body === null || typeof body !== 'object') {
    return { fees: [], totalBps: 0 };
  }
  const raw = (body as OpenSeaCollectionResponse).fees;
  if (!Array.isArray(raw)) return { fees: [], totalBps: 0 };

  const fees: ParsedFeeScheduleEntry[] = [];
  let totalBps = 0;

  for (const entryRaw of raw) {
    if (entryRaw === null || typeof entryRaw !== 'object') continue;
    const entry = entryRaw as OpenSeaFeeRow;
    if (entry.required !== true) continue;

    // Permissive read: accept either field name; zero / negative /
    // non-finite → skip the row.
    const candidateBps = entry.basis_points ?? entry.fee;
    if (typeof candidateBps !== 'number' || !Number.isFinite(candidateBps)) {
      continue;
    }
    const bps = Math.floor(candidateBps);
    if (bps <= 0) continue;

    if (!isHexAddress(entry.recipient)) continue;
    const recipient = entry.recipient.toLowerCase() as `0x${string}`;
    if (recipient === ZERO_ADDRESS) continue;

    fees.push({ recipient, basisPoints: bps });
    totalBps += bps;
  }

  return { fees, totalBps };
}

/**
 * Multiply each fee row's `basisPoints` against the order's
 * `askPrice` to produce the on-chain `FeeLegInput[]` calldata. For
 * fixed-price (Block A / C) listings, `startAmount == endAmount`;
 * Dutch listings (Block B) compute decay-edge amounts using the
 * caller-supplied start + end prices.
 *
 * Integer math: `amount = floor(askPrice × bps / 10000)`. Floor (vs
 * round-up) keeps the per-fee amount strictly within the
 * borrower's `askPrice × bps/10000` allotment — important because
 * the diamond's sum-equality check on consideration legs reverts if
 * we over-promise. The borrower-remainder leg absorbs any rounding
 * drift, exactly matching the contract's settlement waterfall.
 *
 * **Empty schedule → empty FeeLegInput[].** That keeps fee-free
 * collections going through the same code path with no special-case
 * branching at the call site.
 */
export function computeFeeLegs(
  schedule: ParsedFeeSchedule,
  askPrice: bigint,
): FeeLegInput[] {
  if (schedule.fees.length === 0) return [];
  if (askPrice <= 0n) return [];
  return schedule.fees.map((f) => {
    const amount = (askPrice * BigInt(f.basisPoints)) / 10_000n;
    return {
      recipient: f.recipient,
      startAmount: amount,
      endAmount: amount,
    };
  });
}
