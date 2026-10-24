/**
 * IS THE ROUTED SURFACE READY TO BE JUDGED? (#2180 Root A, #2111)
 *
 * A live drive judges what a route RENDERED. Several drives waited a fixed
 * time and then judged whatever was on screen, and a fixed wait cannot tell
 * "rendered nothing" from "had not rendered yet". On a quiet run the
 * difference never shows. Under a loaded batch it does: five checks that
 * pass standalone failed in the 2026-09-10 batch because they sampled the
 * route's own loading placeholder ("Loading…", 8 characters) and judged it
 * as the page (#2111). Each of those FAILs was true about the page at that
 * instant, and none of them was about the product.
 *
 * This module is the one rule for that question, so a drive asks it rather
 * than guessing with a sleep:
 *
 * What is measured is the ROUTED REGION — the element the app shell marks
 * `data-route-outlet` (`AppShell.tsx`) — not the whole `#main-content`
 * landmark. The landmark also holds the shell's own banners (the network
 * banner, and the sanctions banner for a connected wallet), and their text
 * is not the route's: counted, it made a route still showing its loading
 * placeholder read as rendered (#2709 r1).
 *
 *   - `unmounted` — the shell's `#main-content` landmark is not in the
 *     document yet.
 *   - `no-outlet` — the shell rendered but carries no routed-region marker:
 *     a build from before the marker. Nothing here can say what the route
 *     rendered, so it is never treated as ready; the reason says to review a
 *     current build.
 *   - `empty`     — the region exists and holds no text.
 *   - `loading`   — every piece of text in the region belongs to a loading
 *     placeholder: an `.empty-state` carrying the spinner. That is the
 *     route-level Suspense fallback and any page whose whole content is
 *     still its own loading state.
 *   - `rendered`  — anything else: the route has put real content up.
 *   - `unreadable` — the snapshot could not be taken, or did not come back
 *     before the deadline (a wedged renderer), or the page closed. Not
 *     ready, and the cause is kept.
 *
 * WHAT `rendered` DOES NOT CLAIM. A rendered route can still have a card
 * further down waiting on a chain read; that is the scenario's own business
 * (`live-role-journeys.mjs`'s `waitSettled` is the precedent). Treating any
 * spinner anywhere as "not ready" would turn a page with one slow card into
 * an unjudged page, which is weaker evidence than judging it. So only a
 * landmark that holds NOTHING BUT placeholders reads as loading.
 *
 * WHAT A DRIVE DOES WITH `ready: false`. The surface was never observed, so
 * the honest verdict is "not checked", never a product FAIL — and never a
 * PASS either: the run stays red as BLOCKED, the existing verdict for "this
 * drive did not complete, so its surfaces are not fully reviewed"
 * (`verdictContract.mjs`). A drive that has positive evidence of a defect
 * from elsewhere (a bundle missing a key, a write the page attempted) still
 * reports that evidence; readiness only removes the judgements that were
 * about timing.
 *
 * Why no separate verdict for this (#2180 asked whether one was needed). In
 * this harness BLOCKED already means "did not complete, so not fully
 * reviewed", not only "a precondition failed" — `live-role-journeys.mjs`
 * reports an unverifiable scenario as BLOCKED for exactly this reason. A
 * fifth word for the same meaning would be one more thing to keep apart.
 * What was missing was never the word; it was a drive being able to tell
 * that it had not looked.
 *
 * The classification is pure (`surfaceStateOf`) so every case is pinned by
 * `readiness.test.mjs`; only `readSurface` touches the page.
 */

/** How long a drive waits for a route to render before calling it unobserved.
 *  The 2026-09-10 batch saw a route take 50 s and still render (#2111), so
 *  this is sized for a loaded run rather than a quiet one. */
export const ROUTE_READY_TIMEOUT_MS = 60_000;

const POLL_MS = 250;

/** The least time one snapshot is given, however little of the readiness
 *  deadline is left, so a final (or single, `timeoutMs: 0`) read can still
 *  come back. A wedged renderer is therefore abandoned at most this long
 *  after the deadline. */
const SNAPSHOT_FLOOR_MS = 5_000;

/**
 * Classify one snapshot of the routed landmark.
 *
 * @param {null | { error: string }
 *   | { hasMain: false }
 *   | { hasMain: true, hasOutlet: false }
 *   | { hasMain: true, hasOutlet: true, textLength: number, placeholderCount: number, otherTextLength: number }} snap
 * @returns {'unreadable' | 'unmounted' | 'no-outlet' | 'empty' | 'loading' | 'rendered'}
 */
export function surfaceStateOf(snap) {
  if (!snap || typeof snap !== 'object' || 'error' in snap) return 'unreadable';
  if (!snap.hasMain) return 'unmounted';
  if (!snap.hasOutlet) return 'no-outlet';
  if (!(snap.textLength > 0)) return 'empty';
  if (snap.placeholderCount > 0 && !(snap.otherTextLength > 0)) return 'loading';
  return 'rendered';
}

/**
 * Take one snapshot of the routed region in a single evaluation, so the
 * counts all describe the same instant.
 *
 * BOUNDED BY `timeoutMs` (#2709 r1). `page.evaluate` has no deadline of its
 * own, so a renderer whose main thread is wedged would never answer, and the
 * batch runner — which has no outer timeout — would hang on it. The race
 * ends the wait; the evaluation itself is abandoned.
 *
 * The catch here is deliberately total, and it is safe for a reason worth
 * stating (#2135's question: can it tell the endpoint from this drive being
 * wrong?). Whatever fails, the result is `unreadable`, which is NOT READY —
 * the direction that reports "not observed", never one that lets a judgement
 * through. The cause is carried, so a defect in this snapshot shows up in the
 * report as an unreadable surface with its cause, not as silence.
 */
export async function readSurface(page, { timeoutMs = ROUTE_READY_TIMEOUT_MS } = {}) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ error: `the page did not answer a snapshot within ${Math.round(timeoutMs / 1000)}s` }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([snapshot(page), expired]);
  } catch (err) {
    return { error: String(err?.message ?? err).split('\n')[0].slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

function snapshot(page) {
  return page.evaluate(() => {
    const main = document.querySelector('#main-content');
    if (!main) return { hasMain: false };
    const region = main.querySelector('[data-route-outlet]');
    if (!region) return { hasMain: true, hasOutlet: false };
    const text = (region.innerText || '').trim();
    const placeholders = [...region.querySelectorAll('.empty-state')].filter(
      (el) => el.querySelector('.spin') !== null,
    );
    let rest = text;
    for (const p of placeholders) {
      const own = (p.innerText || '').trim();
      if (own) rest = rest.replace(own, '');
    }
    return {
      hasMain: true,
      hasOutlet: true,
      textLength: text.length,
      placeholderCount: placeholders.length,
      otherTextLength: rest.trim().length,
    };
  });
}

/** A delay that does not depend on the page: a page that closes mid-wait
 *  must end the wait as unreadable, not reject it (#2709 r1). */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the routed surface has rendered, or the deadline passes. Never
 * rejects: every way of not seeing the surface is a not-ready result.
 *
 * @param {import('playwright').Page} page
 * @param {{ timeoutMs?: number, pollMs?: number }} [opts]
 * @returns {Promise<{ ready: boolean, state: string, waitedMs: number, error?: string }>}
 */
export async function awaitSurface(page, { timeoutMs = ROUTE_READY_TIMEOUT_MS, pollMs = POLL_MS } = {}) {
  const started = Date.now();
  for (;;) {
    const remaining = Math.max(timeoutMs - (Date.now() - started), SNAPSHOT_FLOOR_MS);
    const snap = await readSurface(page, { timeoutMs: remaining });
    const state = surfaceStateOf(snap);
    const waitedMs = Date.now() - started;
    if (state === 'rendered') return { ready: true, state, waitedMs };
    const closed = typeof page.isClosed === 'function' && page.isClosed();
    if (waitedMs >= timeoutMs || closed) {
      const error = closed ? 'the page closed' : snap && 'error' in snap ? snap.error : undefined;
      return { ready: false, state: closed ? 'unreadable' : state, waitedMs, ...(error ? { error } : {}) };
    }
    await sleep(pollMs);
  }
}

/** The sentence a drive prints for a surface it never saw rendered. */
export function notReadyReason(result) {
  const secs = Math.round(result.waitedMs / 1000);
  const what = {
    unmounted: 'the app shell had not mounted',
    'no-outlet': 'the build carries no routed-region marker (`data-route-outlet`), so what the route rendered cannot be told from the shell around it — review a current build',
    empty: 'the routed content was still empty',
    loading: 'the route was still showing only its loading placeholder',
    unreadable: `the page could not be read (${result.error ?? 'no detail'})`,
  }[result.state] ?? `the surface was ${result.state}`;
  return `not observed: after ${secs}s ${what}, so this drive read nothing it could judge — not a product finding`;
}

/**
 * Thrown by a drive's check path when the surface it was about to judge was
 * never observed. Kept apart from every other error so the drive's catch can
 * record it as "not checked" without also excusing a real failure.
 */
export class NotObserved extends Error {
  constructor(why) {
    super(why);
    this.name = 'NotObserved';
  }
}
