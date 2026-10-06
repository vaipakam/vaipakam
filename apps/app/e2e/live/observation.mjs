/**
 * RULE 1 — AN OBSERVATION IS JUDGED ONLY AGAINST CONFIG THAT HELD STILL
 * AROUND IT (#2422 r10).
 *
 * A live drive compares what the browser RENDERED (a posture banner, a fee
 * percentage, a grace window) with the chain's config. The page rendered
 * from reads it made at some moment the drive does not see, so a judgement
 * against one snapshot taken at another moment can call a correct page wrong
 * — or a wrong page right — whenever the config moved in between. Three
 * review rounds found that seam one call site at a time; this module is the
 * one rule they all go through:
 *
 *   1. read the config BEFORE the observation, and once AFTER it;
 *   2. if the two reads differ — or either differs from the drive's pinned
 *      BASELINE (the page may have rendered from the older value) — that is
 *      a STATE RACE: before any write the drive stops BLOCKED; after one,
 *      the check is UNDETERMINED. Never a FAIL: nothing was observed wrong.
 *   3. a config that cannot be read is treated the same way;
 *   4. an observation that THROWS is still followed by its after-read
 *      (#2434 r2): a page that failed WHILE the config moved has not been
 *      shown to be wrong, so a move (or an unreadable after-read) is the
 *      race above, carrying the error; only when the config held is the
 *      observation's own error rethrown, unchanged;
 *   5. otherwise the observation is judged against that one value.
 *
 * Pure apart from the callbacks it is handed; `observation.test.mjs` pins
 * the ordering and every outcome.
 */

const stable = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

/**
 * The keys whose values differ between two config readings, as readable
 * `key: a → b` lines. A key present in one reading only counts as changed.
 */
export function configChanges(a, b) {
  const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
  return keys.filter((k) => stable(a?.[k]) !== stable(b?.[k])).map((k) => `${k}: ${stable(a?.[k])} → ${stable(b?.[k])}`);
}

/**
 * Run `observe` between two `readConfig` calls.
 *
 * @param {{ baseline?: object, readConfig: () => Promise<object>,
 *           observe: () => Promise<any> }} a
 * @returns {Promise<{ state: 'stable', config: object, observed: any }
 *   | { state: 'race', changes: string[], observed: any, observeError?: string }
 *   | { state: 'unreadable', error: string, observed?: any, observeError?: string }>}
 *   Throws the observation's own error when it threw and the config held.
 */
export async function observeAgainstChain({ baseline, readConfig, observe }) {
  let before;
  try {
    before = await readConfig();
  } catch (e) {
    return { state: 'unreadable', error: `config read before the observation failed: ${errText(e)}` };
  }
  // The observation's error is HELD, not propagated, until the after-read
  // has said whether the config moved around it.
  let observed;
  let observeError = null;
  try {
    observed = await observe();
  } catch (e) {
    observeError = e;
  }
  const thrown = observeError ? { observeError: errText(observeError) } : {};
  let after;
  try {
    after = await readConfig();
  } catch (e) {
    return { state: 'unreadable', error: `config read after the observation failed: ${errText(e)}`, observed, ...thrown };
  }
  const changes = [
    ...(baseline ? configChanges(baseline, before).map((c) => `since the preflight, ${c}`) : []),
    ...configChanges(before, after).map((c) => `during the observation, ${c}`),
  ];
  if (changes.length) return { state: 'race', changes, observed, ...thrown };
  if (observeError) throw observeError;
  return { state: 'stable', config: after, observed };
}

/**
 * What a result means for the drive. `wrote` is whether any transaction or
 * signature of this run has reached the wallet: before one, a race or an
 * unreadable config is BLOCKED (nothing has changed on chain); after one it
 * is UNDETERMINED. A stable result is judged.
 *
 * @returns {{ action: 'judge', config: object }
 *   | { action: 'blocked' | 'undetermined', why: string }}
 */
export function observationVerdict(result, { wrote, what }) {
  if (result.state === 'stable') return { action: 'judge', config: result.config };
  const why =
    result.state === 'race'
      ? `the chain config ${what} is judged against moved (${result.changes.join('; ')}) — a state race, not a product defect`
      : `the chain config ${what} is judged against could not be read (${result.error})`;
  const also = result.observeError ? `; the observation itself failed meanwhile: ${result.observeError}` : '';
  return { action: wrote ? 'undetermined' : 'blocked', why: why + also };
}

function errText(e) {
  return String(e?.shortMessage ?? e?.message ?? e).split('\n')[0].slice(0, 120);
}
