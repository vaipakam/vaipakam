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
 * Read a key ONLY if the object owns it.
 *
 * A plain `obj[key]` resolves inherited names — `constructor`,
 * `toString`, `hasOwnProperty` — so a patch or an API reply carrying
 * one of those as a translation key looked like it matched the
 * template and sailed through the shape validation that exists
 * precisely to reject unrequested fields (Codex #1563 r2). Every
 * lookup that asks "does the other side have this key?" goes through
 * here.
 */
const own = (obj: Bundle, key: string): Bundle[string] | undefined =>
  Object.hasOwn(obj, key) ? obj[key] : undefined;

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
    const counterpart = own(target, key);
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
    const existing = own(out, key);
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
    const counterpart = own(subject, key);
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
  return scanPlaceholders(value).tokens;
}

/**
 * Brace runs that are NOT a well-formed i18next token — `{{{amount}}}`,
 * `{{amount}}}`, a lone `{{`.
 *
 * These have to be surfaced separately because the naive scan is happy
 * to find a valid token INSIDE a malformed run: in `{{{amount}}}` the
 * match starting at the second brace yields `amount`, so a token-set
 * comparison sees nothing wrong while i18next renders the string
 * literally (and `{{amount}}}` renders as `42}`). The user gets raw
 * braces on a sentence that was supposed to quote a value (Codex #1563
 * r2).
 */
export function malformedPlaceholders(value: string): string[] {
  return scanPlaceholders(value).malformed;
}

/**
 * One pass over `value`, splitting brace runs into well-formed tokens
 * and malformed remnants.
 *
 * A match only counts as a token when it is not FLANKED by another
 * brace — `{{x}}` yes, `{{{x}}}` no. Anything else in a brace run is
 * reported as malformed.
 */
function scanPlaceholders(value: string): { tokens: string[]; malformed: string[] } {
  const tokens: string[] = [];
  const malformed: string[] = [];
  PLACEHOLDER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let consumedTo = 0;
  while ((match = PLACEHOLDER_RE.exec(value)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const flanked = value[start - 1] === '{' || value[end] === '}';
    if (flanked) {
      malformed.push(value.slice(Math.max(consumedTo, start - 1), end + 1));
    } else {
      tokens.push(match[1].trim());
    }
    consumedTo = end;
  }
  // A brace pair with no closing partner never matches at all, so scan
  // for leftover `{{` / `}}` runs the token pass didn't consume.
  const leftovers = value.replace(PLACEHOLDER_RE, '');
  if (/\{\{|\}\}/.test(leftovers)) {
    for (const run of leftovers.match(/\{\{+|\}\}+/g) ?? []) malformed.push(run);
  }
  return { tokens, malformed };
}

/**
 * `[^{}]` — excluding the OPENING brace as well as the closing one — is
 * load-bearing, not tidiness. With `[^}]*` the leading `{{` and the body
 * both match `{`, so the engine has many ways to split a run of braces
 * and backtracks over them: CodeQL flags `{{{{|{{{{|…` as polynomial
 * blowup, and these strings come from locale files a translation model
 * or an outside contributor wrote. Excluding `{` makes the split unique
 * and the scan linear, and it costs nothing: an i18next token can't
 * contain a brace anyway.
 */
const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;

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
  /** Brace runs in the translation that aren't well-formed tokens
   *  (`{{{amount}}}`). Never legitimate — i18next renders them raw. */
  malformed: string[];
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
    const malformed = malformedPlaceholders(actual);
    const remaining = [...after];
    const dropped: string[] = [];
    for (const token of before) {
      const at = remaining.indexOf(token);
      if (at === -1) dropped.push(token);
      else remaining.splice(at, 1);
    }
    if (dropped.length > 0 || remaining.length > 0 || malformed.length > 0) {
      out.push({ path, unknown: remaining, dropped, malformed });
    }
  };

  for (const [key, value] of Object.entries(source)) {
    const counterpart = own(subject, key);
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
          malformed: [],
        });
      }
      const overlap = Math.min(value.length, counterpart.length);
      for (let i = 0; i < overlap; i += 1) {
        // Only compare entries that are actually strings. A same-length
        // array holding a number or an object reaches here BEFORE
        // `leafTypeDrift` gets to report it, and calling string methods
        // on it threw `TypeError: value.replace is not a function` —
        // aborting a whole merge batch with a stack trace instead of
        // the intended per-locale rejection (Codex #1563 r5). The bad
        // element is still reported, by the check that exists for it.
        const theirs = counterpart[i];
        if (typeof value[i] !== 'string' || typeof theirs !== 'string') continue;
        compare(`${path}[${i}]`, value[i], theirs);
      }
    } else if (typeof counterpart === 'string') {
      compare(path, value, counterpart);
    }
  }
  return out;
}

/** One leaf whose VALUE SHAPE doesn't match the source's. */
export interface LeafTypeDrift {
  path: string;
  expected: string;
  actual: string;
}

const shapeOf = (v: unknown): string => {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  if (isBranch(v)) return 'object';
  return typeof v;
};

/**
 * Leaves that `subject` HAS but at the wrong shape — an English string
 * answered with an object, an array, a number, or null.
 *
 * `missingSubtree` deliberately cannot see these: the key is present,
 * so by its definition the locale covers it. But i18next does not
 * render a non-string — it logs `key 'x (fr)' returned an object
 * instead of string` and shows nothing — so a coverage check that only
 * counts keys reports a locale complete while a sentence renders empty.
 * A translation model returning a nested object where the template had
 * a string, or a hand-authored patch pasting one level too deep, both
 * land here (Codex #1563 r1).
 *
 * Reported separately from "missing" because the fix differs: a missing
 * key needs translating, a drifted one needs correcting.
 */
export function leafTypeDrift(
  source: Bundle,
  subject: Bundle,
  prefix = '',
): LeafTypeDrift[] {
  const out: LeafTypeDrift[] = [];
  for (const [key, value] of Object.entries(source)) {
    const counterpart = own(subject, key);
    if (counterpart === undefined) continue; // absent → missingSubtree's job
    const path = `${prefix}${key}`;
    if (isBranch(value) && isBranch(counterpart)) {
      out.push(...leafTypeDrift(value, counterpart, `${path}.`));
      continue;
    }
    const expected = shapeOf(value);
    const actual = shapeOf(counterpart);
    if (expected !== actual) {
      out.push({ path, expected, actual });
      continue;
    }
    // Same shape, but an array must keep its LENGTH and stay an array
    // OF STRINGS. Length is checked here rather than left to
    // `missingSubtree`, which treats an array as one opaque leaf and so
    // reads a three-bullet warning list answered with two as complete.
    if (Array.isArray(value) && Array.isArray(counterpart)) {
      if (value.length !== counterpart.length) {
        out.push({
          path,
          expected: `array of ${value.length}`,
          actual: `array of ${counterpart.length}`,
        });
      }
      counterpart.forEach((entry, i) => {
        if (typeof entry !== 'string') {
          out.push({ path: `${path}[${i}]`, expected: 'string', actual: shapeOf(entry) });
        }
      });
    }
  }
  return out;
}

/**
 * Paths `subject` has that `source` does not — a typo, a stale key, or
 * a section that has since been renamed.
 *
 * Without this a mistyped patch key is silently ACCEPTED: the wrong key
 * lands in the bundle, the real one stays missing, and the merge still
 * reports success. If that section happens to sit in the coverage
 * guard's known-backlog allowlist, CI passes too, and the string keeps
 * falling back to English with nothing anywhere saying so (Codex #1563
 * r1). Cheap to detect, and a typo has no legitimate reading.
 */
export function unknownKeys(source: Bundle, subject: Bundle, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(subject)) {
    const counterpart = own(source, key);
    const path = `${prefix}${key}`;
    if (counterpart === undefined) {
      out.push(path);
    } else if (isBranch(value) && isBranch(counterpart)) {
      out.push(...unknownKeys(counterpart, value, `${path}.`));
    }
  }
  return out;
}

/**
 * Leaves where `subject` holds an EMPTY string but `source` does not.
 *
 * Invisible to every other check: `missingSubtree` sees the key as
 * present, `leafTypeDrift` sees a valid string, and `placeholderDrift`
 * finds no tokens to compare. Meanwhile i18next's `returnEmptyString`
 * defaults to true, so an empty resource renders BLANK rather than
 * falling back to English — a sentence silently disappears from the
 * page for that language, and every guard reports the locale complete
 * (Codex #1563 r6).
 *
 * Not always a defect, which is why this reports rather than decides:
 * Japanese moves the verb to the end, so alpha02's consent sentence
 * legitimately has an empty `prefix` with the agreement carried in
 * `suffix`. Callers pair this with a narrow per-`<locale>:<path>`
 * exemption.
 */
export function emptyTranslations(source: Bundle, subject: Bundle, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    const counterpart = own(subject, key);
    if (counterpart === undefined) continue;
    const path = `${prefix}${key}`;
    if (isBranch(value) && isBranch(counterpart)) {
      out.push(...emptyTranslations(value, counterpart, `${path}.`));
    } else if (
      typeof value === 'string' &&
      typeof counterpart === 'string' &&
      value.trim() !== '' &&
      counterpart.trim() === ''
    ) {
      out.push(path);
    } else if (Array.isArray(value) && Array.isArray(counterpart)) {
      // Array ELEMENTS need the same check as scalars. A blank entry in
      // a bullet list — one of the recovery warnings, a help risk —
      // passes `leafTypeDrift` (still a string) and `placeholderDrift`
      // (no tokens either side), so it reached the UI as an empty
      // bullet with every guard reporting the locale complete (Codex
      // #1563 r7). Scalars were covered from the start; arrays were
      // simply not looked into.
      const overlap = Math.min(value.length, counterpart.length);
      for (let i = 0; i < overlap; i += 1) {
        const source = value[i];
        const theirs = counterpart[i];
        if (
          typeof source === 'string' &&
          typeof theirs === 'string' &&
          source.trim() !== '' &&
          theirs.trim() === ''
        ) {
          out.push(`${path}[${i}]`);
        }
      }
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
