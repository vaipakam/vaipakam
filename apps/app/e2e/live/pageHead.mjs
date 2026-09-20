/**
 * The page-head tracker: which block THE PAGE has been seen to know about,
 * per endpoint, per page — and the probes and predicates the forced-close
 * bracket builds on it.
 *
 * #2120 — lifted out of `live-position-observe.mjs` unchanged in behaviour.
 * The drive runs on import, so while this lived there it could only be
 * asserted against its own SOURCE (`headSampling.test.mjs`); as a factory it
 * runs under a fake page in `pageHead.test.mjs`. Everything the drive used to
 * reach as a module-level constant is injected once through
 * `createPageHeadTracker`, and the drive keeps none of the state.
 *
 * The two notes below are the ones that stood over the state in the drive
 * and are kept whole: they are the argument for why heads are recorded per
 * endpoint and resolved late, and nothing about the move changes it.
 */
/**
 * The highest block THE PAGE has been seen to know about, per page.
 *
 * ROUND 14 P2 — "my client advanced" is not "my client caught up".
 *
 * Round 13 made the absence confirmation wait for a strictly newer head
 * than the snapshot pinned. That proves this observer moved; it proves
 * nothing about the INDEPENDENT provider the deployed bundle reads,
 * which can be two or more blocks ahead. A terminalization at N+2
 * correctly removes the card while this observer, confirming at N+1,
 * re-reads a still-eligible position and emits the same false
 * missing-card FAIL the gate exists to prevent — one block further
 * along, and just as wrong.
 *
 * The page is the only authority on its own head, and it discloses it:
 * its RPC traffic carries `eth_blockNumber` (the steady-state audit
 * counts them). This records the highest result seen, so the gate can
 * require the observer to reach what the page had already seen.
 *
 * OBSERVATIONAL AND FAIL-QUIET. It never blocks a request, never
 * rejects, and a body it cannot parse is skipped: a mis-sniffed
 * response must not turn into a finding about the app. The COST of
 * seeing nothing is handled where it matters — an absence with no
 * observed page head is reported as unconfirmed rather than as a
 * defect, so silence here is conservative rather than permissive.
 */
/**
 * ROUND 18 P2 — HEADS ARE SCOPED TO THE DEPLOYMENT ENDPOINT.
 *
 * The page deliberately talks to more than one network: `wagmi.ts`
 * registers an explicit chain-1 transport so ENS reverse lookups
 * resolve, and the drive already reasons about that where it decides
 * which endpoint serves the deployment. Pooling every observed height
 * into one maximum mixes those chains, and heights are not comparable
 * across them.
 *
 * The failure is not symmetric, which is why neither direction can be
 * waved through:
 *
 *   TOO HIGH (a foreign chain further along) — the observer can never
 *     pass `pageHead`, so every absence downgrades to incomplete and the
 *     assertion this drive advertises can never fire. Silent, and it
 *     looks exactly like a healthy run.
 *   TOO LOW (a Diamond head skipped) — the gate is passed too easily
 *     and a false missing-card FAIL becomes reachable again.
 *
 * So heights are recorded PER ENDPOINT and resolved only against
 * endpoints positively known to carry Diamond calls. Attribution is by
 * positive evidence rather than by excluding known ENS URLs, for the
 * reason the drive already gives about `callsTargetContract`: the ENS
 * endpoint comes from the deployed bundle's own env, the driver cannot
 * enumerate it, and an exclusion list would silently stop matching.
 *
 * Resolution is DEFERRED rather than decided at record time, which is
 * what makes it order-independent: a page can announce a head on an
 * endpoint before it issues its first Diamond call there, and dropping
 * that height would be the too-low failure above.
 */

import {
  believableResult,
  blockNumberFromRpcPair,
  blockNumberFromWsFrame,
  callsTargetContract,
  CHAIN_ID_CONFLICT,
  chainIdFromRpcPair,
  hexQuantity,
  rpcCallsFromBody,
} from './rpc-verdict.mjs';

/**
 * Build one tracker for a run.
 *
 * `chainId` and `diamondAddress` are the deployment under observation — the
 * chain an endpoint must answer `eth_chainId` with to be trusted for heights,
 * and the address whose presence in a request proves an endpoint serves the
 * deployment. `observedPageChain` is the DRIVE'S map of endpoint → chain id
 * that its unknown-chain gate reads; the tracker writes the chain evidence
 * it parses into it, so the two never hold a second notion of what an
 * endpoint is. `fetch` is the uncached fetch the direct probes use and
 * `probeTimeoutMs` bounds each of them. `now` is the ORDERING clock the
 * floor proof is measured on; it has to be the same monotonic clock the
 * drive stamps its ledger with (see `orderingNow` there), which is why it
 * is handed in rather than read here.
 *
 * Every argument is required and checked by name: a tracker built with a
 * missing clock or a wrong-typed address would fail quietly at the first
 * page, as "nothing observed", which is the fail-quiet shape this module's
 * own notes call conservative — and it is, but not for a wiring mistake.
 */
export function createPageHeadTracker({
  chainId,
  diamondAddress,
  observedPageChain,
  fetch,
  probeTimeoutMs,
  now,
}) {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new TypeError(`createPageHeadTracker: chainId must be a positive integer, got ${chainId}`);
  }
  if (typeof diamondAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(diamondAddress)) {
    throw new TypeError('createPageHeadTracker: diamondAddress must be a 0x-prefixed 20-byte hex address');
  }
  if (!(observedPageChain instanceof Map)) {
    throw new TypeError('createPageHeadTracker: observedPageChain must be the drive\'s endpoint → chain Map');
  }
  if (typeof fetch !== 'function') {
    throw new TypeError('createPageHeadTracker: fetch must be a function');
  }
  if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs <= 0) {
    throw new TypeError(`createPageHeadTracker: probeTimeoutMs must be a positive number, got ${probeTimeoutMs}`);
  }
  if (typeof now !== 'function') {
    throw new TypeError('createPageHeadTracker: now must be the ordering clock function');
  }
  const pageRpcHeads = new WeakMap(); // page -> Map<key, bigint>
  // ROUND 84 P2 — the LOWEST head each endpoint announced, beside the
  // highest. See `pageHeadFloorOf`: the bracket needs a block the card's own
  // queries cannot predate, and the maximum is the one thing it certainly
  // can.
  const pageRpcHeadFloors = new WeakMap(); // page -> Map<key, bigint>
  const pageDiamondKeys = new WeakMap(); // page -> Set<key>
  /**
   * Response handlers that have STARTED but not finished parsing.
   *
   * ROUND 48 P2. `page.on('response', …)` takes an async listener and
   * Playwright does not await it, so a `latest`-block reply arriving just
   * before the scrape can still be inside `res.json()` when `pageHeadOf`
   * samples the map. The DOM already reflects block N; the map holds an
   * older height, or none.
   *
   * Both directions are wrong and neither is loud. Zero disables the
   * absence assertion, which reports an INCOMPLETE observation for a
   * reading that was simply taken too early. A stale non-zero bound is
   * worse: the confirming observer can settle below N and report a
   * missing card as a regression — a false FAIL invented out of a race.
   *
   * The fix is to wait for the parses already in flight, which is bounded
   * work: the set only ever holds responses that arrived before the
   * sample. `page -> Set<Promise>`, each entry removing itself on settle.
   */
  const pageHeadPending = new WeakMap(); // page -> Set<Promise<void>>

  /**
   * WHEN each endpoint first announced a head, and when it first served a
   * contract read. `page -> Map<key, epoch ms>`, one map each.
   *
   * ROUND 86 P2 — the evidence that decides whether the bracket's floor
   * bounds anything. See `floorEstablishedFor`.
   */
  const pageFirstHeadAt = new WeakMap(); // page -> Map<key, number>
  const pageFirstReadAt = new WeakMap(); // page -> Map<key, number>

  /**
   * Every endpoint proven to serve the deployment, across ALL pages.
   *
   * ROUND 87 — the per-page `pageDiamondKeys` cannot answer "which endpoint
   * will this NEXT page read from", and that is the question the sound floor
   * needs: an endpoint learned on the list visit is the one the detail
   * visits will use, so its head can be sampled BEFORE the detail page
   * loads. Module-scoped for exactly that reason, and additive — an endpoint
   * proven once stays proven.
   */
  const knownPageRpcEndpoints = new Set();

  /**
   * Endpoints PROVEN to serve another chain, across all pages.
   *
   * ROUND 89 P2 — the per-page `foreign` set cannot keep one out of the
   * module-wide set above, and the set above is what the pre-navigation
   * head probe reads.
   *
   * An endpoint admitted by the raw-address heuristic and later caught
   * answering `eth_chainId` with a different chain was removed from that
   * page's `diamond` set and left in `knownPageRpcEndpoints`. Every later
   * visit then asked it for a head — and if the real provider's probe
   * failed while the foreign one answered, a height from an unrelated chain
   * became the floor a product accusation is measured against. Bounding a
   * claim about this deployment with another chain's block number is the
   * worst shape this floor can take.
   *
   * Permanent and module-wide, matching round 51's rule for the per-page
   * set: an endpoint that has identified itself as another chain is settled
   * for the rest of the run, and a later page's heuristic must not re-admit
   * it.
   */
  const foreignPageRpcEndpoints = new Set();

  /**
   * The head THE PAGE'S OWN PROVIDER is at, asked directly.
   *
   * ROUND 87 — and this is what finally makes the bracket's lower end sound
   * rather than better-estimated.
   *
   * Rounds 84 to 86 tried three ways to bound the block a render came from:
   * the first head the page announced, this drive's own pre-navigation
   * sample, and an ordering test over the two. Round 87 broke the last of
   * them correctly — a JSON-RPC batch holding both an `eth_call` and a head
   * request is a set of independent calls, not a sequence, so the read can
   * be served a block BEFORE the head that appears to precede it. Tightening
   * the ordering test to refuse that turned the live deployment's answer to
   * `spanStable=unknown`, which is honest and also switches three arms off.
   *
   * The sound construction was available all along and needs no ordering at
   * all: ask the PAGE'S provider for its height BEFORE the page loads.
   * Blocks only advance, so any `latest` read that provider serves
   * afterwards is at or above that height — whatever it batches, in whatever
   * order. This drive knows the endpoint because an earlier visit's traffic
   * proved it serves the deployment.
   *
   * The residual is unchanged and is the one already stated: a pool serving
   * one request from a machine that has fallen behind can answer below its
   * own reported height. Nothing observable from outside distinguishes it.
   */
  async function pageProviderHead() {
    let low = 0n;
    // WHICH endpoints this bound, not only the height (round 90). A sample
    // says nothing about an endpoint it did not ask, and the caller has to
    // be able to tell those apart.
    const sampled = new Set();
    for (const url of knownPageRpcEndpoints) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
          // ROUND 88 P2 — BOUNDED, like the chain probe beside it. `fetch`
          // has no default timeout, so an endpoint that accepts the request
          // and never answers hangs this call forever — and it runs BEFORE
          // the navigation, so the whole run stalls rather than falling back
          // to the ordering test the way the comment above promises. The
          // fallback only exists if this can actually fail.
          signal: AbortSignal.timeout(probeTimeoutMs),
        });
        if (!resp.ok) continue;
        const parsed = await resp.json();
        // ROUND 93 P2 — A SUCCESSFUL REPLY, not merely a parseable one.
        //
        // A member carrying BOTH `result` and `error` is malformed, and the
        // page's own client treats the error as authoritative — so reading
        // the result here takes a number the page never acted on and makes
        // it the floor a product accusation is measured against. A bogus
        // high one puts that floor above the block the card rendered.
        //
        // An array is a batch answering a request this never sent, which is
        // the same kind of "not the reply I asked for" and gets the same
        // refusal rather than a best-effort read of its first member.
        if (Array.isArray(parsed)) continue;
        // ROUND 100 P2 — THROUGH THE SHARED PARSER, as the fourth reader of a
        // JSON-RPC `result`. The array guard above is head-specific and stays;
        // the non-null-error rule is not, and `believableResult` exists
        // precisely because each reader keeping its own copy is how rounds 98,
        // 99 and 100 each found one that had been left behind.
        const believed = believableResult(parsed);
        if (believed === undefined) continue;
        // ROUND 88 P2 — A JSON-RPC QUANTITY, not whatever `BigInt` will take.
        //
        // `BigInt` accepts `"101"` and a bare number; an Ethereum height is
        // hex with an `0x` prefix. `hexQuantity` is the rule the page-head
        // parsers have used since round 50 for exactly this reason, and this
        // probe was the fourth reader of the same kind of field written to
        // its own laxer standard — the parallel-site shape again, this time
        // with me adding the new site.
        //
        // It matters here in the direction that accuses: a misread height
        // that comes out too HIGH puts the floor above the block the card
        // rendered, and the interior scan then never looks at the state the
        // lender was actually shown.
        const seen = hexQuantity(believed);
        if (seen === null) continue;
        // The LOWEST across endpoints, for the reason the floor takes the
        // lower of its sources everywhere else: this drive cannot tell which
        // of them will serve the card's query, so the further back one is
        // the only safe answer.
        if (seen > 0n && (low === 0n || seen < low)) low = seen;
        if (seen > 0n) sampled.add(url);
      } catch {
        // An endpoint that will not answer contributes nothing. It is not a
        // failure: the floor simply falls back to its other sources, and the
        // ordering test still decides whether those bound anything.
      }
    }
    return { head: low === 0n ? null : low, sampled };
  }

  /**
   * The HIGHEST head the page's own Diamond-serving endpoints are at, asked
   * directly AFTER the scrape — the bracket's upper end.
   *
   * ROUND 101 P2 — BECAUSE THE RECORDED HEAD IS NOT A CEILING.
   *
   * `pageHead` is the highest head this drive OBSERVED the page announce, and
   * `headSettled` only says the announcements it saw finished parsing. Neither
   * bounds an unpinned `eth_call` the page issues afterwards: the provider can
   * advance between its last head reply and that read, serve it at a higher
   * block, and the card then renders from state the interior scan never
   * reaches while `pinnedBlock >= pageHead` is satisfied. That is the accusing
   * direction — a correct card judged against a range that excludes it.
   *
   * Asking AFTER the scrape is what makes this sound: heads do not go
   * backwards, so a height reported now is at or above anything served during
   * the scrape. The HIGHEST across endpoints, which is the opposite of
   * `pageProviderHead`'s lowest and for the mirrored reason — the floor takes
   * the furthest back because any endpoint might have served the card, and the
   * ceiling takes the furthest forward for exactly the same reason.
   *
   * `sampled` is returned for the same reason it is there: an endpoint that
   * would not answer is not bounded, and a caller that cannot bound every
   * endpoint the page used has no ceiling rather than a slightly worse one.
   *
   * @returns {Promise<{head: bigint, sampled: Set<string>}>}
   */
  async function pageProviderCeiling(page) {
    let high = 0n;
    const sampled = new Set();
    const diamond = pageDiamondKeys.get(page);
    for (const url of diamond ?? []) {
      if (foreignPageRpcEndpoints.has(url)) continue;
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
          signal: AbortSignal.timeout(probeTimeoutMs),
        });
        if (!resp.ok) continue;
        const parsed = await resp.json();
        if (Array.isArray(parsed)) continue;
        const seen = hexQuantity(believableResult(parsed));
        if (seen === null || seen <= 0n) continue;
        if (seen > high) high = seen;
        sampled.add(url);
      } catch {
        // Unanswerable: this endpoint contributes no bound, and the caller
        // refuses the ceiling rather than proceeding with a partial one.
      }
    }
    return { head: high, sampled };
  }

  /**
   * Can the bracket's lower end be trusted to sit at or below the block the
   * card's data came from?
   *
   * ROUND 86 P2, and it is the question rounds 84 and 85 kept answering with
   * a better guess instead of evidence.
   *
   * The floor is built from the page's first head announcement and from this
   * drive's own pre-navigation sample. Neither bounds a read the page's
   * provider served BEFORE it announced anything: a lagging provider can
   * answer a contract read at block M while this observer was already at N,
   * and both floor sources then sit above the state the card actually
   * rendered. Around a grace transition between M and N the interior scan
   * starts at N, finds the answer constant, and a legitimate block-M refusal
   * render is blamed on the product.
   *
   * That ordering is OBSERVABLE, which is what makes this an answer rather
   * than another estimate. Every page RPC goes through this drive's route
   * interception, so it can see whether the endpoint announced a head BEFORE
   * it served its first `eth_call`. If it did, the provider had reached that
   * head before any contract read, and a read at `latest` afterwards cannot
   * have been served from below it. If a read came first, nothing bounds it
   * and the comparison is not established — the drive says so rather than
   * accusing.
   *
   * `eth_call` specifically, not any POST: `eth_chainId` and the head
   * announcements themselves are not state reads, and treating them as such
   * would make this permanently false and silently retire the protocol arms.
   *
   * EVERY Diamond-serving endpoint has to satisfy it, not merely one. A
   * deployment reading through two endpoints, where the second served a
   * contract read without ever announcing a head, answers `false` and the
   * comparison stays incomplete. Deliberately conservative: this drive
   * cannot tell which endpoint served the card's own query, so a single
   * unordered one is enough to make the floor unproven. The cost is
   * `spanStable=unknown` on such a deployment, which the run prints rather than
   * leaving a reader to infer from a clean line.
   *
   * THE RESIDUAL, stated: this assumes an endpoint's head does not go
   * BACKWARDS. A load-balanced pool serving one request from a lagging node
   * can break that, and no amount of observation from outside will show it.
   * It is a much narrower assumption than the one it replaces — the same
   * URL regressing, rather than two independent providers being in step —
   * and it is the same irreducible class as the observer/confirmer race this
   * PR already states as a limit.
   */
  function floorEstablishedFor(page, sampledBeforeNav) {
    const diamond = pageDiamondKeys.get(page);
    const heads = pageFirstHeadAt.get(page);
    const reads = pageFirstReadAt.get(page);
    if (!diamond || !heads || !reads) return false;
    let sawHead = false;
    for (const key of diamond) {
      // ROUND 90 P2 — EVERY endpoint this page used has to be bounded, and
      // there are two ways to bound one.
      //
      // The direct sample is taken before the navigation from the endpoints
      // EARLIER visits proved, so it says nothing about an endpoint this
      // page reached for the first time — a fallback transport, a second
      // provider in the deployed config. Treating one sampled endpoint as
      // sufficient let a NEW endpoint's reads go unbounded while the bracket
      // started from the old one's height: a card truthfully rendered from
      // the new endpoint's block could then be reported as disagreeing with
      // the protocol.
      //
      // So a key counts as bounded when it was sampled before navigation OR
      // when its own announcement ordering holds. One predicate, applied per
      // endpoint, instead of a global shortcut standing in for all of them.
      if (sampledBeforeNav?.has(key)) {
        sawHead = true;
        continue;
      }
      const head = heads.get(key);
      const read = reads.get(key);
      if (head !== undefined) sawHead = true;
      // A read issued before this endpoint announced anything, or before it
      // announced its first head: nothing this drive saw bounds that read.
      //
      // ROUND 101 P2 — AND THE TWO TIMES ARE NO LONGER BOTH ARRIVALS.
      //
      // `head` is when a head ANSWER was parsed; `read` is when an `eth_call`
      // was SENT. So the test asks the sound question: had this endpoint
      // already told us where it was, before we asked it to read? If so the
      // read cannot have been served below that height, because heads do not
      // go backwards, and no assumption about response ordering is involved.
      //
      // Round 87 established that a BATCH cannot be read as a sequence — its
      // members are independent calls, so a block landing between two of them
      // serves the `eth_call` at M and answers `eth_blockNumber` with M+1.
      // That argument was applied to one response and not to two, and it is
      // the same argument: two concurrent requests can be served at M and M+1
      // and arrive in either order. Comparing two arrival times established
      // nothing, and set the floor at M+1 for a card rendered from M.
      //
      // STILL STRICTLY earlier. Equal timestamps carry no order, and the
      // request-time stamp can only be earlier than the old arrival-time one,
      // so this test is harder to satisfy than before — the safe direction.
      if (read !== undefined && (head === undefined || head >= read)) return false;
    }
    return sawHead;
  }

  function watchPageHead(page) {
    const heads = new Map();
    const diamond = new Set();
    // ROUND 19 P2 — AN EXCLUSION HAS TO OUTLIVE THE RESPONSE THAT PROVED
    // IT. Round 18's version returned early on a foreign chain id, which
    // skipped only THAT response: a later body from the same endpoint
    // carrying the Diamond address — an ENS reverse lookup does exactly
    // that — re-admitted it through the substring heuristic, and if the
    // ordering ran the other way the existing entry was never removed at
    // all. Once an endpoint has identified itself as a different chain,
    // that is settled for the rest of the run.
    const foreign = new Set();
    const pending = new Set();
    const floors = new Map();
    const firstHeadAt = new Map();
    const firstReadAt = new Map();
    pageFirstHeadAt.set(page, firstHeadAt);
    pageFirstReadAt.set(page, firstReadAt);
    pageRpcHeads.set(page, heads);
    pageRpcHeadFloors.set(page, floors);
    pageDiamondKeys.set(page, diamond);
    pageHeadPending.set(page, pending);

    const recordHead = (key, seen) => {
      if (seen === null || seen === undefined) return;
      if (seen > (heads.get(key) ?? 0n)) heads.set(key, seen);
      // The floor is recorded in the same call as the ceiling, deliberately:
      // two passes over the same events is how one of them ends up missing
      // the WebSocket path, which is a live source of head announcements and
      // easy to forget because the HTTP one is what a reader looks at.
      const low = floors.get(key);
      if (low === undefined || seen < low) floors.set(key, seen);
    };
    // An endpoint counts as serving the deployment when the page ASKS IT
    // ABOUT THE diamondAddress. Two tests, because one is not enough:
    //
    //   - `callsTargetContract` reads the `to` of the shapes it knows.
    //   - the raw body carrying the Diamond address catches the case that
    //     one misses, and it is the COMMON one: viem batches contract
    //     reads through multicall3, so the `to` is the aggregator and the
    //     Diamond appears only inside the encoded calldata. Attribution by
    //     `to` alone marked nothing, which showed up immediately as
    //     `pageHead=unobserved` on the live run — the print earning its
    //     place on the first run after it was added.
    //
    // Still positive evidence rather than an exclusion list, for the
    // reason the drive already gives: the ENS endpoint comes from the
    // deployed bundle's own env and cannot be enumerated here.
    const DIAMOND_HEX = String(diamondAddress).replace(/^0x/, '').toLowerCase();
    const markDiamond = (key, body, responseBody) => {
      // ROUND 109 P2 — ONE admission test for BOTH arms.
      //
      // An endpoint enters `diamond` two ways: on an expected-chain reply, and
      // on the raw-address heuristic further down. Round 108 guarded the second
      // and left the first — this change's own parallel-site defect, inside the
      // fix FOR a parallel-site defect. Naming the test once is the only
      // version of this that stays fixed.
      //
      // `foreign` is per-page; `foreignPageRpcEndpoints` is module-wide and
      // permanent (round 89), and the per-page set is empty on a later visit,
      // which is the whole reason the module-wide one exists.
      const admitIfNotForeign = () => {
        if (foreign.has(key) || foreignPageRpcEndpoints.has(key)) return;
        diamond.add(key);
        knownPageRpcEndpoints.add(key);
      };
      try {
        // WHEN THE ENDPOINT SAYS WHICH CHAIN IT SPEAKS FOR, that settles
        // it in both directions — heights are chain-scoped, so this is the
        // fact actually needed rather than a proxy for it.
        //
        // MEASURED, not assumed: with the address evidence below switched
        // off, a live run reports `pageHead=unobserved`, so the deployed
        // page does not disclose `eth_chainId` on its deployment endpoint
        // within the observed window. Chain id therefore cannot be the
        // sole test, and the address evidence below is load-bearing rather
        // than a belt-and-braces extra.
        //
        // Its value is as the NEGATIVE discriminator, which is what the
        // address heuristic cannot do for itself: the app resolves ENS
        // names on a mainnet endpoint, and a reverse lookup carries an
        // address in its calldata exactly the way a batched Diamond read
        // does — so an endpoint that has identified itself as a different
        // chain is excluded before the heuristic can mistake it.
        if (responseBody !== undefined) {
          const id = chainIdFromRpcPair(body, responseBody);
          // ROUND 52 P2 — A CONTRADICTION IS EVIDENCE, and it excludes.
          //
          // One batch answering `eth_chainId` twice with different chains
          // used to be resolved by whichever reply came first, so the
          // endpoint could be admitted as deployment-serving on half of
          // its own answer and have its later heights trusted. An endpoint
          // that gives two answers has told us it can be relied on for
          // neither — which is precisely what round 51's permanent
          // exclusion is for, arriving by an earlier door.
          if (id === CHAIN_ID_CONFLICT) {
            foreign.add(key);
            diamond.delete(key);
            // ROUND 89 P2 — and out of the module-wide set the pre-navigation
            // head probe reads, or a later visit asks a self-contradicting
            // endpoint for the floor a product accusation rests on.
            foreignPageRpcEndpoints.add(key);
            knownPageRpcEndpoints.delete(key);
            // ROUND 80 P2 — AND THE EXIT GATE HAS TO HEAR ABOUT IT.
            //
            // There are TWO ways this endpoint can contradict itself: one
            // batch answering `eth_chainId` twice with different chains,
            // which lands here, and two separate responses disagreeing,
            // which lands below. Round 79 recorded only the second, so a
            // same-response conflict marked the endpoint foreign in this
            // page-local set and told the shared map nothing — and if the
            // synthetic probe then answered the expected chain, the
            // reconciliation trusted it and an inferred missing surface
            // could be reported as a product regression on a provider that
            // had contradicted itself in a single reply.
            //
            // The parallel-site shape once more, and inside the fix for the
            // very question it belongs to: I split the conflict into two
            // paths and handled one.
            observedPageChain.set(key, CHAIN_ID_CONFLICT);
            return;
          }
          if (id !== null) {
            // Recorded for the unknown-chain gate, whichever chain it is.
            //
            // ROUND 79 P2 — AND A SECOND, DIFFERENT ANSWER IS A CONTRADICTION.
            //
            // `set` let a later reply overwrite an earlier one, so an
            // endpoint that answered two different chains across two
            // responses looked consistent to the gate — the same laundering
            // round 52 closed for a single batch, arriving by a slower
            // door. `CHAIN_ID_CONFLICT` is the value the gate already reads
            // as "this endpoint cannot say", so recording it here needs no
            // new vocabulary.
            const prior = observedPageChain.get(key);
            observedPageChain.set(
              key,
              prior !== undefined && prior !== id ? CHAIN_ID_CONFLICT : id,
            );
            if (id === chainId) {
              // ROUND 51 P2 — AND THE EXCLUSION IS PERMANENT, so this
              // cannot re-admit.
              //
              // The `foreign.has(key)` return sits BELOW this line, so an
              // endpoint that had already identified itself as another
              // chain and then answered with the expected id was added
              // back to `diamond` on the way past. Round 19 wrote "once an
              // endpoint has identified itself as a different chain, that
              // is settled for the rest of the run" and then left one door
              // open — the door where the endpoint is inconsistent, which
              // is precisely the endpoint the rule exists for.
              //
              // An endpoint reporting two different chain ids has told us
              // it cannot be trusted to say which chain a height belongs
              // to. Trusting its heights again lets a wrong-chain bound
              // reach the absence gate, where a degraded page can be
              // blamed for omitting a card it was right to omit.
              // ROUND 109 P2 — THE MODULE-WIDE EXCLUSION APPLIES HERE TOO.
              //
              // Round 108 guarded the `admit` closure and left this arm, which
              // admits on an EXPECTED-chain reply and is the second of the two
              // ways an endpoint enters `diamond`. The per-page `foreign` set
              // is empty on a later visit, so an endpoint already proven
              // foreign — one that answered for another chain earlier and is
              // now answering with the expected id, which is exactly the
              // inconsistent endpoint this rule exists for — walked straight
              // back in. `admitIfNotForeign` is the single test both arms use
              // now, so there is no second place to remember.
              admitIfNotForeign();
            } else {
              // A DIFFERENT chain is positive evidence the other way, and
              // it outranks the address heuristics below — an ENS endpoint
              // asked to reverse-resolve an address carries that address
              // in its calldata exactly as a batched Diamond read does.
              // Recorded permanently, and it also REVOKES any earlier
              // admission, since the heuristic may have run first.
              foreign.add(key);
              diamond.delete(key);
              // ROUND 89 P2 — the same revocation, module-wide. This is the
              // path the finding named: admitted by the address heuristic,
              // then caught answering for another chain.
              foreignPageRpcEndpoints.add(key);
              knownPageRpcEndpoints.delete(key);
              return;
            }
          }
        }
        if (foreign.has(key)) return;
        // A key proven foreign on ANY page stays out, whichever page is
        // asking (round 89). `foreign` is per-page and cannot answer this.
        //
        // ROUND 108 P2 — AND THAT NOW GUARDS BOTH SETS, which is what this
        // note already claimed. The module-wide check sat on
        // `knownPageRpcEndpoints` alone, so on a LATER page — where `foreign`
        // starts empty again — the raw-address heuristic re-admitted a proven
        // foreign endpoint to `diamond`. Everything downstream reads that set:
        // `pageHeadOf`, `pageHeadFloorOf` and `floorEstablishedFor` would then
        // take heights from an unrelated chain, and bounding a claim about
        // this deployment with another chain's block number is the worst shape
        // the floor can take — round 89's own words, applied to one of the two
        // sets it was written for.
        const admit = admitIfNotForeign;
        if (typeof body === 'string' && body.toLowerCase().includes(DIAMOND_HEX)) {
          admit();
          return;
        }
        if (callsTargetContract(rpcCallsFromBody(body), diamondAddress)) admit();
      } catch {
        // Observational only.
      }
    };

    // ROUND 16 P2 — SOCKETS TOO, not only HTTP. `wagmi.ts` wraps the chain
    // reads in `fallback([webSocket, http])`, so on a healthy network the
    // page can learn a new block over a socket and never issue the
    // `eth_blockNumber` an HTTP-only listener depends on — its announced
    // head then lags its real one, and the gate compares against a bound
    // that stopped moving.
    //
    // A socket is its own endpoint: keyed by the socket object, and marked
    // as deployment-serving by what the PAGE sends over it.
    //
    // ⚠ INERT TODAY, AND THE COMMENT SAYING OTHERWISE WAS WRONG (round 19
    // P2). If the page makes ANY JSON-RPC call over a socket, this drive
    // exits 2 near the end — a blanket refusal to vouch for reads that
    // bypassed the allowlist, the response ledger and the chain probe,
    // all of which ride on an HTTP-only route. That exit happens BEFORE
    // any verdict or coverage is computed, so on precisely the runs where
    // socket heads would matter, nothing downstream ever reads them.
    //
    // The capture is kept rather than deleted because it is correct and
    // tested, and because the blocker is the thing expected to move: when
    // socket frames are classified well enough to lift it, this needs no
    // change. But it must not be described as shrinking the head race
    // today, which is what the previous comment and the coverage row both
    // claimed. Extending socket classification is out of scope here.
    //
    // The related worry — a socket carrying ONLY subscriptions would never
    // be marked — was checked rather than assumed: `wagmi.ts` builds
    // `fallback([webSocket(...), http(...)])`, and viem's fallback sends
    // EVERY request to the first working transport, so while the socket is
    // healthy the Diamond reads travel over it and it marks itself.
    //
    // Linking a socket to an HTTP endpoint by HOST was considered and
    // rejected: providers routinely serve several chains from one host on
    // different paths or keys, so host-matching would re-introduce exactly
    // the cross-chain pooling this scoping exists to remove.
    page.on('websocket', (ws) => {
      const key = ws;
      ws.on('framesent', ({ payload }) => markDiamond(key, payload));
      ws.on('framereceived', ({ payload }) => {
        try {
          recordHead(key, blockNumberFromWsFrame(payload));
        } catch {
          // Observational only, exactly as below.
        }
      });
    });
    // ROUND 48 P2 — REGISTERED BEFORE IT AWAITS ANYTHING.
    //
    // The listener is wrapped rather than having the tracking added inside
    // it, because the registration has to happen SYNCHRONOUSLY with the
    // event: anything after the first `await` is already too late to be
    // seen by a sample taken in between, which is the race itself.
    page.on('response', (res) => {
      const done = handleResponse(res).catch(() => {});
      pending.add(done);
      done.finally(() => pending.delete(done));
    });
    // ROUND 101 P2 — THE READ IS STAMPED WHEN IT IS ASKED, NOT WHEN IT LANDS.
    //
    // Round 87 established that a BATCH cannot be read as a sequence: its
    // members are independent calls, so a block landing between two of them
    // serves the `eth_call` at M and answers `eth_blockNumber` with M+1, and
    // the read is older than the announcement that appears to precede it.
    // That argument was applied to one response and not to two — and it is the
    // same argument. Two CONCURRENT requests can be executed at M and M+1 and
    // have their responses arrive in the opposite order, so comparing two
    // ARRIVAL times establishes nothing about the order the server served
    // them in. The floor could then be set at M+1 for a card rendered from M,
    // which is the accusing direction.
    //
    // Stamping the read at REQUEST time makes the comparison sound rather than
    // deleting the evidence: if this endpoint's head response was parsed
    // before the read was even SENT, then the endpoint had already reached
    // that height when it was asked, and heads do not go backwards. Nothing
    // about arrival order is needed.
    //
    // The asymmetry with `firstHeadAt` is deliberate and is round 92's rule
    // intact: a head must be stamped on the ANSWER, because an unanswered ask
    // proves nothing about where the endpoint is. A read stamped on the ask is
    // the conservative end of its own uncertainty — the earliest moment it
    // could have been served — and moving it earlier can only make this test
    // harder to satisfy.
    page.on('request', (req) => {
      try {
        if (req.method() !== 'POST') return;
        const body = req.postData();
        if (!body || !body.includes('eth_call')) return;
        const key = req.url();
        if (!firstReadAt.has(key)) firstReadAt.set(key, now());
      } catch {
        // Observational only: a request whose body cannot be read simply
        // leaves this endpoint unstamped, which the predicate treats as
        // unbounded rather than as evidence.
      }
    });

    async function handleResponse(res) {
      try {
        const req = res.request();
        if (req.method().toUpperCase() !== 'POST') return;
        const body = req.postData();
        if (!body) return;
        const key = res.url();

        // One `res.json()` for both questions: a response body can only be
        // consumed once cheaply, and the chain-id evidence needs it.
        // ROUND 33 P2 — `eth_getBlockByNumber` IS A HEAD ANNOUNCEMENT too,
        // so both gates below have to admit it or the parser never sees the
        // body it was just taught to read. The cheap string test stays a
        // string test: `blockNumberFromRpcPair` is the one that decides
        // whether the block tag was actually `'latest'`, and duplicating
        // that judgement here would be a second rule to drift.
        const announcesHead =
          body.includes('eth_blockNumber') || body.includes('eth_getBlockByNumber');
        const parsed = body.includes('eth_chainId') || announcesHead
          ? await res.json().catch(() => undefined)
          : undefined;
        markDiamond(key, body, parsed);
        // ROUND 86 P2 — WHEN, not only what. `floorEstablishedFor` needs the
        // ORDER of this endpoint's first head announcement and its first
        // contract read; without it the bracket's floor bounds nothing on a
        // lagging provider. Stamped on the RESPONSE, which is the moment the
        // page actually held the answer.
        //
        // `eth_call` only for the read side: `eth_chainId` and the head
        // announcements are not state reads, and counting them would make
        // the test permanently false and quietly retire three arms.
        //
        // A BATCH CARRYING BOTH IS UNORDERED, and my own self-review note
        // here said the opposite — that the head "was known no later than
        // the read was served" — which round 87 refuted correctly.
        //
        // A JSON-RPC batch is one HTTP request holding independent calls.
        // Nothing requires a server to serve them from one block, and
        // ordinary implementations handle members in sequence: a block
        // landing between two of them serves the `eth_call` at M and answers
        // `eth_blockNumber` with N = M+1. The read is then OLDER than the
        // announcement it supposedly followed, which is exactly the case
        // this ordering test exists to exclude.
        //
        // So both are stamped, and the comparison below requires the head to
        // be STRICTLY earlier. A mixed batch lands both at one timestamp and
        // fails that, which is the honest answer: the batch says the two
        // happened together, not in an order.
        const stamp = (map) => {
          if (!map.has(key)) map.set(key, now());
        };
        // The read stamp moved to the REQUEST listener above (round 101). It
        // is deliberately not re-stamped here: `stamp` keeps the first value,
        // so a response landing for an endpoint already stamped would be a
        // no-op, but an endpoint whose request listener missed the body would
        // otherwise pick up an ARRIVAL time and re-introduce exactly the
        // unsound comparison this moved away from.
        // Cheap reject before parsing — most POSTs are not this.
        if (!announcesHead) return;
        // The PARSE is a pure function in `rpc-verdict.mjs`, tested
        // there. Batches answered out of order, batches mixing methods
        // and error members where a result was expected are the cases
        // that matter, and a live chain will not reliably produce any of
        // them — inline here, none of them could be exercised.
        // ROUND 92 P2 — THE ORDERING EVIDENCE IS STAMPED ON AN ANSWER, not
        // on a question.
        //
        // `announcesHead` is a string test over the REQUEST body, so it was
        // stamping `firstHeadAt` for an endpoint that was merely ASKED for a
        // head — including one that answered HTTP 200 with a malformed
        // result, where `recordHead` records nothing at all. The ordering
        // test then read a real announcement where there had been none, and
        // the floor could be declared sound on an endpoint that never told
        // this drive where it was.
        //
        // Stamped from the PARSED height instead, beside the recording it
        // belongs with, so the two cannot disagree about whether a head
        // arrived.
        const announced = blockNumberFromRpcPair(body, parsed);
        if (announced !== null && announced !== undefined) stamp(firstHeadAt);
        recordHead(key, announced);
      } catch {
        // Observational only. See the note above.
      }
    }
  }

  /**
   * Let the head readings already in flight finish before they are read, and
   * say whether they all did.
   *
   * ROUND 48 P2, and see `pageHeadPending`: iterating the live set would be
   * unbounded on a page that polls, so each pass awaits a SNAPSHOT of it.
   *
   * ROUND 100 P2 — THIS SUMMARY IS NOW THE THIRD CONTRACT ON THIS FUNCTION TO
   * BE CORRECTED, and it was left saying two things that have both been
   * overturned inside it.
   *
   * "A single snapshot": round 92 made it drain repeatedly, up to a bounded
   * budget, because a reply landing while the first await settles is one the
   * page HAS consumed. "Anything arriving after it is, by definition, not part
   * of what the DOM was showing": true of the FLOOR, which is what round 48
   * was about, and false of the CEILING this same call now also feeds — round
   * 97 established that both callers must withhold when the drain runs out of
   * passes.
   *
   * So: a BOUNDED drain to quiescence, returning `true` only when the pending
   * set actually emptied. Neither end of the bracket is established on `false`.
   * See the notes inside for the full history; the point of repeating it here
   * is that a reader who stops at the summary should not be told the opposite.
   */
  async function settleHeadReads(page) {
    const pending = pageHeadPending.get(page);
    if (!pending || pending.size === 0) return true;
    // ROUND 92 P2 — DRAINED TO A BOUNDED QUIET POINT, not one snapshot.
    //
    // Round 48 awaited a single snapshot of the set and argued that anything
    // arriving afterwards is "by definition not part of what the DOM was
    // showing". That is true of the FLOOR and false of the CEILING, which is
    // the use this same call now has: a response landing while the await
    // settles is one the page has consumed, so the head it carries belongs
    // to what the page was showing — and leaving it unrecorded makes the
    // ceiling too LOW, which is exactly what lets the catch-up test declare
    // itself satisfied against a state the page had already moved past.
    //
    // Round 48's reason for not looping remains sound and is why this is
    // BOUNDED rather than "until empty": a page that polls would never
    // reach empty, and an unbounded drain would hang the run. Six passes is
    // an operational budget, stated as one — on a page whose reads settle it
    // ends after two, and on one that never stops it ends anyway.
    //
    // ROUND 96 P2 — AND IT SAYS WHICH OF THOSE TWO HAPPENED.
    //
    // Round 92 wrote "the sample is simply the best available" and called the
    // residual unchanged from round 48. It was not unchanged: round 48's
    // sample was a FLOOR, where a response arriving late is genuinely not part
    // of what the DOM was showing, and this same call now also produces a
    // CEILING, where it is. Returning quietly after six busy passes hands the
    // caller a ceiling that is too low while looking exactly like a drained
    // one — and the catch-up test then reads as satisfied against a state the
    // page had already moved past, which is how an older protocol range comes
    // to substantiate a product failure.
    //
    // `false` means the budget expired with work still in flight: not a
    // ceiling, not a lower ceiling, simply not established.
    //
    // ROUND 98 P2 — AND BOTH CALLERS WITHHOLD ON IT. The sentence that used to
    // end this paragraph said the floor caller ignores `false`, on round 48's
    // argument. Round 97 overturned that — round 48 is about a reply that
    // ARRIVES after the sample, while the budget expiring is a reply that
    // arrived BEFORE it and had not finished parsing, which is already the
    // page's, and dropping it makes the floor too HIGH. The code was fixed and
    // this contract was not, which left the overturned behaviour documented as
    // the current one, three lines above the loop, for a future refactor to
    // restore. Neither end of the bracket is established while this returns
    // `false`.
    for (let pass = 0; pass < 6; pass += 1) {
      const inFlight = [...pending];
      if (inFlight.length === 0) return true;
      await Promise.allSettled(inFlight);
    }
    return pending.size === 0;
  }

  /**
   * The highest head the page announced ON AN ENDPOINT SERVING THE
   * diamondAddress, or 0n if none was observed.
   *
   * 0n also covers "heights were seen, but only on endpoints never proven
   * to serve the deployment" — which is the honest answer rather than a
   * conservative guess, and the gate treats it as not-ready.
   */
  function pageHeadOf(page) {
    const heads = pageRpcHeads.get(page);
    const diamond = pageDiamondKeys.get(page);
    if (!heads || !diamond) return 0n;
    let best = 0n;
    for (const [key, seen] of heads) {
      if (!diamond.has(key)) continue;
      if (seen > best) best = seen;
    }
    return best;
  }

  /**
   * The LOWEST head an endpoint serving the Diamond announced on this page,
   * or 0n if none was observed.
   *
   * ROUND 84 P2 — because "the page reached block N" is not "the card read
   * block N", and the bracket was treating it as though it were.
   *
   * `pageHeadOf` returns the highest head seen ANYWHERE on the page, and the
   * app announces heads far more often than the card refetches: a block
   * watcher ticks every few seconds while the card's own queries poll on a
   * much slower cadence. So the pre-render end of the bracket was routinely
   * pinned to a block NEWER than the data the card was rendering. Around a
   * grace transition that is exactly wrong — the card can legitimately still
   * be showing the block-N `not yet` state while both simulations at N+1
   * answer `true`, and the verdict then reports the product for withholding
   * a close-out the protocol had only just started accepting. A false FAIL
   * on the one card this drive exists to judge, manufactured out of the
   * page's own polling cadence.
   *
   * This drive cannot tie a render to a block — nothing in the DOM says
   * which one a query consumed, and re-deriving the app's refetch interval
   * would be exactly the second copy of app config the drive refuses to keep
   * elsewhere. What it CAN establish is a block the card's data cannot
   * predate: the first head the page was seen to reach. Bracketing from
   * there to the post-scrape head spans every block the card could possibly
   * have read, so when both ends agree the answer did not change anywhere in
   * that span and the disagreement with the card is real whichever block it
   * used. When they differ the observation is INCOMPLETE — which is the
   * outcome Codex asked for, reached by widening the window rather than by
   * abandoning the check.
   *
   * The cost is stated: a grace crossing inside the page's lifetime now
   * yields `incomplete` where the old bracket would have accused. That is
   * the honest answer, since in that window this drive genuinely cannot tell
   * a stale render from a wrong one.
   *
   * TWO BOUNDS WORTH KNOWING, found by reviewing this rather than by
   * running it:
   *
   *   - HOW FAR BACK THIS PINS is the page's own lifetime before the card is
   *     read — a navigation, a settle and at most the chooser wait, so tens
   *     of seconds and a few tens of blocks. That matters because a pin
   *     outside a node's state window answers with a `-32000` this drive
   *     rethrows, and the whole run would abort. Well inside any node's
   *     window at this depth; recorded because the depth is what makes it
   *     safe, and a future change that widened the floor further would not
   *     obviously be changing that.
   *   - THE FLOOR IS A LOWER BOUND ON WHAT THE PAGE ANNOUNCED, not on what
   *     it read. A contract read that resolved before the first head
   *     announcement could have used an earlier block, so the bracket can
   *     miss by the blocks between page load and that first announcement —
   *     normally none, since the app's block watcher mounts with everything
   *     else. The alternative is subtracting a safety margin, which would be
   *     a magic number standing in for a fact, and this file does not keep
   *     those.
   */
  function pageHeadFloorOf(page) {
    const floors = pageRpcHeadFloors.get(page);
    const diamond = pageDiamondKeys.get(page);
    if (!floors || !diamond) return 0n;
    let low = 0n;
    for (const [key, seen] of floors) {
      if (!diamond.has(key)) continue;
      if (low === 0n || seen < low) low = seen;
    }
    return low;
  }

  /**
   * The endpoints THIS page proved to serve the deployment, as a copy: the
   * ceiling gate iterates it and no caller may edit the tracker's own set.
   */
  function diamondKeysOf(page) {
    return new Set(pageDiamondKeys.get(page) ?? []);
  }

  /** Proven to serve another chain on any page of the run — permanent. */
  function isForeign(key) {
    return foreignPageRpcEndpoints.has(key);
  }

  /** Proven to serve the deployment on any page of the run — additive. */
  function isKnown(key) {
    return knownPageRpcEndpoints.has(key);
  }

  return {
    watchPageHead,
    settleHeadReads,
    pageHeadOf,
    pageHeadFloorOf,
    floorEstablishedFor,
    pageProviderHead,
    pageProviderCeiling,
    diamondKeysOf,
    isForeign,
    isKnown,
  };
}
