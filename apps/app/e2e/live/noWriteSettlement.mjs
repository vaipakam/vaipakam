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
 *     comparison the drive made, never a refusal it cannot date.
 *  5. READ THE NONCE, LAST. Nothing was pending at startup (the baseline
 *     refuses a wallet with a pending transaction), so an unchanged count
 *     proves no transaction from this wallet is pending or mined since.
 *
 * Then {@link resolveSettlement} applies the one rule. A stop that a move
 * could explain is never judged where it happens: the drive throws a
 * {@link Held} (a precondition) or a {@link Suspect} (an observation that is
 * a FAIL only if nothing moved), and the rule decides at the end.
 */

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
 * Steps 1 to 5 above, in that order. `factsNow` returns `{ moved }`,
 * `{ unknown }` or `{}` and never throws; `judgeLedgers` records the page
 * checks. Returns `{ plan: true }` when the plan sent, else the facts and
 * the nonce.
 */
export async function settleRun({ closeBrowser, judgeLedgers, wrotePlan, factsNow, pub, wallet, baseline }) {
  let closeFailed = null;
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
  const facts = await factsNow();
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
 *     nonce showed stated beside it. Only a {@link Held} or a
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
    return { wrote: false, gateEscape: false, stopped: join(stopText, held, nonceNote), recordSuspect };
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
