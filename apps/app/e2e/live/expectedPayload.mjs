/**
 * WHOLE-PAYLOAD EQUALITY FOR A SIGNING GATE (#2422 r2).
 *
 * A live drive that signs on a funded wallet has to refuse anything it was
 * not built to sign. The first two versions of `live-refinance.mjs`'s gate
 * did that by HAND-PICKING fields — "offerType is 1 and the target loan is
 * right", then "these twenty-five fields" — and each review round found a
 * field the list had left unchecked (the Full-tariff trio on the signed
 * acceptance terms in round 2). A hand-picked list is a denylist wearing an
 * allowlist's clothes: it fails open on every field nobody thought of.
 *
 * So the comparison is structural and closed in BOTH directions:
 *
 *   - every field in the EXPECTED object must be present in the actual
 *     payload and match it (unless marked `optional`);
 *   - every field in the ACTUAL payload must appear in the expected object.
 *     A field the expected object does not name is itself a mismatch, so a
 *     struct that grows a field, or a payload that carries one it should
 *     not, is refused by construction rather than waved through.
 *
 * Pure and dependency-free so `expectedPayload.test.mjs` can pin it without
 * a chain or a browser — the same reason `writeConfirm.mjs` is.
 *
 * VALUE RULES. Wallet payloads arrive in mixed encodings (viem decodes
 * uint256 as bigint; JSON typed data carries it as a decimal string; RPC
 * envelopes carry hex quantities), so comparison normalises by the
 * EXPECTED value's type:
 *   bigint / number  → the actual must be an integer in any of those
 *                      encodings, compared as BigInt;
 *   boolean          → strictly the same boolean (no truthiness);
 *   '0x…' string     → case-insensitive (addresses, hashes, bytes);
 *   other string     → exact;
 *   array            → same length, element-wise;
 *   plain object     → the closed two-way field rule above;
 *   matcher          → `is(desc, test)` for a value the drive can bound but
 *                      not predict (a random nonce, a deadline relative to
 *                      chain time, an approval capped from above). Each one
 *                      states what it accepts, and that statement is what a
 *                      refusal prints.
 */

const MATCHER = Symbol('expectedPayload.matcher');
const OPTIONAL = Symbol('expectedPayload.optional');

/** A value the drive bounds rather than predicts. `desc` is printed on a
 *  mismatch, so write it as the acceptance rule ("> 0", "≤ 5e15"). */
export function is(desc, test) {
  return { [MATCHER]: true, desc, test };
}

/** A field that may be absent; when present it must match `inner`. */
export function optional(inner) {
  return { [OPTIONAL]: true, inner };
}

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !v[MATCHER] && !v[OPTIONAL];

function toBigInt(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v);
  return null;
}

const show = (v) => {
  if (typeof v === 'bigint') return `${v}n`;
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
  } catch {
    return String(v);
  }
};

/**
 * Every way `actual` differs from `expected`, as human-readable lines.
 * An empty array means the payload is exactly what was expected.
 *
 * @param {unknown} expected
 * @param {unknown} actual
 * @param {string} [path]
 * @returns {string[]}
 */
export function structMismatches(expected, actual, path = '') {
  const at = path || '(root)';
  if (expected && expected[OPTIONAL]) {
    return actual === undefined ? [] : structMismatches(expected.inner, actual, path);
  }
  if (expected && expected[MATCHER]) {
    let ok = false;
    try {
      ok = expected.test(actual) === true;
    } catch {
      ok = false;
    }
    return ok ? [] : [`${at}: ${show(actual)} (want ${expected.desc})`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${at}: ${show(actual)} (want an array of ${expected.length})`];
    if (actual.length !== expected.length) {
      return [`${at}: ${actual.length} elements (want ${expected.length})`];
    }
    return expected.flatMap((e, i) => structMismatches(e, actual[i], `${path}[${i}]`));
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return [`${at}: ${show(actual)} (want an object)`];
    const out = [];
    for (const k of Object.keys(expected)) {
      const sub = path ? `${path}.${k}` : k;
      const e = expected[k];
      if (!(k in actual) || actual[k] === undefined) {
        if (!(e && e[OPTIONAL])) out.push(`${sub}: missing (want ${describe(e)})`);
        continue;
      }
      out.push(...structMismatches(e, actual[k], sub));
    }
    for (const k of Object.keys(actual)) {
      if (!(k in expected) && actual[k] !== undefined) {
        out.push(`${path ? `${path}.${k}` : k}: unexpected field ${show(actual[k])}`);
      }
    }
    return out;
  }
  if (typeof expected === 'bigint' || typeof expected === 'number') {
    const a = toBigInt(actual);
    const e = BigInt(expected);
    return a !== null && a === e ? [] : [`${at}: ${show(actual)} (want ${e})`];
  }
  if (typeof expected === 'boolean') {
    return actual === expected ? [] : [`${at}: ${show(actual)} (want ${expected})`];
  }
  if (typeof expected === 'string') {
    if (/^0x/i.test(expected)) {
      return typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase()
        ? []
        : [`${at}: ${show(actual)} (want ${expected})`];
    }
    return actual === expected ? [] : [`${at}: ${show(actual)} (want ${show(expected)})`];
  }
  if (expected === null || expected === undefined) {
    return actual === expected ? [] : [`${at}: ${show(actual)} (want ${show(expected)})`];
  }
  return [`${at}: the expected value has an unsupported type (${typeof expected})`];
}

function describe(e) {
  if (e && e[MATCHER]) return e.desc;
  if (e && e[OPTIONAL]) return `optional ${describe(e.inner)}`;
  if (isPlainObject(e)) return 'an object';
  return show(e);
}
