/**
 * CONFIRMING A WRITE AT THE BLOCK IT LANDED IN (#2107).
 *
 * A drive that sends a transaction and then checks the state it was
 * supposed to change has a race that public RPC endpoints lose
 * routinely: the receipt can be served by a node that has the block
 * while the `eth_call` right after it is served by one that has not
 * applied it yet. The read then answers from older state — and the
 * value it answers with is EXACTLY THE PRE-WRITE VALUE, which is
 * indistinguishable, to a naive check, from the write having done
 * nothing.
 *
 * That is not a theoretical shape. `live-signed-book` cleanup reported
 * `ORDER … MAY STILL BE FILLABLE` against `app.vaipakam.com` on
 * 2026-09-10 for an order whose revocation had landed; reading the
 * chain afterwards showed the ledger sitting exactly at the ceiling.
 * The alarm was false, and it is the one alarm that must never be —
 * it tells an operator a signed lending offer is still fillable by
 * anyone holding the signature. An alarm that cries wolf is how a real
 * one eventually gets waved through.
 *
 * WHAT THIS FIXES IS THE MISSING THIRD ANSWER. The naive check has two:
 * the state is right, or the state is wrong. The situation above is
 * neither — no attempt produced an answer this could use. Reporting that
 * as "the state is wrong" states a fund-state conclusion the drive did
 * not establish,
 * which is the failure this repo's standing principle names directly.
 * So `confirmWrite` answers in three:
 *
 *   { ok: true }                  read at a block at or after the
 *                                 write, and the value is accepted
 *   { ok: false, observed }       read at a block at or after the
 *                                 write, and the value is WRONG — a
 *                                 real defect, reported immediately
 *   { ok: false, unconfirmed }    no attempt produced an answer this
 *                                 could use, from a node at or after
 *                                 that block — NOT a claim about the
 *                                 state, nor about why (round 5: a
 *                                 revert IS an answer, so "no node
 *                                 would answer" was never safe here)
 *
 * HOW THE BLOCK IS PINNED, and why it is not `receipt.blockNumber`
 * directly. Asking a node for state at a block it does not have gets an
 * error, so pinning to the receipt's own block would turn every
 * load-balancer miss into a failed read. Instead each attempt asks the
 * node for ITS OWN head, drops the attempt if that head is behind the
 * write, and reads pinned to that head. A node too far behind excludes
 * itself before it can answer, and pinning the read means a stale node
 * reached on the second hop errors rather than quietly answering from
 * older state. This is the shape `live-risk-access` already proved in
 * `tierZeroAtOrAfter` (Codex #1539 r9); this module is that shape made
 * shared rather than a fourth hand-rolled copy of it.
 *
 * WHAT "AT OR AFTER" DOES NOT COVER — a HEIGHT is not a chain (#2107
 * round 1). Two nodes can disagree at one height during a reorg, so a
 * read pinned to a height is not proof of the write's own history. This
 * deliberately does not chase that, and the reason is that the outcomes
 * fall the safe way for the predicates it is asked:
 *
 *   - A reorg that DROPPED the write leaves the canonical chain without
 *     it, so the read answers the pre-write value and this reports a
 *     WRONG value. That is the correct alarm, not a miss — the write
 *     really is not in the chain.
 *   - A transient read from a competing fork answers the same pre-write
 *     value, so it too reports WRONG. A false alarm, in the direction
 *     that sends someone to look rather than the direction that tells
 *     them not to.
 *   - A false CONFIRM would need a fork on which the state already
 *     satisfies the predicate. Both predicates in use ("the fill ledger
 *     is at its ceiling", "the offer's creator is zeroed") describe a
 *     position that cannot be taken, so a fork satisfying either is a
 *     fork on which the thing being confirmed is true anyway.
 *
 * Adding block-hash ancestry would buy the middle case and cost a
 * speculative branch on a path where no reorg has been observed —
 * which is the shape #2149 spent eleven review rounds on before
 * deleting it. The limit is stated here instead; if a reorg ever does
 * show up in a drive's output, it needs an owner decision, not a
 * defensive branch added in advance.
 *
 * A WRONG VALUE IS FINAL HERE — it is not polled through. That is the
 * one place this deliberately differs from `tierZeroAtOrAfter`, and the
 * difference is not cosmetic. There, the floor comes from an EARLIER
 * write while the drive waits for a UI-driven one whose block is
 * unknown, so a wrong value genuinely may mean "not landed yet". Here
 * the floor IS the block of the write being verified, so at any block
 * at or after it the answer is settled: the write is in that chain, or
 * the transaction is not in the canonical chain at all, or something
 * else changed the state. Every one of those is a finding. Retrying
 * until the chain says the expected thing would turn this helper into a
 * way of waiting out real defects, which is worse than the race it
 * exists to close.
 *
 * Deliberately imports nothing: the retry clock and the RPC are both
 * injected, so the whole decision is unit-testable without a chain
 * (`writeConfirm.test.mjs`).
 */

/**
 * Verify, at a block at or after `minBlock`, that `read` answers a value
 * `accept` is happy with.
 *
 * @param {object}   o
 * @param {(blockNumber: bigint) => Promise<any>} o.read
 *        Performs the read PINNED to the block it is handed. A read that
 *        ignores the argument reintroduces the race this closes.
 * @param {(value: any) => boolean} o.accept
 * @param {bigint}   o.minBlock        block the write landed in.
 * @param {() => Promise<bigint>} o.getBlockNumber   the node's own head.
 * @param {string}   [o.what]          names the state, for the message.
 * @param {number}   [o.timeoutMs]
 * @param {number}   [o.everyMs]
 * @param {() => number} [o.now]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @returns {Promise<
 *   | { ok: true, value: any, blockNumber: bigint }
 *   | { ok: false, unconfirmed: false, value: any, blockNumber: bigint }
 *   | { ok: false, unconfirmed: true, why: string }
 * >}
 */
export async function confirmWrite({
  read,
  decode = (raw) => raw,
  accept,
  minBlock,
  getBlockNumber,
  what = 'the written state',
  timeoutMs = 60_000,
  everyMs = 3_000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  deadlineTimer = (ms) => {
    let id;
    const promise = new Promise((r) => {
      id = setTimeout(r, ms);
    });
    return { promise, cancel: () => clearTimeout(id) };
  },
}) {
  const deadline = now() + timeoutMs;
  let behind = 0; // attempts dropped because the node's head was behind
  let lastErr = null;
  const giveUp = () => ({
    ok: false,
    unconfirmed: true,
    why: unconfirmedWhy({ what, minBlock, behind, lastErr, timeoutMs }),
  });

  /**
   * One attempt: ask the node its head, and if it is far enough along,
   * fetch the reply and decode it.
   *
   * `abandoned` is checked between the two requests, and it is the
   * difference between losing a race and stopping (#2107 round 4).
   * Attaching a `.catch` to the loser only silences a later rejection;
   * the attempt itself carries on, so once the head arrives it would
   * START A SECOND REQUEST after the deadline has already been reported.
   *
   * BE EXACT ABOUT WHAT THIS GUARANTEES, because the honest version is
   * narrower than "the attempt is cancelled": no NEW request is issued
   * once the budget has expired. A request already in flight cannot be
   * cancelled from here — viem's action API takes no abort signal, and
   * the transport's own signal is fixed when the client is built — so it
   * runs to that transport's timeout. What it cannot do is start another
   * one.
   */
  const attempt = async (abandoned) => {
    const head = await getBlockNumber();
    if (abandoned()) return { abandoned: true };
    if (head < minBlock) return { behind: true };
    return { value: decode(await read(head)), at: head };
  };

  for (let first = true; ; first = false) {
    // Every attempt AFTER the first is gated on the deadline. The cap on
    // the wait below is not enough on its own: a wait trimmed to land
    // exactly on the deadline would otherwise be followed by a full
    // attempt starting at it.
    if (!first && now() >= deadline) return giveUp();

    let got = false;
    let value;
    let at;
    try {
      // The attempt RACES the remaining budget, rather than the deadline
      // being checked between awaits. Checking between them is per-await
      // and grows with every await added: #2107 round 2 gated the start
      // of an attempt, and round 3 pointed out that `getBlockNumber` can
      // consume its own transport timeout and retries, so `read` still
      // begins after the deadline. Racing bounds the whole attempt,
      // including awaits nobody has written yet, and makes the budget a
      // promise about ELAPSED TIME rather than about attempt count.
      const remainingNow = first ? Math.max(0, deadline - now()) : deadline - now();
      const timer = deadlineTimer(remainingNow);
      let timedOut = false;
      const running = attempt(() => timedOut);
      try {
        const outcome = await Promise.race([
          running,
          timer.promise.then(() => {
            timedOut = true;
          }),
        ]);
        if (timedOut) {
          // The loser may still reject later; nothing is listening, and
          // an unhandled rejection would take the process down.
          running.catch(() => {});
          return giveUp();
        }
        if (outcome.abandoned) return giveUp();
        if (outcome.behind) behind += 1;
        else {
          value = outcome.value;
          at = outcome.at;
          got = true;
        }
      } finally {
        timer.cancel();
      }
    } catch (e) {
      // EVERY failure to obtain an answer retries until the deadline,
      // and nothing here tries to decide which ones are futile.
      //
      // Four review rounds tried. Each named the viem class that a
      // deterministic failure arrives as, and each round found the next
      // one the last had missed: a decode of empty data, then a decode
      // of wrong-sized data, then decode errors not carrying the
      // `Abi*Error` name at all, then — after the switch to a raw call —
      // `CallExecutionError -> ExecutionRevertedError` rather than the
      // `RawContractError` that had just been added for it. A predicate
      // wrong in four consecutive rounds is not one class short; it is
      // the wrong mechanism, and this repo's directive is to stop
      // patching a seam that keeps reappearing.
      //
      // What the classifier bought was PROMPTNESS — a revert reported at
      // once rather than after the budget — and an accurate sentence.
      // The sentence is worth keeping and does not need a taxonomy, so
      // `unconfirmedWhy` now states the cause it actually saw instead of
      // asserting that no node would answer. Promptness in a scenario no
      // run has produced is not worth a rule that has been wrong every
      // time it was written.
      //
      // A FAILURE TO DECODE IS ONE OF THEM, and it took until round 7 to
      // see why. Round 3 moved decoding outside this boundary on the
      // argument that a reply which arrived came back from every node,
      // so retrying could not help. That argument is false: one
      // load-balanced backend can serve `0x` or a truncated payload
      // while the next serves valid data — which is the very
      // endpoint-divergence this whole helper exists for. Round 3 was
      // right that decode failures must not be CLASSIFIED and wrong
      // about where to put them. Retrying them needs no classification
      // either, and it is what the uniform rule already says.
      //
      // So there is now ONE rule, not three: every failure to obtain a
      // usable answer retries, and the verdict names the cause without
      // claiming why.
      lastErr = e;
    }

    // `accept` stays outside the catch, and it is now the ONLY thing
    // that does. A predicate that throws — a field that moved, a shape
    // it did not expect — is a bug in the drive rather than a failure to
    // reach the chain, so retrying it would report the caller's mistake
    // as an endpoint problem.
    if (got) {
      return accept(value)
        ? { ok: true, value, blockNumber: at }
        : { ok: false, unconfirmed: false, value, blockNumber: at };
    }

    // The deadline is checked AFTER an attempt, so a zero budget still
    // asks once — and the wait is capped to what is left of it.
    const remaining = deadline - now();
    if (remaining <= 0) return giveUp();
    await sleep(Math.min(everyMs, remaining));
  }
}

/**
 * `confirmWrite`, with a failure OF THE CONFIRMATION ITSELF turned into
 * the unconfirmed verdict instead of a throw.
 *
 * Every call site sits inside a cleanup `catch` whose message says the
 * position may still rest and tells the operator to send the cancel
 * again by hand. A throw from the verification reaches that catch —
 * so the round-1 fix that made deterministic read failures propagate
 * re-created, through a longer route, exactly the false funds alarm
 * this PR exists to remove (#2107 round 2). The transaction's receipt
 * said `success`; a verifier that breaks afterwards does not retract
 * that evidence.
 *
 * The error is not swallowed — it is NAMED in `why`, which is strictly
 * more than the generic catch did with it, and the caller still reports
 * a failure. What changes is only the claim attached to it: "the
 * verification did not complete, here is why" rather than "these funds
 * may be at risk, go spend gas".
 *
 * Use this from a drive. `confirmWrite` still throws, because a caller
 * NOT inside a funds-alarm catch is better served by the exception.
 */
export async function confirmWriteOrReport(opts) {
  try {
    return await confirmWrite(opts);
  } catch (err) {
    const first = String(err?.message ?? err).split('\n')[0].slice(0, 200);
    return {
      ok: false,
      unconfirmed: true,
      // NO UNIVERSAL DIAGNOSIS. An earlier version of this said "every
      // node reproduces this or it is a fault in the drive", which is
      // the same unearned certainty this whole change removes elsewhere
      // (#2107 round 7): one backend can serve a malformed reply while
      // the next serves a good one. What is actually known is that this
      // confirmation did not complete and why it stopped — and that the
      // write's own receipt is untouched by either.
      why:
        `THE CONFIRMATION ITSELF FAILED while reading ${opts.what ?? 'the written state'} ` +
        `— ${first}. That is a statement about this confirmation, not about the write, ` +
        `whose receipt already reported it mined and successful`,
    };
  }
}

/**
 * The sentence a drive should print when a confirmation came back
 * unconfirmed. It says what was not established and — explicitly — that
 * this is not a claim about the chain, because the message this replaces
 * made exactly that claim.
 */
export function unconfirmedWhy({ what, minBlock, behind, lastErr, timeoutMs }) {
  // Both causes are reported when both happened: a run that hit stale
  // nodes AND errors is a different diagnosis from either alone, and
  // collapsing it to one hides half of what the operator needs.
  const causes = [];
  if (behind > 0) {
    causes.push(`${behind} attempt${behind === 1 ? '' : 's'} reached a node still behind that block`);
  }
  if (lastErr) {
    causes.push(`last error: ${String(lastErr?.message ?? lastErr).split('\n')[0].slice(0, 160)}`);
  }
  const cause = causes.length ? causes.join('; ') : 'no node answered';
  // "no node would answer" was the old ending, and it was a claim about
  // the endpoint that this cannot make: a getter that reverted IS an
  // answer, from every node, and four rounds of trying to tell the two
  // apart by error class failed (#2107 round 4). So the sentence reports
  // the cause it actually saw and claims nothing about why — which is
  // what the classifier was really there to protect, and the part of it
  // that survives its deletion.
  return (
    `COULD NOT CONFIRM ${what} at or after block ${minBlock} within ` +
    `${Math.round(timeoutMs / 1000)}s (${cause}) — no attempt produced an ` +
    `answer this could use. That says nothing about whether the write took ` +
    `effect, and the cause above is reported rather than diagnosed: a revert ` +
    `or an undecodable reply points at the contract or the ABI, a timeout or ` +
    `a refused connection at the endpoint, and only reading it tells you which`
  );
}
