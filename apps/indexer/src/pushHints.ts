/**
 * RPC read-diet PR D (Alpha02RpcReadDietDesign §4.2.2) — scoped push
 * hints. One pure pass over the scan's decoded logs extracts the
 * affected loan/offer ids PLUS the causative linkage for creations
 * (the consumed offerId and the party addresses the event already
 * carries), so invalidate frames can tell a tab "this scan touched
 * loans X,Y via offer Z for parties A,B" instead of only a coarse key.
 *
 * The contract is TRUNCATION-HONEST (design §2.2, Codex #1224 r2/r3):
 * hints may only ever NARROW a client's work when they are COMPLETE.
 * `truncated: true` whenever
 *   - an id set exceeds HINT_CAP (a busy scan), or
 *   - the scan contains ANY row-mutating log whose affected row we
 *     cannot identify here (position-NFT `Transfer` carries a tokenId,
 *     not a loanId; the signed-offer lifecycle keys on orderHash) —
 *     a client that trusted an id list missing those rows would
 *     silently skip a refetch it needed (the exact ownership.changed
 *     case §7(c) verified live).
 * Clients treat a truncated or absent hint as the coarse key — today's
 * behaviour, degraded never wrong. Central extraction on purpose: the
 * per-event handlers can't drift out of sync with a list they don't
 * maintain; a new event either carries a recognised id arg (extracted)
 * or it doesn't (forces truncated — safe by default).
 *
 * HINT_CAP is a deliberately conservative launch value; #1245 tracks
 * re-tuning it from real per-scan touched-id volume once rehearsal
 * load exists. `pushHintStats` (below) is the measurement rail for
 * that retune: it reports the PRE-cap sizes and the truncation-cause
 * breakdown per scan, which the scan tail logs as structured
 * telemetry so `wrangler tail | grep hint-telemetry` yields the
 * distribution during a rehearsal-load window.
 */

export const HINT_CAP = 32;

export interface PushHintLink {
  loanId?: number;
  offerId?: number;
  /** Any party address the event names — original or NEW holder,
   *  creator. The client treats a match on ANY of these as "mine". */
  lender?: string;
  borrower?: string;
  creator?: string;
  newLender?: string;
  newBorrower?: string;
}

export interface PushHints {
  loanIds: number[];
  offerIds: number[];
  /** Causative linkage for loan creations — how a tab that has never
   *  seen the new loanId can still recognise "this is MINE" (its offer
   *  was consumed / it is a named party). */
  links: PushHintLink[];
  truncated: boolean;
}

const LOAN_ID_ARGS = ['loanId', 'loanIdA', 'loanIdB', 'loanIdC'] as const;
const OFFER_ID_ARGS = ['offerId', 'lenderOfferId', 'borrowerOfferId', 'buyOfferId'] as const;

/** Events whose row impact is keyed by something we cannot map to a
 *  loan/offer id without DB reads (tokenId / orderHash). Their presence
 *  forces `truncated` so clients fall back to the coarse key. */
const UNMAPPABLE_ROW_EVENTS = new Set([
  'Transfer',
  'SignedOfferFilled',
  'SignedOfferMatched',
  'SignedOfferCancelled',
  'SignedOfferNonceBurned',
]);

/** Creation-shaped events that carry the causative linkage. */
const LINK_EVENTS = new Set([
  'LoanInitiated',
  'LoanInitiatedDetails',
  // Creation/acquisition events whose RELEVANT wallet cannot yet hold
  // the id in its cache: the creator of a fresh offer, the NEW holder
  // of a sold/migrated position (Codex #1244 r1 — LoanSaleCompleted
  // names originalLender/newLender, not lender).
  'OfferCreated',
  'LoanSold',
  'LoanSaleCompleted',
  'LoanObligationTransferred',
]);

const toNum = (v: unknown): number | null => {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
};
const toAddr = (v: unknown): string | undefined =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)
    ? v.toLowerCase()
    : undefined;

export function collectPushHints(
  logs: ReadonlyArray<{ eventName: string; args: Record<string, unknown> }>,
): PushHints {
  const loanIds = new Set<number>();
  const offerIds = new Set<number>();
  const links: PushHintLink[] = [];
  let truncated = false;

  for (const log of logs) {
    if (UNMAPPABLE_ROW_EVENTS.has(log.eventName)) {
      truncated = true;
      continue;
    }
    let sawId = false;
    for (const k of LOAN_ID_ARGS) {
      const n = toNum(log.args[k]);
      if (n != null) {
        loanIds.add(n);
        sawId = true;
      }
    }
    for (const k of OFFER_ID_ARGS) {
      const n = toNum(log.args[k]);
      if (n != null) {
        offerIds.add(n);
        sawId = true;
      }
    }
    // A handled event with NO recognised id arg still mutated (or may
    // have mutated) some row — the hint cannot claim completeness.
    // (Config/heartbeat-class events never reach this scan set: the
    // decode loop only admits EVENT_ABI members, all row-affecting.)
    if (!sawId) truncated = true;

    if (LINK_EVENTS.has(log.eventName)) {
      const link: PushHintLink = {
        loanId: toNum(log.args.loanId) ?? undefined,
        offerId: toNum(log.args.offerId) ?? undefined,
        lender: toAddr(log.args.lender),
        borrower: toAddr(log.args.borrower),
        creator: toAddr(log.args.creator),
        newLender: toAddr(log.args.newLender),
        newBorrower: toAddr(log.args.newBorrower),
      };
      const hasParty =
        link.lender || link.borrower || link.creator || link.newLender || link.newBorrower;
      if (links.length < HINT_CAP) {
        links.push(link);
        // A link event whose party fields we couldn't read can't tell
        // the acquiring wallet "this is yours" — no completeness claim.
        if (!hasParty) truncated = true;
      } else {
        truncated = true;
      }
    }
  }

  if (loanIds.size > HINT_CAP || offerIds.size > HINT_CAP) truncated = true;
  return {
    loanIds: [...loanIds].slice(0, HINT_CAP),
    offerIds: [...offerIds].slice(0, HINT_CAP),
    links,
    truncated,
  };
}

/** #1245 measurement rail — the PRE-cap sizes + the truncation-cause
 *  breakdown for one scan's logs, for HINT_CAP retuning telemetry.
 *  Separate from `collectPushHints` on purpose: this is indexer-
 *  internal diagnostics, never part of the client wire shape. Shares
 *  the same classification constants so the WHAT-counts logic can't
 *  drift; only the counting is independent. */
export interface HintStats {
  /** Distinct loan ids the scan would hint, BEFORE the HINT_CAP slice
   *  — the distribution a retune reads to pick a cap that keeps ≥95%
   *  of frames un-truncated (sub-task 1). */
  loanIdCount: number;
  /** Distinct offer ids, pre-cap (sub-task 1). */
  offerIdCount: number;
  /** Link (creation-shaped) events seen, pre-cap. */
  linkCount: number;
  /** Whether `collectPushHints` would flag this scan truncated. */
  truncated: boolean;
  /** Why — a frame can trip more than one (sub-task 2: is signed-desk
   *  `unmappableEvent` traffic the dominant truncation cause?). */
  causes: {
    loanCapExceeded: boolean;
    offerCapExceeded: boolean;
    unmappableEvent: boolean;
    handledNoId: boolean;
    linkCapExceeded: boolean;
    linkNoParty: boolean;
  };
}

export function pushHintStats(
  logs: ReadonlyArray<{ eventName: string; args: Record<string, unknown> }>,
): HintStats {
  const loanIds = new Set<number>();
  const offerIds = new Set<number>();
  let linkCount = 0;
  const causes = {
    loanCapExceeded: false,
    offerCapExceeded: false,
    unmappableEvent: false,
    handledNoId: false,
    linkCapExceeded: false,
    linkNoParty: false,
  };

  for (const log of logs) {
    if (UNMAPPABLE_ROW_EVENTS.has(log.eventName)) {
      causes.unmappableEvent = true;
      continue;
    }
    let sawId = false;
    for (const k of LOAN_ID_ARGS) {
      const n = toNum(log.args[k]);
      if (n != null) {
        loanIds.add(n);
        sawId = true;
      }
    }
    for (const k of OFFER_ID_ARGS) {
      const n = toNum(log.args[k]);
      if (n != null) {
        offerIds.add(n);
        sawId = true;
      }
    }
    if (!sawId) causes.handledNoId = true;
    if (LINK_EVENTS.has(log.eventName)) {
      const hasParty =
        toAddr(log.args.lender) ||
        toAddr(log.args.borrower) ||
        toAddr(log.args.creator) ||
        toAddr(log.args.newLender) ||
        toAddr(log.args.newBorrower);
      if (linkCount < HINT_CAP) {
        if (!hasParty) causes.linkNoParty = true;
      } else {
        causes.linkCapExceeded = true;
      }
      linkCount += 1;
    }
  }

  causes.loanCapExceeded = loanIds.size > HINT_CAP;
  causes.offerCapExceeded = offerIds.size > HINT_CAP;
  const truncated =
    causes.loanCapExceeded ||
    causes.offerCapExceeded ||
    causes.unmappableEvent ||
    causes.handledNoId ||
    causes.linkCapExceeded ||
    causes.linkNoParty;

  return {
    loanIdCount: loanIds.size,
    offerIdCount: offerIds.size,
    linkCount,
    truncated,
    causes,
  };
}
