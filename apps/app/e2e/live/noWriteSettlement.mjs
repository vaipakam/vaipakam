/**
 * How a live drive that MAY write settles a run its write plan did not let
 * write (#2505).
 *
 * Two drivers sign through a write plan (`live-internal-match-claim.mjs`,
 * `live-lender-close-out.mjs`). Before the plan sends, a run can stop for a
 * reason that is no finding (a precondition the drive needs), or because the
 * page did not do what the drive expected (a missing row, a button that
 * never came up, a page that sent nothing after its button was clicked).
 *
 * THE RULE (#2505 r48, owner decision 2026-10-15). A page that did not do
 * what was expected, and showed nothing that says why, is UNDETERMINED,
 * never FAIL. Rounds 33 to 48 tried to earn a FAIL there by proving from
 * chain reads that nothing outside the page could explain it: endpoint
 * re-reads, a window over the Diamond's events, the page's own sanctions
 * reads and simulations. Every round found another explanation those reads
 * could not see (an oracle flag that came and went, an auto-pause that
 * expired without an event, a feed off the Diamond, a reorganisation, a
 * lagging backend). The set has no bound, so the proof was deleted rather
 * than extended. What the page SHOWS is still judged: a failed check, an
 * error page, a wrong line is a FAIL.
 *
 * What this module still establishes, in one order, is whether THIS WALLET
 * wrote, which the plan cannot say for a send the page made through another
 * connector. Only the wallet's nonce can:
 *
 *  1. CLOSE THE BROWSER. The page is the only actor that can add a page
 *     error, a refused request or a send through another connector. Once it
 *     is closed, all three are frozen.
 *  2. JUDGE THE PAGE LEDGERS, now complete.
 *  3. If the plan sent, stop here: the drive's own outcome checks decide.
 *  4. READ THE NONCE, LAST. Nothing was pending at startup (the baseline
 *     refuses a wallet with a pending transaction), so a count unchanged at
 *     both the pending and the mined tag proves no transaction from this
 *     wallet is pending or mined since.
 *
 * Then {@link resolveSettlement} applies the rule.
 */

/**
 * A precondition that stopped the drive without a finding. It becomes
 * BLOCKED at settlement when the run provably wrote nothing and nothing was
 * recorded before it.
 */
export class Held extends Error {}

/**
 * The page did not do what the drive expected, and showed nothing that says
 * why: a missing row, an unexpected state, a button that never came up, a
 * page that sent nothing after its button was clicked. Something outside the
 * page may explain it, and the drive cannot rule that out, so it is recorded
 * as NOT ESTABLISHED (UNDETERMINED), never as a failed check (#2505 r48). A
 * failure already recorded stands beside it.
 */
export class Suspect extends Error {
  /** @param {{ row: string, key: string, label: string, detail?: string }} check */
  constructor(message, check) {
    super(message);
    // Every suspect names the check it leaves open: without one it would be
    // recorded nowhere, and the run could PASS over it.
    if (!check?.row || !check?.key || !check?.label) throw new TypeError(`Suspect "${message}" names no check`);
    this.check = check;
  }
}

/**
 * Loan fields the notification bookkeeping writes on its own schedule. A
 * change in them alone says nothing about the loan's state, so a comparison
 * of two loan reads ignores them.
 */
export const LOAN_BOOKKEEPING_FIELDS = Object.freeze(['lenderNotifBilled', 'borrowerNotifBilled']);

/**
 * The keys whose values differ between two plain records (addresses compared
 * case-insensitively, bigints by value), minus `ignore`.
 */
export function changedFields(before, after, ignore = []) {
  const enc = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : typeof x === 'string' ? x.toLowerCase() : x));
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((k) => !ignore.includes(k) && enc(before?.[k]) !== enc(after?.[k]));
}

const describe = (err) => String(err?.shortMessage ?? err?.message ?? err).split('\n')[0].slice(0, 300);

/** Both of this wallet's nonce counts: `pending` and `latest` (mined). */
async function nonceCounts(pub, wallet) {
  const [pending, mined] = await Promise.all([
    pub.getTransactionCount({ address: wallet, blockTag: 'pending' }),
    pub.getTransactionCount({ address: wallet, blockTag: 'latest' }),
  ]);
  return { pending, mined };
}

/**
 * This wallet's nonce before any browser activity. A transaction already
 * pending could be replaced at the same nonce, which leaves the count
 * unchanged, so a wallet with one gives no baseline (`blocked`).
 */
export async function nonceBaseline(pub, wallet) {
  const { pending, mined } = await nonceCounts(pub, wallet);
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
 * The nonce against the baseline, read at BOTH tags, as the baseline was
 * (#2505 r48). Only both counts equal to the baseline prove no send. A higher
 * one is a send by this wallet that the plan never saw (whose, the count
 * cannot say). A lower one, or two that disagree, means the node's view is
 * inconsistent or moved backwards (a reorg, a lagging backend), and a send
 * could hide behind it, so it proves nothing.
 */
export async function reconcileNonce(pub, wallet, baseline) {
  let counts;
  try {
    counts = await nonceCounts(pub, wallet);
  } catch (err) {
    return { kind: 'unknown', why: `the direct RPC could not read the wallet nonce (${describe(err)})` };
  }
  const { pending, mined } = counts;
  if (pending === baseline && mined === baseline) return { kind: 'unchanged' };
  if (pending > baseline || mined > baseline) return { kind: 'sent', from: baseline, to: pending > mined ? pending : mined };
  return {
    kind: 'unknown',
    why: `the nonce read ${pending} pending and ${mined} mined against the startup ${baseline}: the node's view is inconsistent or moved backwards, and a send could hide behind it`,
  };
}

/**
 * Steps 1 to 4 above, in that order. `judgeLedgers` records the page checks.
 * Returns `{ plan: true }` when the plan sent, else the nonce.
 */
export async function settleRun({ closeBrowser, judgeLedgers, wrotePlan, pub, wallet, baseline }) {
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
  // A browser that did not close may still be running, and could send after
  // the nonce read below, so no read here can rule a send out (#2505 r34).
  const nonce = closeFailed
    ? { kind: 'unknown', why: `the browser could not be closed (${closeFailed}), so a send after the final nonce read cannot be ruled out` }
    : await reconcileNonce(pub, wallet, baseline);
  return { plan: false, nonce };
}

const join = (...parts) => parts.filter(Boolean).join('; ') || null;

/**
 * The one rule, for a settled run. Inputs: what {@link settleRun} returned,
 * the held reason (or null), the stop reason of a PLAIN exception (or null),
 * a thrown {@link Suspect} (or null), the count of failures recorded so far,
 * and how to name the subject. Returns one of:
 *
 *  - `{ blocked }`: provably no write, nothing recorded, no definite stop,
 *    and a hold explains the run;
 *  - the verdict inputs, `wrote`, `stopped`, `gateEscape` (always false
 *    here), `writeUnknown`, plus `undetermined` (the suspect's check and
 *    why) when a suspect stands; the caller records it as not established
 *    before the verdict. It is never recorded as a failure (#2505 r48).
 *
 * Precedence, in order:
 *
 *  1. WHAT THE PAGE SHOWED STANDS. A failure already recorded, or a plain
 *     exception (a page that answered 4xx, a navigation that went elsewhere),
 *     is an observed defect: the run FAILs, with whatever the nonce showed
 *     stated beside it and `writeUnknown` set when it could not prove no
 *     send, so the FAIL never claims a write-free run. A suspect beside it
 *     is returned as `undetermined` and recorded as not established.
 *  2. A WRITE THAT CANNOT BE RULED OUT. The plan sent nothing, but the
 *     nonce moved or could not be read: `wrote: true, writeUnknown: true`,
 *     which the shared verdict reports as UNDETERMINED. A moved nonce is NOT
 *     reported as the page escaping the gate: the drive runs on a throwaway
 *     profile with no connector pairing, so the page has no way to sign but
 *     the gated wallet, and a send the plan never saw is far likelier
 *     another user of the same dev wallet. That attribution is inferred, and
 *     stated as such.
 *  3. Provably no write: a hold is BLOCKED; a suspect is UNDETERMINED;
 *     otherwise the run goes on to its verdict.
 */
export function resolveSettlement({ settled, held, stopped, suspect, findings, subject }) {
  const undetermined = suspect?.check ? { ...suspect.check, why: suspect.message } : null;
  if (settled.plan) {
    const unclosed = settled.closeFailed ? `the browser could not be closed (${settled.closeFailed}), so the page's ledgers may be incomplete` : null;
    return { wrote: true, stopped: join(stopped, suspect?.message, held, unclosed), gateEscape: false };
  }
  const { nonce } = settled;
  const nonceNote =
    nonce.kind === 'sent'
      ? `the plan sent nothing, but this wallet's nonce moved ${nonce.from} → ${nonce.to} during the drive; the throwaway profile carries no connector pairing, so this is inferred to be another user of the wallet (an operator, a script, a parallel run), and whether it touched ${subject} is not established`
      : nonce.kind === 'unknown'
        ? `the plan sent nothing, but whether this wallet sent anyway cannot be established: ${nonce.why}`
        : null;
  if (findings > 0 || stopped !== null) {
    // FAIL on what the page showed, with the write uncertainty carried beside
    // it rather than dropped (#2505 r39); a suspect beside it is not a second
    // failure (#2505 r48).
    return { wrote: false, writeUnknown: nonceNote !== null, gateEscape: false, stopped: join(stopped, held, nonceNote), undetermined };
  }
  if (nonceNote !== null) {
    return { wrote: true, writeUnknown: true, gateEscape: false, stopped: join(suspect?.message, held, nonceNote), undetermined };
  }
  const tail = "; this wallet's nonce shows no transaction pending or mined since startup";
  if (held !== null) return { blocked: join(held, suspect && `the drive then stopped (${suspect.message})`) + tail };
  return { wrote: false, gateEscape: false, stopped: null, undetermined };
}
