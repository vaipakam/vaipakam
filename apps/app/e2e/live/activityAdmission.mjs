/**
 * #2703 — the oracle for `live-activity-participants.mjs`: which of the
 * indexer's activity events belong on a wallet's Activity page, and whether
 * the page rendered exactly those.
 *
 * THE RULE BEING CHECKED. An event belongs on a wallet's page when it
 * concerns one of the wallet's loans, or the wallet is one of its
 * participants by the shared rule (`@vaipakam/lib/activityParticipants`: the
 * actor plus the parties each event names). Never because the wallet's
 * address appears somewhere in the event's args. That last form is the rule
 * #2703 replaced, and it is kept here only as the NEGATIVE oracle: a
 * transaction whose events name the wallet as text while none of them admits
 * it is exactly a row the old page showed and the new one must not.
 *
 * The participants function is passed in rather than imported, because this
 * module is shared by a drive that runs under plain node (which loads the
 * TypeScript library through tsx at run time) and by its vitest suite (which
 * imports the library directly). One rule either way; no copy of it here.
 *
 * Pure: no I/O, no browser. Every input is something the PAGE itself
 * received or rendered, so the comparison has no race with the live feed.
 */

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const ADDRESS_TEXT = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const TX_HREF = /\/tx\/(0x[0-9a-fA-F]{64})(?![0-9a-fA-F])/;

/** The indexer sends args it could not parse as a raw string; such an event
 *  names no participant the rule can read (the page's own reading). */
function argsObject(ev) {
  return typeof ev.args === 'object' && ev.args !== null ? ev.args : {};
}

/** The text form of an event's args, lower-cased: what the retired rule
 *  searched. Strings are searched as they arrived. */
function argsText(ev) {
  if (typeof ev.args === 'string') return ev.args.toLowerCase();
  try {
    return JSON.stringify(ev.args ?? null).toLowerCase();
  } catch {
    return '';
  }
}

/** Whether the retired address-in-args rule would have kept `ev` for `me`. */
export function namesAsText(ev, me) {
  return argsText(ev).includes(me);
}

/** Whether `ev` belongs on `me`'s page: one of its loans, or a participant. */
export function admits(ev, me, loanIds, participants) {
  if (ev.loanId !== null && ev.loanId !== undefined && loanIds.has(Number(ev.loanId))) return true;
  return participants(ev.kind, argsObject(ev)).includes(me);
}

/** A transaction's key as the page links it, or null for an event without one. */
export function txKeyOf(ev) {
  return typeof ev.txHash === 'string' && ev.txHash.length > 0 ? ev.txHash.toLowerCase() : null;
}

/**
 * What the page should show for `me` over `events`, by transaction (the page
 * coalesces each transaction to one row):
 *   - `admitted`: transactions with at least one admitted event;
 *   - `admittedWithoutTx`: admitted events carrying no transaction hash (each
 *     renders as its own row with no link);
 *   - `namedOnly`: transactions whose events name `me` as text while none of
 *     them admits it — the rows the retired rule showed;
 *   - `outsideLoans`: transactions none of whose events is admitted, but one
 *     of which belongs to a loan outside `loanIds`.
 *
 * `loanIds` is the part of the page's loan set this oracle can SEE: the
 * indexer legs the page read. The page also adds the loans the wallet holds
 * on chain, read over RPC, which the drive does not reconstruct. That set
 * only ever ADDS loans, so a transaction admitted here must be on the page,
 * while a rendered transaction in `outsideLoans` may be there because of a
 * loan only the chain read knew: it cannot be judged either way, and is
 * reported as such rather than as a defect.
 * Each map value is `{ block, kinds }`, for the report.
 */
export function expectedRows({ events, me, loanIds, participants }) {
  const admitted = new Map();
  const named = new Map();
  const loanTied = new Map();
  let admittedWithoutTx = 0;
  for (const ev of events) {
    const tx = txKeyOf(ev);
    const isAdmitted = admits(ev, me, loanIds, participants);
    if (tx === null) {
      if (isAdmitted) admittedWithoutTx += 1;
      continue;
    }
    const into = (map) => {
      const row = map.get(tx) ?? { block: Number(ev.blockNumber), kinds: [] };
      row.kinds.push(ev.kind);
      map.set(tx, row);
    };
    if (isAdmitted) into(admitted);
    else {
      if (namesAsText(ev, me)) into(named);
      if (ev.loanId !== null && ev.loanId !== undefined) into(loanTied);
    }
  }
  const notAdmitted = (map) => new Map([...map].filter(([tx]) => !admitted.has(tx)));
  return { admitted, admittedWithoutTx, namedOnly: notAdmitted(named), outsideLoans: notAdmitted(loanTied) };
}

/**
 * The rendered page's rows, read from what the DOM carried: each row's
 * transaction link (or none), and whether it is a #2643 repair observation
 * (which links no transaction by design and is not compared here).
 */
export function renderedRows(rows) {
  const tx = new Set();
  let withoutTx = 0;
  let observations = 0;
  const unreadable = [];
  for (const r of rows) {
    if (r.observation) {
      observations += 1;
      continue;
    }
    if (r.href === null || r.href === undefined) {
      withoutTx += 1;
      continue;
    }
    const m = TX_HREF.exec(r.href);
    if (m) tx.add(m[1].toLowerCase());
    else unreadable.push(r.href);
  }
  return { tx, withoutTx, observations, unreadable };
}

/**
 * Compare the rendered rows with the expected ones. Every list but
 * `undetermined` is a finding:
 *   - `undetermined`: rendered transactions only a loan outside the visible
 *     loan set could admit (see `expectedRows`) — not judged either way;
 *   - `unexpected`: rendered transactions no event admits, and no loan
 *     outside the visible set could;
 *   - `namedShown`: the subset of those the retired rule would have shown —
 *     the #2703 regression itself, reported by name;
 *   - `missing`: admitted transactions the page did not render;
 *   - `withoutTxMismatch`: the count of link-less rows differs from the
 *     admitted events without a hash;
 *   - `unreadable`: a transaction link this oracle could not read.
 */
export function compareRendered(expected, rendered) {
  const notAdmitted = [...rendered.tx].filter((tx) => !expected.admitted.has(tx));
  const undetermined = notAdmitted.filter((tx) => expected.outsideLoans.has(tx));
  const unexpected = notAdmitted.filter((tx) => !expected.outsideLoans.has(tx));
  const namedShown = unexpected.filter((tx) => expected.namedOnly.has(tx));
  const missing = [...expected.admitted.keys()].filter((tx) => !rendered.tx.has(tx));
  const withoutTxMismatch =
    rendered.withoutTx === expected.admittedWithoutTx
      ? null
      : { rendered: rendered.withoutTx, expected: expected.admittedWithoutTx };
  return {
    undetermined,
    unexpected,
    namedShown,
    missing,
    withoutTxMismatch,
    unreadable: rendered.unreadable,
    ok:
      unexpected.length === 0 && missing.length === 0 && withoutTxMismatch === null && rendered.unreadable.length === 0,
  };
}

/**
 * The pages of the LAST cursor walk in one series of responses, in arrival
 * order (`{ before, nextBefore }` each): from the last request carrying no
 * `before` to the end, provided each later page asked for the cursor the
 * page before it returned. `null` when there is no walk or it does not chain.
 * One series at a time: walks the page runs side by side (a lender and a
 * borrower list) interleave, so the caller separates them first.
 */
/** A cursor as text: a request carries it as a query string, while a response
 *  may return it as a number (the loan lists do), so the two are compared
 *  as text. Absent and null are the same "no cursor". */
function cursorKey(c) {
  return c === null || c === undefined ? null : String(c);
}

export function lastChain(responses) {
  let start = -1;
  for (let i = 0; i < responses.length; i++) if (cursorKey(responses[i].before) === null) start = i;
  if (start === -1) return null;
  const walk = responses.slice(start);
  for (let i = 1; i < walk.length; i++) {
    if (cursorKey(walk[i].before) !== cursorKey(walk[i - 1].nextBefore)) return null;
  }
  return walk;
}

/**
 * The events of the page's LAST activity scan, from its own `/activity`
 * responses in arrival order (`{ before, chainId, events, nextBefore }`).
 *
 * The page fetches the protocol-wide feed newest first and follows the
 * cursor a few pages: a scan starts with a request carrying no `before`, and
 * each later page asks for the previous page's `nextBefore`. A refetch starts
 * a new scan. The scan the page rendered is the last one, provided the drive
 * waited for the page to go quiet before reading it.
 *
 * `null` when there is no scan, or when its pages do not chain (a page asked
 * for a cursor no earlier page in the scan returned): then the bodies cannot
 * be read as the page's input, and the drive must not judge the page by them.
 */
export function lastScan(responses) {
  const scan = lastChain(responses);
  if (scan === null) return null;
  return {
    chainIds: [...new Set(scan.map((p) => p.chainId))],
    events: scan.flatMap((p) => p.events),
    pages: scan.length,
    reachedEnd: cursorKey(scan[scan.length - 1].nextBefore) === null,
  };
}

/** Every address the events' args name, lower-cased, without the zero
 *  address: the population the retired rule could have admitted. */
export function namedAddresses(events) {
  const seen = new Set();
  for (const ev of events) {
    for (const m of argsText(ev).matchAll(ADDRESS_TEXT)) seen.add(m[0].toLowerCase());
  }
  seen.delete(ZERO_ADDRESS);
  return seen;
}

/**
 * Wallets worth observing on one chain's feed, from the events alone (the
 * loan leg needs a per-wallet read and is the page's to make). For each
 * address named anywhere in the args: the transactions the participants rule
 * admits it to, and the transactions that name it without admitting it.
 *
 * Picks, in order, without repeats, up to `max`:
 *   1. the address with the most named-only transactions (the exclusion
 *      half of the claim; ties to the one with more admitted ones);
 *   2. the address with the most admitted transactions (the admission half).
 * then the next best by admitted count. `isWallet(address)` filters out
 * contracts: a token or a deployment is named in many events and is nobody's
 * Activity page.
 */
export function pickCandidates({ events, participants, isWallet = () => true, max = 2 }) {
  const seen = namedAddresses(events);
  const scored = [];
  for (const address of seen) {
    if (!isWallet(address)) continue;
    const { admitted, namedOnly } = expectedRows({
      events,
      me: address,
      loanIds: new Set(),
      participants,
    });
    scored.push({ address, admitted: admitted.size, namedOnly: namedOnly.size });
  }
  const byAddress = (a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  const picks = [];
  const take = (list) => {
    for (const c of list) {
      if (picks.length >= max) return;
      if (picks.some((p) => p.address === c.address)) continue;
      picks.push(c);
      return;
    }
  };
  take(
    scored
      .filter((c) => c.namedOnly > 0)
      .sort((a, b) => b.namedOnly - a.namedOnly || b.admitted - a.admitted || byAddress(a, b)),
  );
  const byAdmitted = scored
    .filter((c) => c.admitted > 0)
    .sort((a, b) => b.admitted - a.admitted || b.namedOnly - a.namedOnly || byAddress(a, b));
  while (picks.length < max) {
    const before = picks.length;
    take(byAdmitted);
    if (picks.length === before) break;
  }
  return picks;
}
