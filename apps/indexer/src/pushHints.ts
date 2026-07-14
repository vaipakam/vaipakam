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
 * HINT_CAP is a deliberately conservative launch value; #12XX tracks
 * re-tuning it from real per-scan touched-id volume once rehearsal
 * load exists.
 */

export const HINT_CAP = 32;

export interface PushHintLink {
  loanId: number;
  offerId?: number;
  lender?: string;
  borrower?: string;
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
const OFFER_ID_ARGS = ['offerId', 'lendOfferId', 'borrowOfferId', 'buyOfferId'] as const;

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
const LINK_EVENTS = new Set(['LoanInitiated', 'LoanInitiatedDetails', 'LoanSaleCompleted']);

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
      const loanId = toNum(log.args.loanId);
      if (loanId != null && links.length < HINT_CAP) {
        links.push({
          loanId,
          offerId: toNum(log.args.offerId) ?? undefined,
          lender: toAddr(log.args.lender),
          borrower: toAddr(log.args.borrower),
        });
      } else if (loanId != null) {
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
