/**
 * How a live drive that MAY write settles a run its write plan did not let
 * write (#2505).
 *
 * Two drivers sign through a write plan (`live-internal-match-claim.mjs`,
 * `live-lender-close-out.mjs`). Before the plan sends, a run can stop for a
 * reason that is no finding: a precondition the drive needs, or a loan that
 * moved under it (a keeper closed it, the position was transferred, the
 * protocol paused). Such a run is BLOCKED, but only once two things are
 * established, and both used to be established path by path:
 *
 *  - that THIS WALLET sent nothing, which the plan cannot say for a send the
 *    page made through another connector. Only the wallet's nonce can.
 *  - that the loan moved, re-read from the chain wherever a stop or a
 *    missing element could be explained by a move.
 *
 * Thirty-three review rounds found the same seam again and again: a ledger
 * judged before an await the page kept running through, a nonce read before
 * a re-read the page could send during, a catch that judged a stop its own
 * way, a fact the re-read did not compare. This module is the one place that
 * settles such a run, in one order, so no path can get the order wrong:
 *
 *  1. CLOSE THE BROWSER. The page is the only actor that can add a page
 *     error, a refused request or a send through another connector. Once it
 *     is closed, all three are frozen.
 *  2. JUDGE THE PAGE LEDGERS, now complete.
 *  3. If the plan sent, stop here: the drive's own outcome checks decide.
 *  4. RE-READ THE FACTS the drive's judgements rested on, once. Each driver
 *     reads its loan-scoped records whole and asks the chain the question
 *     the page asks before it signs: a simulation of the very call. Every
 *     gate the contract applies (a pause, a sanctions flag, a KYC tier, the
 *     sequencer, the grace period) is then covered without being listed.
 *     Each fact is compared with the same fact read at startup, where the
 *     simulation must have given the answer the drive needs (a refusal there
 *     is BLOCKED before the browser starts), so "changed" is always a
 *     comparison the drive made, never a refusal it cannot date. Two
 *     endpoints cannot see a change that came and went, so the chain's own
 *     events over the drive's window are read too ({@link loanActivity}).
 *     Where the page withheld a write, the drive also keeps what the page
 *     itself was told (its sanctions read, its simulation of the call).
 *  5. READ THE NONCE, LAST. Nothing was pending at startup (the baseline
 *     refuses a wallet with a pending transaction), so an unchanged count
 *     proves no transaction from this wallet is pending or mined since.
 *
 * Then {@link resolveSettlement} applies the one rule. A stop that a move
 * could explain is never judged where it happens: the drive throws a
 * {@link Held} (a precondition) or a {@link Suspect} (an observation that is
 * a FAIL only if nothing moved), and the rule decides at the end.
 */

import { decodeEventLog } from 'viem';

/**
 * A precondition that stopped the drive without a finding. It becomes
 * BLOCKED at settlement when the run provably wrote nothing and nothing was
 * recorded before it.
 */
export class Held extends Error {}

/**
 * An observation that is a FAIL unless the loan moved under the drive: a
 * missing row, an unexpected line, a button that never came up, a reverted
 * estimate. The page may be right to show it about a loan that moved, so it
 * is recorded as a failed check only if the re-read at settlement shows the
 * loan unmoved; otherwise the run is BLOCKED. A failure already recorded
 * stands either way, and so does this one alongside it.
 */
export class Suspect extends Error {
  /** @param {{ row: string, key: string, label: string, detail?: string }} check */
  constructor(message, check) {
    super(message);
    this.check = check;
  }
}

const describe = (err) => String(err?.shortMessage ?? err?.message ?? err).split('\n')[0].slice(0, 300);

/**
 * This wallet's nonce before any browser activity. A transaction already
 * pending could be replaced at the same nonce, which leaves the count
 * unchanged, so a wallet with one gives no baseline (`blocked`).
 */
export async function nonceBaseline(pub, wallet) {
  const [pending, mined] = await Promise.all([
    pub.getTransactionCount({ address: wallet, blockTag: 'pending' }),
    pub.getTransactionCount({ address: wallet, blockTag: 'latest' }),
  ]);
  if (pending > mined) {
    return { blocked: `${wallet} has ${pending - mined} transaction(s) pending at startup; its nonce could not tell a replacement from no send` };
  }
  // Pending below mined is no pending transaction: it is the node's view
  // disagreeing with itself (another backend, a reorg between the reads),
  // the same inconsistency the reconciliation reads as unknown (#2505 r34).
  if (pending < mined) {
    return { blocked: `${wallet}'s pending nonce (${pending}) read below its mined nonce (${mined}), so the node's view is inconsistent and no startup baseline can be established` };
  }
  return { nonce: pending };
}

/**
 * The nonce against the baseline. Only an unchanged count proves no send.
 * A higher one is a send by this wallet that the plan never saw (whose, the
 * count cannot say). A lower one means the
 * node's view moved backwards (a reorg, another backend), and a send could
 * have brought it back to the baseline unseen, so it proves nothing.
 */
export async function reconcileNonce(pub, wallet, baseline) {
  let now;
  try {
    now = await pub.getTransactionCount({ address: wallet, blockTag: 'pending' });
  } catch (err) {
    return { kind: 'unknown', why: `the direct RPC could not read the wallet nonce (${describe(err)})` };
  }
  if (now === baseline) return { kind: 'unchanged' };
  if (now > baseline) return { kind: 'sent', from: baseline, to: now };
  return {
    kind: 'unknown',
    why: `the nonce read ${now}, below the startup ${baseline}: the node's view moved backwards, and a send could have restored the count unseen`,
  };
}

/**
 * Loan-record fields a transaction can change without touching anything a
 * close-out or claim surface reads: `LoanFacet.markNotifBilled` latches one
 * of these when the notification watcher bills a side, and changes nothing
 * else on the loan (#2505 r37). A change to one is reported by
 * {@link changedFields} as bookkeeping, never as the loan moving. The list is
 * deliberately a DENY list: a field added to the record later counts as
 * movement until someone shows it is bookkeeping, so the comparison can only
 * err towards BLOCKED, never towards a FAIL a move explains.
 */
export const LOAN_BOOKKEEPING_FIELDS = Object.freeze(['lenderNotifBilled', 'borrowerNotifBilled']);

/**
 * Diamond events that change a gate either surface sits behind, whatever
 * loan they concern: the protocol and asset pauses, the swap-adapter roster,
 * the KYC tiers and enforcement, the sanctions oracle, the grace schedule. A
 * pair of them (paused, then unpaused) leaves both endpoint reads identical,
 * so only the window sees it (#2505 r42). The list is explicit, and what it
 * does not reach is stated: a gate kept on another contract (the sanctions
 * list itself, a price feed, the sequencer feed) is seen only at the two
 * endpoints and in what the page was told.
 */
export const GATE_EVENTS = Object.freeze([
  'Paused',
  'Unpaused',
  'AutoPaused',
  'AssetPauseEnabled',
  'AssetPauseDisabled',
  'AggregatorAdaptersPausedSet',
  'SwapAdapterAdded',
  'SwapAdapterRemoved',
  'SwapAdapterDisabledSet',
  'SwapAdaptersReordered',
  'KYCTierUpdated',
  'KYCStatusUpdated',
  'KYCEnforcementSet',
  'SanctionsOracleSet',
  'SanctionsFlagRefreshed',
  'GraceBucketsUpdated',
]);

/**
 * The gates the lender CLAIM sits behind, and only those: `claimAsLender` is
 * `whenNotPaused` and screens the caller against the sanctions oracle
 * (`ClaimFacet._claimAsLenderImpl`); it reads no asset pause, no KYC tier, no
 * adapter roster and no grace schedule, so a change to any of those during a
 * claim run is not movement (#2505 r45, r46). The close-out, which routes a
 * sale past grace, sits behind all of {@link GATE_EVENTS}.
 */
export const CLAIM_GATE_EVENTS = Object.freeze(['Paused', 'Unpaused', 'AutoPaused', 'SanctionsOracleSet', 'SanctionsFlagRefreshed']);

/**
 * What can move the LOAN itself without leaving a trace at the endpoints,
 * which is all this window is for: a status edge, which every status write
 * announces from the one chokepoint (`LibLifecycle`, `LoanStatusChanged` for
 * `loan.id`), and a Transfer of a position NFT, which can go away and come
 * back. Every other change to the loan (an amount, a stamp, a keeper flag)
 * persists in the record or the claim the endpoints compare, so it needs no
 * window, and an event that merely carries this loan's id is not movement
 * (#2505 r46). The list is explicit; it does not grow by matching names.
 */
export const LOAN_MOVEMENT_EVENTS = Object.freeze(['LoanStatusChanged', 'Transfer']);

/** A block named by number AND hash, so a reorganisation can be told apart
 *  from a quiet chain: `{ number, hash }`. */
export async function blockMark(pub, blockTag = 'latest') {
  const b = await pub.getBlock({ blockTag });
  return { number: b.number, hash: b.hash };
}

/**
 * Every transaction that touched what the drive rests on, in the window
 * strictly after `start` (a block marked at startup, before the browser) up
 * to and including `cutoff` (marked just after the browser closed, so
 * nothing later counts, #2505 r46). `cutoff.edge`, when given, is the block
 * marked just BEFORE the close: an event after it was mined while the page
 * was closing and may or may not have been seen, so it makes the window
 * unknown rather than explaining anything (#2505 r47). Endpoint comparison cannot
 * see a change that came and went (a status that moved and was cured, a
 * position transferred away and back, a pause lifted again); the chain's own
 * logs can. Counted, from the Diamond: {@link LOAN_MOVEMENT_EVENTS} for this
 * loan (a Transfer only of one of `tokenIds`, the position NFTs living on the
 * Diamond), and any event in `gates` (the surface's own:
 * {@link CLAIM_GATE_EVENTS} or {@link GATE_EVENTS}) that applies (one naming
 * a user or an asset only for `wallets` or `assets`).
 *
 * Both ends are checked by hash, before and after the scan: a block at either
 * height that is no longer the one marked means the chain was reorganised
 * across the window, and the logs read describe a chain the page may not have
 * seen, so the window is unknown (#2505 r46). So is a cutoff below the start.
 *
 * Returns `{ moved }`, `{ unknown }` or `{}`; an RPC failure never throws
 * (it is `unknown`), and only a caller that names no `gates` does.
 */
export async function loanActivity({ pub, diamond, abi, start, cutoff, loanId, gates, tokenIds = [], wallets = [], assets = [] }) {
  // Each surface names the gates it sits behind; there is no default, so a
  // new caller cannot inherit another surface's (#2505 r45).
  if (!Array.isArray(gates)) throw new TypeError('loanActivity: `gates` (the surface\'s gate events) is required');
  if (!start?.hash || !cutoff?.hash) return { unknown: 'the window of blocks the drive ran across was not marked, so the Diamond\'s events in it could not be read' };
  const ids = new Set(tokenIds.filter((t) => t !== undefined && t !== null).map((t) => BigInt(t)));
  const want = BigInt(loanId);
  const lower = (x) => String(x ?? '').toLowerCase();
  const people = new Set(wallets.map(lower));
  const ours = new Set(assets.map(lower));
  // A gate event that names ONE user or ONE asset counts only for this
  // drive's wallets or this loan's assets (#2505 r43); a protocol-wide one
  // (a pause, the adapter roster, enforcement, the oracle) always counts.
  const gateApplies = (ev) => {
    const a = ev.args ?? {};
    if ('user' in a) return people.has(lower(a.user));
    if ('who' in a) return people.has(lower(a.who));
    if (ev.eventName === 'AssetPauseEnabled' || ev.eventName === 'AssetPauseDisabled') return ours.has(lower(a.asset));
    return true;
  };
  const movesLoan = (ev) => {
    if (!LOAN_MOVEMENT_EVENTS.includes(ev.eventName)) return false;
    if (ev.eventName === 'Transfer') return ids.has(BigInt(ev.args?.tokenId ?? -1n));
    return typeof ev.args?.loanId === 'bigint' && ev.args.loanId === want;
  };
  const span = `blocks ${start.number + 1n}–${cutoff.number}`;
  try {
    if (cutoff.number < start.number) {
      return { unknown: `the block marked at the browser's close (${cutoff.number}) is behind the startup block ${start.number}, so the Diamond's events across the drive could not be read` };
    }
    const edge = cutoff.edge ?? null;
    const reorganised = async () => {
      for (const m of [start, edge, cutoff].filter(Boolean)) {
        const now = await pub.getBlock({ blockNumber: m.number });
        if (lower(now.hash) !== lower(m.hash)) return m.number;
      }
      return null;
    };
    const before = await reorganised();
    if (before !== null) return { unknown: `block ${before} is no longer the one marked during the drive (the chain was reorganised), so the Diamond's events in ${span} do not describe what the page saw` };
    const logs = [];
    for (let from = start.number + 1n; from <= cutoff.number; from += 2000n) {
      const to = from + 1999n < cutoff.number ? from + 1999n : cutoff.number;
      logs.push(...(await pub.getLogs({ address: diamond, fromBlock: from, toBlock: to })));
    }
    const after = await reorganised();
    if (after !== null) return { unknown: `block ${after} changed while the Diamond's events in ${span} were read (the chain was reorganised), so they do not describe what the page saw` };
    const hits = [];
    const straddling = [];
    for (const log of logs) {
      let ev;
      try {
        ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
      } catch {
        // Not an event the Diamond declares: it cannot be named, so it is
        // not counted (the union ABI carries every facet's events, #2394).
        continue;
      }
      if (!((gates.includes(ev.eventName) && gateApplies(ev)) || movesLoan(ev))) continue;
      const named = `${ev.eventName} in ${log.transactionHash} (block ${log.blockNumber})`;
      // Mined while the browser was closing: the page may or may not have
      // seen it, so it can explain nothing either way (#2505 r47).
      if (edge && BigInt(log.blockNumber) > edge.number) straddling.push(named);
      else hits.push(named);
    }
    if (straddling.length > 0) {
      return { unknown: `${straddling.length} event(s) that touched it were mined while the browser was closing (after block ${edge.number}), so whether the page saw them is unknown: ${straddling.slice(0, 5).join(', ')}` };
    }
    if (hits.length === 0) return {};
    return { moved: `${hits.length} event(s) in ${span} touched it: ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ', …' : ''}` };
  } catch (err) {
    return { unknown: `the direct RPC could not read the Diamond's events in ${span} (${describe(err)})` };
  }
}

/** Two fact readings as one: a move either shows wins, then an unknown. */
export function mergeFacts(...readings) {
  const moved = readings.map((r) => r?.moved).filter(Boolean);
  if (moved.length) return { moved: moved.join('; ') };
  const unknown = readings.map((r) => r?.unknown).filter(Boolean);
  return unknown.length ? { unknown: unknown.join('; ') } : {};
}

/** Fields of two decoded records that differ, by name (positional arrays by
 *  index), less any in `ignore`. Every other field counts: a record changes
 *  only by a transaction, so any change is the loan moving, whichever field
 *  the page reads. */
export function changedFields(before, after, ignore = []) {
  const enc = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : typeof x === 'string' ? x.toLowerCase() : x));
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((k) => !ignore.includes(k) && enc(before?.[k]) !== enc(after?.[k]));
}

/**
 * Steps 1 to 5 above, in that order. `factsNow(edge)` reads the facts AT
 * the block marked just before the browser closed (`{ number, hash }`, or
 * null when there is none, when it reads the head) and returns `{ moved }`, `{ unknown }` or `{}`, never
 * throwing; `activity(cutoff)` reads the event window up to it; `judgeLedgers` records the page
 * checks. Returns `{ plan: true }` when the plan sent, else the facts and
 * the nonce.
 */
export async function settleRun({ closeBrowser, judgeLedgers, wrotePlan, factsNow, activity, pub, wallet, baseline }) {
  let closeFailed = null;
  let edge = null;
  let edgeErr = null;
  try {
    edge = await blockMark(pub);
  } catch (err) {
    edgeErr = err;
  }
  try {
    await closeBrowser();
  } catch (err) {
    closeFailed = describe(err);
    console.log(`(browser close failed: ${closeFailed})`);
  }
  judgeLedgers();
  // After a send, a browser that did not close may have recorded more after
  // the ledgers were judged, so the run cannot PASS on them (#2505 r35).
  if (wrotePlan()) return { plan: true, closeFailed };
  // The browser's close, marked on both sides (#2505 r46–r47). `edge` is the
  // head just before it: the page was still open, so anything up to it is
  // something the page could have seen, and the re-read is taken there.
  // `cutoff` is the head just after it: the event window runs to it, and an
  // event in between is one the page may or may not have seen, so it makes
  // the window unknown rather than explaining anything. A browser that did
  // not close leaves no such boundary.
  let noCutoff = closeFailed ? `the browser could not be closed (${closeFailed}), so the drive has no block the page stopped observing at` : null;
  let cutoff = null;
  if (!closeFailed) {
    if (edgeErr) noCutoff = `the direct RPC could not read the head before the browser's close (${describe(edgeErr)})`;
    else {
      try {
        cutoff = { ...(await blockMark(pub)), edge };
      } catch (err) {
        noCutoff = `the direct RPC could not read the head at the browser's close (${describe(err)})`;
      }
    }
  }
  // The endpoint comparison and the window's transactions, one reading: a
  // change either shows counts (#2505 r42).
  const facts = mergeFacts(
    await factsNow(cutoff ? cutoff.edge : null),
    activity ? (cutoff ? await activity(cutoff) : { unknown: noCutoff }) : {},
  );
  // A browser that did not close may still be running, and could send after
  // the nonce read below, so no read here can rule a send out (#2505 r34).
  const nonce = closeFailed
    ? { kind: 'unknown', why: `the browser could not be closed (${closeFailed}), so a send after the final nonce read cannot be ruled out` }
    : await reconcileNonce(pub, wallet, baseline);
  return { plan: false, facts, nonce };
}

const join = (...parts) => parts.filter(Boolean).join('; ') || null;

/**
 * The one rule, for a settled run. Inputs: what {@link settleRun} returned,
 * the held reason (or null), the stop reason of a PLAIN exception (or null),
 * a thrown {@link Suspect} (or null), the count of failures recorded so far,
 * and how to name the facts. Returns one of:
 *
 *  - `{ blocked }`: provably no write, nothing recorded, no definite stop,
 *    and a hold or a move explains the run;
 *  - the verdict inputs, `wrote`, `stopped`, `gateEscape` (always false
 *    here), `writeUnknown`, plus `recordSuspect` when a suspect stands as a
 *    failed check (the caller records it before the verdict).
 *
 * Precedence, in order (#2505 r37):
 *
 *  1. WHAT THE PAGE DID STANDS. A failure already recorded, or a plain
 *     exception (a page that answered 4xx, a navigation that went elsewhere),
 *     is an observed defect. Neither a later move of the loan nor a nonce
 *     that cannot be read retracts it, so the run FAILs, with whatever the
 *     nonce showed stated beside it and `writeUnknown` set when it could
 *     not prove no send, so the FAIL never claims a write-free run. Only a {@link Held} or a
 *     {@link Suspect} is an observation a move can explain.
 *  2. A WRITE THAT CANNOT BE RULED OUT. The plan sent nothing, but the
 *     nonce moved or could not be read: `wrote: true, writeUnknown: true`,
 *     which the shared verdict reports as UNDETERMINED. A moved nonce is NOT
 *     reported as the page escaping the gate: the drive runs on a throwaway
 *     profile with no connector pairing, so the page has no way to sign but
 *     the gated wallet, and a send the plan never saw is far likelier
 *     another user of the same dev wallet (an operator, a script, a parallel
 *     run). That attribution is inferred, and stated as such.
 *  3. Provably no write: a hold or a move is BLOCKED; otherwise the suspect
 *     (if any) is recorded as the failed check it describes.
 */
export function resolveSettlement({ settled, held, stopped, suspect, findings, subject }) {
  const stopText = join(stopped, suspect?.message);
  const recordSuspect = Boolean(suspect?.check);
  if (settled.plan) {
    const unclosed = settled.closeFailed ? `the browser could not be closed (${settled.closeFailed}), so the page's ledgers may be incomplete` : null;
    return { wrote: true, stopped: join(stopText, held, unclosed), gateEscape: false };
  }
  const { facts, nonce } = settled;
  const nonceNote =
    nonce.kind === 'sent'
      ? `the plan sent nothing, but this wallet's nonce moved ${nonce.from} → ${nonce.to} during the drive; the throwaway profile carries no connector pairing, so this is inferred to be another user of the wallet (an operator, a script, a parallel run), and whether it touched ${subject} is not established`
      : nonce.kind === 'unknown'
        ? `the plan sent nothing, but whether this wallet sent anyway cannot be established: ${nonce.why}`
        : null;
  if (findings > 0 || stopped !== null) {
    // FAIL, with the write uncertainty carried beside it rather than dropped:
    // the verdict must not claim a write-free run it could not establish
    // (#2505 r39).
    return { wrote: false, writeUnknown: nonceNote !== null, gateEscape: false, stopped: join(stopText, held, nonceNote), recordSuspect };
  }
  if (nonceNote !== null) {
    return { wrote: true, writeUnknown: true, gateEscape: false, stopped: join(stopText, held, nonceNote), recordSuspect };
  }
  const moved = facts.moved
    ? `what ${subject} rests on changed by the verdict (${facts.moved})`
    : facts.unknown
      ? `whether what ${subject} rests on changed could not be re-read (${facts.unknown})`
      : null;
  const order = stopText !== null && moved !== null ? '; which came first is unknown' : '';
  const tail = "; this wallet's nonce shows no transaction pending or mined since startup";
  if (held !== null) return { blocked: join(held, stopText && `the drive then stopped (${stopText})`, moved) + tail };
  if (moved !== null) return { blocked: (stopText ? `the drive stopped (${stopText}), and ${moved}${order}` : moved) + tail };
  return { wrote: false, gateEscape: false, stopped: stopText, recordSuspect };
}
