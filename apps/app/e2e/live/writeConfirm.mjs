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
 * neither — it is "no node would tell me". Reporting that as "the state
 * is wrong" states a fund-state conclusion the drive did not establish,
 * which is the failure this repo's standing principle names directly.
 * So `confirmWrite` answers in three:
 *
 *   { ok: true }                  read at a block at or after the
 *                                 write, and the value is accepted
 *   { ok: false, observed }       read at a block at or after the
 *                                 write, and the value is WRONG — a
 *                                 real defect, reported immediately
 *   { ok: false, unconfirmed }    never got an answer from a node at
 *                                 or after that block — NOT a claim
 *                                 about the state either way
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
 * @param {(err: unknown) => boolean} [o.retryable]
 *        Whether asking again could give a different answer. A failure
 *        this rejects PROPAGATES instead of being retried to the
 *        deadline — see the note above it. Defaults to retrying
 *        everything; `rpcRetryable.mjs` is the viem-aware classifier the
 *        call sites pass.
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
  accept,
  minBlock,
  getBlockNumber,
  what = 'the written state',
  retryable = () => true,
  timeoutMs = 60_000,
  everyMs = 3_000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const deadline = now() + timeoutMs;
  let behind = 0; // attempts dropped because the node's head was behind
  let lastErr = null;

  for (;;) {
    let got = false;
    let value;
    let at;
    try {
      const head = await getBlockNumber();
      if (head < minBlock) {
        behind += 1;
      } else {
        value = await read(head);
        at = head;
        got = true;
      }
    } catch (e) {
      // A node that lacks the pinned block, a rate limit and a dropped
      // connection are all the same thing from here — an answer not
      // obtained — and none of them is evidence about the chain's
      // state, so all of them retry until the deadline.
      //
      // A failure every node reproduces is not. A getter that reverted
      // or return data that would not decode is a contract or ABI
      // regression, and waiting out the deadline to report "no node
      // would answer" would blame the endpoint for it — the same
      // mislabelling this helper exists to stop. It propagates.
      if (!retryable(e)) throw e;
      lastErr = e;
    }

    // `accept` is evaluated OUTSIDE that catch on purpose. A predicate
    // that throws — a shape it did not expect, a field that moved — is a
    // bug in the drive, and swallowing it here would retry it to the
    // deadline and then report "no node would answer", which blames the
    // endpoint for the caller's mistake. It propagates instead.
    if (got) {
      return accept(value)
        ? { ok: true, value, blockNumber: at }
        : { ok: false, unconfirmed: false, value, blockNumber: at };
    }

    // Checked AFTER an attempt, so a zero budget still asks once.
    if (now() >= deadline) {
      return { ok: false, unconfirmed: true, why: unconfirmedWhy({ what, minBlock, behind, lastErr, timeoutMs }) };
    }
    await sleep(everyMs);
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
  return (
    `COULD NOT CONFIRM ${what} at or after block ${minBlock} within ` +
    `${Math.round(timeoutMs / 1000)}s (${cause}) — this says nothing about ` +
    `whether the write took effect, only that no node would answer for it`
  );
}
