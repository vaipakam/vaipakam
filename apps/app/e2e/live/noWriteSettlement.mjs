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
 * A higher one is a send the plan never allowed. A lower one means the
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
  if (now > baseline) return { kind: 'escaped', from: baseline, to: now };
  return {
    kind: 'unknown',
    why: `the nonce read ${now}, below the startup ${baseline}: the node's view moved backwards, and a send could have restored the count unseen`,
  };
}

/** Fields of two decoded records that differ, by name (positional arrays by
 *  index). Every field counts: a record changes only by a transaction, so
 *  any change is the loan moving, whichever field the page reads. */
export function changedFields(before, after) {
  const enc = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : typeof x === 'string' ? x.toLowerCase() : x));
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((k) => enc(before?.[k]) !== enc(after?.[k]));
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
 * the held reason (or null), the stop reason (or null), a thrown
 * {@link Suspect} (or null), the count of failures recorded so far, and how
 * to name the facts. Returns one of:
 *
 *  - `{ blocked }`: provably no write, nothing recorded, and a hold or a move
 *    explains the run;
 *  - `{ recordSuspect }` plus the verdict inputs, when a suspect stands as a
 *    failed check (the caller records it before the verdict);
 *  - the verdict inputs alone: `wrote`, `stopped`, `gateEscape`, `escape`.
 *
 * A write that cannot be ruled out is `wrote: true` with its reason in
 * `stopped`, which the shared verdict reports as UNDETERMINED: the drive
 * cannot say whether it wrote, so it cannot say either way what it did
 * (verdictContract.mjs, FOUR_VERDICT_DRIVERS).
 */
export function resolveSettlement({ settled, held, stopped, suspect, findings, subject }) {
  const stopText = join(stopped, suspect?.message);
  if (settled.plan) {
    const unclosed = settled.closeFailed ? `the browser could not be closed (${settled.closeFailed}), so the page's ledgers may be incomplete` : null;
    return { wrote: true, stopped: join(stopText, held, unclosed), gateEscape: false };
  }
  const { facts, nonce } = settled;
  if (nonce.kind === 'escaped') {
    return {
      wrote: true,
      gateEscape: true,
      escape: `this wallet's nonce moved ${nonce.from} → ${nonce.to}, but the write plan never allowed a send — a transaction went through another connector`,
      stopped: join(stopText, held),
      recordSuspect: Boolean(suspect?.check),
    };
  }
  if (nonce.kind === 'unknown') {
    return {
      wrote: true,
      writeUnknown: true,
      gateEscape: false,
      stopped: join(stopText, held, `the plan sent nothing, but whether this wallet sent anyway cannot be established: ${nonce.why}`),
      recordSuspect: Boolean(suspect?.check),
    };
  }
  // Provably no write from here on.
  if (findings > 0) return { wrote: false, gateEscape: false, stopped: join(stopText, held), recordSuspect: Boolean(suspect?.check) };
  const moved = facts.moved
    ? `what ${subject} rests on changed by the verdict (${facts.moved})`
    : facts.unknown
      ? `whether what ${subject} rests on changed could not be re-read (${facts.unknown})`
      : null;
  const order = stopText !== null && moved !== null ? '; which came first is unknown' : '';
  const tail = "; this wallet's nonce shows no transaction pending or mined since startup";
  if (held !== null) return { blocked: join(held, stopText && `the drive then stopped (${stopText})`, moved) + tail };
  if (moved !== null) return { blocked: (stopText ? `the drive stopped (${stopText}), and ${moved}${order}` : moved) + tail };
  return { wrote: false, gateEscape: false, stopped: stopText, recordSuspect: Boolean(suspect?.check) };
}
