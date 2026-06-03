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

/** On-chain cap from `LibVaipakam.MAX_FEE_LEGS` (referenced in
 *  `NFTPrepayListingFacet` + `NFTPrepayDutchListingFacet`). A schedule
 *  with more required-fee recipients than this can't settle through
 *  the diamond — `updatePrepayListing` reverts `FeeLegsExceedCap`. The
 *  parser fails closed on such schedules so the Match panel doesn't
 *  let the borrower reach a guaranteed-to-revert transaction. */
export const MAX_FEE_LEGS = 4;

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
 * schedule the dapp consumes.
 *
 * **Return contract**:
 * - `null` — the schedule is structurally unmatchable: a `required:
 *   true` row had a missing / malformed recipient, or the count of
 *   required-fee rows exceeds [`MAX_FEE_LEGS`](#max_fee_legs). Both
 *   conditions would let the dapp greenlight a Match flow that can't
 *   settle: missing-recipient would either drop a leg OpenSea's
 *   marketplace expects (publish rejection) or send funds to
 *   `address(0)` (lost); too-many-legs reverts `FeeLegsExceedCap`.
 *   Caller treats `null` as fail-closed and gates Match.
 * - `{ fees: [], totalBps: 0 }` — collection ships zero required
 *   fees (fee-free). Caller proceeds with the v1 fee-free path
 *   verbatim.
 * - `{ fees: [...], totalBps > 0 }` — collection enforces one or
 *   more required fees. Caller uses `totalBps` for threshold
 *   scaling + [`computeFeeLegs`](#computefeelegs) at confirm time.
 *
 * **Optional-row handling**: non-required fee rows (creator
 * royalties marked off-chain promotional, etc.) are silently
 * ignored. They sit on OpenSea's marketplace UI but never enter the
 * on-chain settlement; their presence + shape is irrelevant to the
 * schedule's validity.
 *
 * **Malformed body handling**: a body that isn't a JSON object,
 * doesn't carry a `fees` array, or carries an array of non-objects
 * resolves to `{ fees: [], totalBps: 0 }` (treated as fee-free) —
 * NOT `null`. The `null` return is reserved for "the response named
 * a required fee row but its shape is unsafe to settle"; the
 * absence of any `fees` field altogether is OpenSea's signal for "no
 * fees apply".
 */
export function parseOpenSeaFeeSchedule(
  body: unknown,
): ParsedFeeSchedule | null {
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

    // Codex round-1 P2 #339 — a required row with positive bps but
    // missing / malformed recipient signals OpenSea WILL demand
    // settlement to a recipient we can't name. Silently dropping
    // this row would let the schedule classify as partially
    // fee-free; the rotated listing would then either omit a leg
    // OpenSea's marketplace expects (publish rejection) or send the
    // amount to `address(0)` (lost). Fail closed on the whole
    // schedule.
    if (!isHexAddress(entry.recipient)) return null;
    const recipient = entry.recipient.toLowerCase() as `0x${string}`;
    if (recipient === ZERO_ADDRESS) return null;

    fees.push({ recipient, basisPoints: bps });
    totalBps += bps;
  }

  // Codex round-1 P2 #339 — schedules with more required-fee
  // recipients than the diamond's `MAX_FEE_LEGS` cap structurally
  // can't settle. `updatePrepayListing` reverts `FeeLegsExceedCap`,
  // so a borrower reaching the Match flow on such a collection would
  // hit a guaranteed-to-revert tx. Fail closed at parse time.
  if (fees.length > MAX_FEE_LEGS) return null;

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
 * **Return contract**:
 * - `null` — the schedule + askPrice combination would produce one
 *   or more zero-amount fee legs. The diamond reverts
 *   `FeeLegInvalidAmount` on any zero entry, so admitting such a
 *   schedule would let the borrower reach a guaranteed-to-revert
 *   transaction. Caller treats `null` as fail-closed and aborts
 *   the Match.
 * - `[]` — schedule has no required fees (fee-free). Caller uses
 *   the empty array verbatim; matches the v1 baseline.
 * - non-empty `FeeLegInput[]` — every leg has a strictly positive
 *   amount; safe to thread into `updatePrepayListing`.
 *
 * `askPrice <= 0` also returns `null` — a non-positive ask is
 * structurally invalid and would produce zero amounts even on
 * positive bps.
 */
export function computeFeeLegs(
  schedule: ParsedFeeSchedule,
  askPrice: bigint,
): FeeLegInput[] | null {
  if (schedule.fees.length === 0) return [];
  if (askPrice <= 0n) return null;
  const legs: FeeLegInput[] = [];
  for (const f of schedule.fees) {
    const amount = (askPrice * BigInt(f.basisPoints)) / 10_000n;
    // Codex round-1 P2 #339 — fail closed on any zero-rounding leg.
    // The diamond's `FeeLegInvalidAmount` revert would catch this
    // on-chain, but greenlighting an offer that's guaranteed to
    // revert wastes the borrower's gas + leaves the surface in a
    // confusing "tried Match, no rotation" state. Better to abort
    // pre-flight; the borrower sees a clean disabled state until
    // the offer climbs above the per-leg-rounding floor.
    if (amount <= 0n) return null;
    legs.push({
      recipient: f.recipient,
      startAmount: amount,
      endAmount: amount,
    });
  }
  return legs;
}
