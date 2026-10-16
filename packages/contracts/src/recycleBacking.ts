/**
 * #1349 M5 / #1566 slice 4 — the recycle-backing VERDICT, as one pure
 * function every consumer shares.
 *
 * WHY THIS LIVES HERE. The recycling transparency surface must state
 * whether the pool is backed rather than leave a reader to derive it
 * (TokenomicsTechSpec §"Recycling transparency series": the comparison is
 * published as its own answer and the shortfall quantified). The indexer
 * computes that answer once and serves it; a second, hand-written copy of
 * the relation in any other consumer is a copy that has not drifted yet —
 * and the relation has already been wrong once in exactly that way: the
 * retired dashboard compared `vpfiBalance >= bucket`, which was wrong
 * BEFORE activation (it ignored both recovery reservations, which sit in
 * the same balance and are spoken for) and wrong AFTER it (the bucket is
 * then the holder's custody, not a subtrahend of the Diamond's balance).
 *
 * THE RELATION IS THE CONTRACT'S, NOT OURS. It is stated in the natspec of
 * `RewardCustodyFacet.getRecycleBackingSnapshotV2` and restated here only so
 * a reader of this file does not have to open Solidity to check it:
 *
 *  - custody NOT activated (`custodyActivated === false`) — relation
 *    `'diamond'`:
 *        vpfiBalance >= bucket + strandedRecoveryReserved
 *                              + recoveryPositionReserved
 *    The Diamond's own balance is the only custody there is, and three
 *    classes are spoken for inside it: the recycle bucket, quarantined
 *    compensation awaiting its return, and the recovery-position earmark.
 *    Leaving either reservation out lets a payout that ate recovery-reserved
 *    tokens read as backed.
 *
 *  - custody ACTIVATED (`custodyActivated === true`) — relation `'holder'`:
 *        holderBalance >= holderAttributed   (the holder backs every row)
 *    AND vpfiBalance   >= strandedRecoveryReserved
 *                                            (the one Diamond-side
 *                                             reservation left)
 *    Here the bucket and the recovery position are custody of the HOLDER,
 *    so applying the pre-activation relation would page a false shortfall
 *    whenever healthy holder rows exceed the unrelated Diamond balance. The
 *    V2 view already nets the holder-backed part out of
 *    `strandedRecoveryReserved`, so the second leg is exact as read.
 *
 *    Both legs must be READABLE for the answer to be determinable. When the
 *    holder's balance could not be read, or a term either leg subtracts is
 *    missing, the verdict is "not determinable, with that reason" — even if
 *    the other leg could be read and fails. That is the rule the API
 *    contract, TokenomicsTechSpec ("Recycling transparency series": "the
 *    same holds when the custody address's balance could not be read, or a
 *    subtracted amount is missing") and the #1349 M5 release note all state.
 *    A per-leg rule ("a readable failing leg decides it") was tried and
 *    withdrawn: its shortfall covers one leg of a two-leg relation, and every
 *    surface that renders a shortfall as THE shortfall then presents a
 *    partial picture as the whole one. The Diamond-side operands are still
 *    published beside the refusal, so nothing known is hidden — only the
 *    single-word answer is withheld, which is never the flattering
 *    direction (it is not "backed").
 *
 *  - custody state UNKNOWN (`custodyActivated === null`) — NOT DETERMINABLE.
 *    The legacy eight-field lens tuple carries no activation state and must
 *    not stand in: the flag lives on the same facet as V2, so a Diamond that
 *    cannot answer V2 cannot establish non-activation either, and assuming
 *    it would apply the Diamond-only relation to custody that may be on the
 *    holder (the same rule `ops/mesh-watcher`'s
 *    `backingSnapshotUnavailableGap` follows).
 *
 * EXACT, NO TOLERANCE. The mesh watcher pads the pre-activation leg with a
 * dust tolerance because it PAGES a human, and wei-scale `consume` rounding
 * is not worth a page. A published figure has the opposite obligation: it
 * states the arithmetic, and a dust shortfall is reported as the dust it is
 * (the display layer labels a positive amount below its precision as such,
 * never as zero). A tolerance here would make the published answer
 * disagree with the published operands.
 *
 * NULL IS ABSENCE, A MALFORMED FIGURE IS A BUG. A `null` operand is a value
 * the reading did not carry — an older capture, an unreadable holder — and
 * yields a not-determinable verdict WITH ITS REASON, never a zero. A
 * non-null operand that is not a plain decimal is not absence; it is
 * corruption the caller should have rejected, so this throws rather than
 * coercing it (a coerced zero converts a detected corruption into a
 * confident false verdict).
 *
 * Amounts in and out are DECIMAL WEI STRINGS (the indexer's wire format);
 * all arithmetic is `bigint`, so there is no float path anywhere.
 */

/** Which inequality the verdict was decided on. */
export type RecycleBackingRelation = 'diamond' | 'holder';

/**
 * Why a verdict could not be reached. Fixed codes, so a surface can render
 * the reason rather than a dash — a dash reads as zero, and zero is the
 * opposite of "not determinable".
 *
 *  - `custody-state-unknown`  — the reading carries no activation state
 *                               (captured before it was recorded, or the
 *                               versioned view was unavailable), so neither
 *                               relation can be chosen honestly.
 *  - `holder-balance-unknown` — custody is activated but the holder's
 *                               balance could not be read, so nothing
 *                               substantiates the rows it is said to back.
 *  - `subtrahend-unknown`     — an amount the chosen relation subtracts is
 *                               missing from the reading.
 *
 * On the `'holder'` relation either of the last two withholds the answer
 * whatever the other leg says (see the module note: a one-leg shortfall is
 * not published as the relation's answer).
 */
export type RecycleBackingUndeterminedReason =
  | 'custody-state-unknown'
  | 'holder-balance-unknown'
  | 'subtrahend-unknown';

/** The operands, exactly as one backing reading carries them. */
export interface RecycleBackingInputs {
  /** The Diamond's own VPFI balance. Always present in a reading. */
  vpfiBalance: string;
  /** The recycle bucket. Always present in a reading. */
  bucket: string;
  /** Diamond-side arrival reservation; null on readings that predate it. */
  strandedRecoveryReserved: string | null;
  /** Recovery-position earmark; null on readings that predate it. */
  recoveryPositionReserved: string | null;
  /** null = the reading carries no activation state. */
  custodyActivated: boolean | null;
  /** null = not recorded; false = the chain reported it unreadable. */
  holderBalanceKnown: boolean | null;
  /** null whenever the balance is not known — never a placeholder zero. */
  holderBalance: string | null;
  /** Sum of the holder's attributed custody rows. */
  holderAttributed: string | null;
}

/** The published answer to "is the pool backed?". */
export interface RecycleBackingVerdict {
  /** Whether a relation could be evaluated at all. */
  determinable: boolean;
  /**
   * The relation the custody state selected; null only when
   * `reason === 'custody-state-unknown'`. It is still set when that relation
   * could not be evaluated (`'holder-balance-unknown'`,
   * `'subtrahend-unknown'`): the activation state was known, so WHICH
   * relation applies is a fact even when one of its terms is not.
   */
  relation: RecycleBackingRelation | null;
  /** Every leg of the relation holds; null when not determinable. */
  ok: boolean | null;
  /**
   * How far the DIAMOND-side leg falls short, decimal wei. Non-null only
   * when determinable and that leg is short: the full three-term sum on the
   * `'diamond'` relation, the arrival reservation alone on `'holder'`.
   */
  diamondShortfall: string | null;
  /**
   * How far the holder falls short of its attributed rows, decimal wei.
   * Non-null only when determinable, on the `'holder'` relation, and short.
   */
  holderShortfall: string | null;
  /** Why not determinable; null when it is. */
  reason: RecycleBackingUndeterminedReason | null;
}

const DECIMAL = /^\d+$/;

/**
 * Parse one decimal-wei operand. `null` passes through as absence; anything
 * else that is not a plain non-negative decimal throws (see the module
 * note — a malformed figure is never coerced).
 */
function wei(name: string, v: string | null): bigint | null {
  if (v === null) return null;
  if (typeof v !== 'string' || !DECIMAL.test(v)) {
    throw new RangeError(
      `recycleBackingVerdict: ${name} is not a decimal wei string`,
    );
  }
  return BigInt(v);
}

function undetermined(
  reason: RecycleBackingUndeterminedReason,
  relation: RecycleBackingRelation | null,
): RecycleBackingVerdict {
  // The relation is reported when it was CHOSEN (activation state known) but
  // could not be evaluated, so a reader learns which inequality is pending;
  // it stays null when even the choice was impossible.
  return {
    determinable: false,
    relation,
    ok: null,
    diamondShortfall: null,
    holderShortfall: null,
    reason,
  };
}

/**
 * Decide whether one backing reading is backed, by the relation its own
 * custody state selects. Pure: no I/O, no clock, no tolerance.
 *
 * @throws RangeError when a non-null operand is not a decimal wei string.
 */
export function recycleBackingVerdict(
  input: RecycleBackingInputs,
): RecycleBackingVerdict {
  const vpfiBalance = wei('vpfiBalance', input.vpfiBalance);
  const bucket = wei('bucket', input.bucket);
  const stranded = wei('strandedRecoveryReserved', input.strandedRecoveryReserved);
  const recovery = wei('recoveryPositionReserved', input.recoveryPositionReserved);
  const holderBalance = wei('holderBalance', input.holderBalance);
  const holderAttributed = wei('holderAttributed', input.holderAttributed);
  // Typed non-null, but this is a shared boundary that may be fed JSON: a
  // missing minuend is a caller bug, not a reason to publish.
  if (vpfiBalance === null || bucket === null) {
    throw new RangeError(
      'recycleBackingVerdict: vpfiBalance and bucket are required',
    );
  }

  // Only a real boolean selects a relation. Testing `=== null` alone would
  // let an `undefined` (a JSON reading that simply lacks the field) fall
  // through to the activated branch and publish relation 'holder' — naming
  // a custody state the reading never established. Absence and any other
  // non-boolean are the same fact: the state is unknown.
  if (input.custodyActivated !== true && input.custodyActivated !== false) {
    return undetermined('custody-state-unknown', null);
  }

  if (input.custodyActivated === false) {
    if (stranded === null || recovery === null) {
      // A partial subtrahend set would answer "backed" for a balance that
      // has spent exactly the reservation nobody could see.
      return undetermined('subtrahend-unknown', 'diamond');
    }
    const spokenFor = bucket + stranded + recovery;
    const ok = vpfiBalance >= spokenFor;
    return {
      determinable: true,
      relation: 'diamond',
      ok,
      diamondShortfall: ok ? null : (spokenFor - vpfiBalance).toString(),
      holderShortfall: null,
      reason: null,
    };
  }

  // Activated. Both legs must be READABLE before either is compared (see
  // the module note): an answer built from one leg would publish a partial
  // shortfall as the relation's whole answer.
  //
  // The holder leg is checked first, and its reason takes precedence when
  // both legs are unread: it is the leg that carries the pool after
  // activation. Its readability is decided before any comparison: the
  // contract reports an unreadable balance as `known = false` with a
  // placeholder, and that placeholder compared against the rows would
  // publish a shortfall equal to everything the holder is said to hold.
  // Only a literal `true` counts as known: `null`, `false`, a missing field
  // (`undefined`) and any other non-boolean JSON value all mean the reading
  // did not establish the balance.
  if (input.holderBalanceKnown !== true || holderBalance === null) {
    return undetermined('holder-balance-unknown', 'holder');
  }
  if (holderAttributed === null || stranded === null) {
    return undetermined('subtrahend-unknown', 'holder');
  }

  const holderShortfall =
    holderBalance < holderAttributed
      ? (holderAttributed - holderBalance).toString()
      : null;
  const diamondShortfall =
    vpfiBalance < stranded ? (stranded - vpfiBalance).toString() : null;
  return {
    determinable: true,
    relation: 'holder',
    ok: holderShortfall === null && diamondShortfall === null,
    diamondShortfall,
    holderShortfall,
    reason: null,
  };
}
