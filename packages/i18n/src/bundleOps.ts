/**
 * Structural operations on locale bundles, shared by the translate
 * script and the patch-merge script.
 *
 * These exist because of a failure mode the translate script could not
 * see: it only ever targeted bundles that were MISSING or an empty `{}`
 * placeholder, and its only other mode overwrote a bundle wholesale. So
 * a locale that had been translated once froze at that day's key set —
 * every section added afterwards silently fell back to English, in a
 * bundle that looked complete. `apps/alpha02` accumulated 291 such keys
 * across nine locales, including every string on the stuck-token
 * recovery page (see #1560).
 *
 * The fix is to make "translate only what this locale is missing" a
 * first-class operation, which needs exactly three primitives:
 * find the gap, merge a partial answer back in, and keep the file
 * ordered like the source so the diff reads as pure additions.
 *
 * Arrays are LEAVES throughout. A translated array (e.g. a list of
 * warning bullets) is replaced as a unit rather than merged
 * element-wise: element-wise merging would let a locale keep a stale
 * bullet at index 2 while the source dropped it, producing a bundle
 * that no source revision ever described.
 */

/** A locale bundle: nested objects bottoming out in strings or string
 *  arrays. Mirrors what `buildTemplate` emits. */
export type Bundle = { [key: string]: string | string[] | Bundle };

const isBranch = (v: unknown): v is Bundle =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The subtree of `source` whose leaves `target` does not have, keeping
 * the nesting shape. Returns `null` when nothing is missing — callers
 * use that to skip a locale entirely rather than spend a translation
 * request confirming it is complete.
 *
 * A leaf counts as missing only when the key is ABSENT. A key present
 * with a translated value is left alone even if the English has since
 * been reworded: re-translating on English drift is a separate concern
 * (that's what the `en.json` template drift check is for), and folding
 * it in here would quietly overwrite reviewed translations.
 */
export function missingSubtree(source: Bundle, target: Bundle): Bundle | null {
  const out: Bundle = {};
  for (const [key, value] of Object.entries(source)) {
    const counterpart = target[key];
    if (isBranch(value)) {
      // A branch the target lacks entirely, or has as a non-branch
      // (shape drift), is missing wholesale.
      const nested = isBranch(counterpart)
        ? missingSubtree(value, counterpart)
        : value;
      if (nested !== null && Object.keys(nested).length > 0) out[key] = nested;
    } else if (counterpart === undefined) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * `patch` merged over `base`, recursing into branches and replacing
 * leaves. Neither input is mutated.
 */
export function deepMerge(base: Bundle, patch: Bundle): Bundle {
  const out: Bundle = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    out[key] =
      isBranch(value) && isBranch(existing) ? deepMerge(existing, value) : value;
  }
  return out;
}

/**
 * `subject` rebuilt in `source`'s key order, and pruned of keys
 * `source` doesn't have (they cannot be translated against anything and
 * no consumer reads them — i18next resolves keys from the English
 * catalog).
 *
 * OPT-IN, not automatic. Applying it to a bundle whose order has
 * already drifted from the template rewrites most of the file, which is
 * the opposite of what it is for: on the alpha02 locales it turned a
 * clean ~130-line insertion into 1100 insertions and 950 deletions per
 * locale, burying the actual translations. Reach for it as a deliberate
 * mechanical normalisation on its own commit, so the reordering is
 * reviewable as reordering — never bundled with content changes.
 */
export function orderLike(source: Bundle, subject: Bundle): Bundle {
  const out: Bundle = {};
  for (const [key, value] of Object.entries(source)) {
    const counterpart = subject[key];
    if (counterpart === undefined) continue;
    out[key] =
      isBranch(value) && isBranch(counterpart)
        ? orderLike(value, counterpart)
        : counterpart;
  }
  return out;
}

/** The i18next interpolation tokens in a string, inner text trimmed —
 *  `"Sent {{amount}} {{symbol}}"` → `['amount', 'symbol']`. Format
 *  suffixes are part of the token (`{{count, number}}`), because
 *  dropping the suffix changes the rendered output just as surely as
 *  dropping the name. */
export function placeholders(value: string): string[] {
  return [...value.matchAll(/{{([^}]*)}}/g)].map((m) => m[1].trim());
}

/** One leaf whose interpolation tokens don't match the source's. */
export interface PlaceholderDrift {
  /** Dot-joined leaf path; array leaves carry a `[i]` suffix. */
  path: string;
  /** Tokens the translation introduced that the English doesn't have —
   *  always a defect: i18next has nothing to substitute, so the user
   *  sees literal braces or an empty gap. */
  unknown: string[];
  /** Tokens the English has that the translation dropped. USUALLY a
   *  defect (a value silently vanishes from the sentence), but not
   *  always: in languages with grammatical dual, the `_two` plural form
   *  encodes the count in the noun itself, so restating it is wrong.
   *  Reported separately so callers can allowlist those cases instead
   *  of being forced to choose between a false alarm and no check. */
  dropped: string[];
}

/**
 * Compare every leaf `subject` shares with `source` and report the ones
 * whose interpolation tokens differ.
 *
 * This is the check that catches the failure mode placeholders have:
 * they are invisible in review (a reviewer reading Tamil sees fluent
 * Tamil, not a missing `{{amount}}`) and they fail at RENDER time, in
 * that locale only, on a sentence that is often the one quoting a
 * number the user is about to sign for.
 *
 * Reordering is fine and expected — the token multiset is compared, not
 * the sequence, because target grammar routinely wants a different word
 * order than English.
 */
export function placeholderDrift(
  source: Bundle,
  subject: Bundle,
  prefix = '',
): PlaceholderDrift[] {
  const out: PlaceholderDrift[] = [];
  const compare = (path: string, expected: string, actual: string): void => {
    const before = placeholders(expected);
    const after = placeholders(actual);
    const remaining = [...after];
    const dropped: string[] = [];
    for (const token of before) {
      const at = remaining.indexOf(token);
      if (at === -1) dropped.push(token);
      else remaining.splice(at, 1);
    }
    if (dropped.length > 0 || remaining.length > 0) {
      out.push({ path, unknown: remaining, dropped });
    }
  };

  for (const [key, value] of Object.entries(source)) {
    const counterpart = subject[key];
    if (counterpart === undefined) continue;
    const path = `${prefix}${key}`;
    if (isBranch(value)) {
      if (isBranch(counterpart)) out.push(...placeholderDrift(value, counterpart, `${path}.`));
    } else if (Array.isArray(value)) {
      if (!Array.isArray(counterpart)) continue;
      // Only the overlap is comparable; a length difference is a
      // separate defect that `missingSubtree` cannot see, so surface it
      // as an unknown-token entry rather than letting it pass silently.
      if (value.length !== counterpart.length) {
        out.push({
          path,
          unknown: [`array length ${counterpart.length}, expected ${value.length}`],
          dropped: [],
        });
      }
      const overlap = Math.min(value.length, counterpart.length);
      for (let i = 0; i < overlap; i += 1) {
        compare(`${path}[${i}]`, value[i], counterpart[i] as string);
      }
    } else if (typeof counterpart === 'string') {
      compare(path, value, counterpart);
    }
  }
  return out;
}

/** Every leaf path in `bundle`, dot-joined. For coverage reporting. */
export function leafPaths(bundle: Bundle, prefix = ''): string[] {
  return Object.entries(bundle).flatMap(([key, value]) =>
    isBranch(value)
      ? leafPaths(value, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}
