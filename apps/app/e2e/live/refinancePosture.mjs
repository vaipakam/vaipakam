/**
 * #2349 / #2355 — the automatic-matching POSTURE banner on the borrower's
 * Refinance form, judged against the live chain.
 *
 * `AutoMatchPostureBanner` states one of four sentences on the refinance
 * surfaces: the protocol is paused, automatic matching is off, it is on, or
 * the app cannot tell yet. Which one it may state is decided by three reads
 * (`AdminFacet.paused()`, `getAutoRefinanceEnabled()` and
 * `ConfigFacet.getMasterFlags()[2]`, the matcher's `partialFill`), mapped by
 * `autoRefinancePostureFrom` in `src/data/autoRefinancePosture.ts`. This
 * module mirrors that mapping for the KNOWN states only, so a drive can read
 * the same three switches itself and say which sentence the deployed page
 * must be showing.
 *
 * Pure, for the reason `forcedCloseCard.mjs` and `jumpability.mjs` are: the
 * live chain presents one posture at a time (and, at the time of writing,
 * no position the form renders for at all), so every arm other than the one
 * the chain happens to be in can only be exercised here.
 *
 * WHAT A PASS ESTABLISHES, AND WHAT IT DOES NOT. It establishes that the
 * deployed form stated the posture the chain was in across the whole
 * observation, in the expected words, and stated no other posture's
 * sentence anywhere on the page. It does NOT establish that a lender's
 * accept would succeed (the banner never claims that), and it says nothing
 * about the standing-request card (`RefinancePendingCard`), which mounts
 * only for a request this device posted — a watch-only drive has none.
 */

/** The four posture states, in the banner's own vocabulary. */
export const POSTURES = Object.freeze(['on', 'off', 'paused', 'unknown']);

/**
 * The posture the chain's switches establish — the KNOWN arm of
 * `autoRefinancePostureFrom`. A pause outranks the matcher switches, and the
 * matcher fills a refinance request only while BOTH switches are on.
 *
 * `null` when any read is missing: this side never manufactures `unknown`,
 * because `unknown` is the page's statement about ITS read, while a drive
 * that could not read the chain has simply not established an expectation.
 *
 * @param {{paused: unknown, autoRefinance: unknown, partialFill: unknown} | null | undefined} sw
 * @returns {'on'|'off'|'paused'|null}
 */
export function expectedPostureFrom(sw) {
  if (!sw) return null;
  const { paused, autoRefinance, partialFill } = sw;
  if (
    typeof paused !== 'boolean' ||
    typeof autoRefinance !== 'boolean' ||
    typeof partialFill !== 'boolean'
  ) {
    return null;
  }
  if (paused) return 'paused';
  if (!autoRefinance || !partialFill) return 'off';
  return 'on';
}

/**
 * The four sentences, read from the repo's English catalogue — the same
 * place the drive already takes its forced-close copy from, so there is no
 * second copy to drift. Throws by name when a key is missing, so the caller
 * can classify it as a local setup failure (BLOCKED) rather than a product
 * defect.
 *
 * @param {object} bundle parsed `src/i18n/locales/en.json`
 * @returns {{on: string, off: string, paused: string, unknown: string}}
 */
export function postureCopyFrom(bundle) {
  const r = bundle?.copy?.refinance ?? {};
  const need = (key) => {
    const v = r[key];
    if (typeof v !== 'string' || v === '') {
      throw new Error(
        `copy.refinance.${key} is missing from src/i18n/locales/en.json — the ` +
          'refinance posture observation cannot judge the banner without it.',
      );
    }
    return v;
  };
  return {
    on: need('autoMatchOn'),
    off: need('autoMatchOff'),
    paused: need('autoMatchPaused'),
    unknown: need('autoMatchUnknown'),
  };
}

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Judge one visit's observation.
 *
 * @param {object} o
 * @param {boolean} o.applicable  the drive expected the form on this visit
 *   (borrower run, Advanced mode seeded, the observed wallet is the loan's
 *   STORED borrower, and the chooser's own eligibility held)
 * @param {object|null} o.before  chain switches read before navigation
 * @param {object|null} o.after   chain switches read after the scrape
 * @param {boolean} o.formPresent  the refinance form's card rendered
 * @param {number}  o.bannerCount  posture banners inside the form
 * @param {string|null} o.attr     the banner's `data-auto-match-posture`
 * @param {string|null} o.text     the banner's own text
 * @param {string} o.pageText      the whole page's text at the scrape
 * @param {string|null} [o.error]  the scrape itself threw
 * @param {{on: string, off: string, paused: string, unknown: string}} copy
 * @returns {null | {verdict: 'pass'|'fail'|'blocked', why: string,
 *   failKind?: 'observed'|'chain', expected?: string|null, observed?: string|null}}
 */
export function refinancePostureVerdict(o, copy) {
  if (!o || !o.applicable) return null;
  const expected = expectedPostureFrom(o.before);
  const after = expectedPostureFrom(o.after);
  const base = { expected, observed: o.attr ?? null };
  if (o.error) {
    return { ...base, verdict: 'blocked', why: `the posture scrape threw: ${o.error}` };
  }
  if (expected === null || after === null) {
    return {
      ...base,
      verdict: 'blocked',
      why: 'the drive could not read the chain posture on both sides of the observation',
    };
  }
  if (expected !== after) {
    // A governance flip (or a pause window opening/closing) between the two
    // reads: the page may correctly be showing either, so nothing can be
    // concluded either way.
    return {
      ...base,
      verdict: 'blocked',
      why: `the chain posture moved during the observation (${expected} → ${after})`,
    };
  }
  if (!o.formPresent) {
    // The form sits behind gates this drive does not mirror in full
    // (sanctions resolution, a sale-completion window, the page's own
    // live-loan / fee / offset-lock reads), so its absence is a failure to
    // observe, not a regression this drive can attribute.
    return {
      ...base,
      verdict: 'blocked',
      why: 'the refinance form did not render, so the banner could not be observed',
    };
  }
  if (!o.bannerCount) {
    // The banner is unconditional inside the rendered form — a missing
    // sentence would imply an availability the app has not read.
    return {
      ...base,
      verdict: 'fail',
      failKind: 'observed',
      why: 'the refinance form rendered WITHOUT its automatic-matching posture banner',
    };
  }
  if (o.bannerCount > 1) {
    return {
      ...base,
      verdict: 'fail',
      failKind: 'observed',
      why: `the refinance form rendered ${o.bannerCount} posture banners, expected exactly one`,
    };
  }
  if (o.attr === 'unknown') {
    // Still loading at the deadline, or the page's read failed. Either way
    // the banner is honestly stating `unknown`, and this drive cannot tell a
    // slow read from a broken one — blocked, not a pass.
    return {
      ...base,
      verdict: 'blocked',
      why: 'the banner still stated "unknown" at the deadline — the page\'s posture read did not settle',
    };
  }
  if (!POSTURES.includes(o.attr)) {
    return {
      ...base,
      verdict: 'fail',
      failKind: 'observed',
      why: `the banner published an unrecognised posture "${o.attr}"`,
    };
  }
  if (o.attr !== expected) {
    // `chain`: a page reading ANOTHER network's Diamond would show another
    // posture, so this is ranked with the absences the drive's wrong-chain
    // gates outrank, never promoted above them.
    return {
      ...base,
      verdict: 'fail',
      failKind: 'chain',
      why: `the banner stated "${o.attr}" while the chain posture was "${expected}"`,
    };
  }
  if (squash(o.text) !== squash(copy[expected])) {
    return {
      ...base,
      verdict: 'fail',
      failKind: 'observed',
      why: `the "${expected}" banner did not carry copy.refinance's sentence for that posture`,
    };
  }
  const page = squash(o.pageText);
  const others = POSTURES.filter((p) => p !== expected && page.includes(squash(copy[p])));
  if (others.length) {
    return {
      ...base,
      verdict: 'fail',
      failKind: 'chain',
      why: `the page ALSO stated the ${others.join(', ')} posture sentence(s) beside "${expected}"`,
    };
  }
  return { ...base, verdict: 'pass', why: `stated "${expected}" in the expected words, and no other posture` };
}

/**
 * The run-level gap: was the advertised posture assertion actually made?
 *
 * `null` when the assertion was not requested, or when every applicable
 * visit produced a verdict other than `blocked` and at least one did. A
 * `fail` is not a gap — it is reported by the visit's own verdict.
 *
 * @param {Array<{path: string, refinancePostureVerdict?: object|null}>} visited
 * @param {boolean} enabled
 * @returns {string|null}
 */
export function refinancePostureCoverage(visited, enabled) {
  if (!enabled) return null;
  const judged = visited.filter((v) => v.refinancePostureVerdict);
  if (judged.length === 0) {
    return (
      'the refinance posture assertion never ran — no visited position was one ' +
      'the observed wallet can post a refinance request on'
    );
  }
  const blocked = judged.filter((v) => v.refinancePostureVerdict.verdict === 'blocked');
  if (blocked.length) {
    return (
      `the refinance posture assertion could not complete on ${blocked.length} of ` +
      `${judged.length} position(s): ` +
      blocked.map((v) => `${v.path} (${v.refinancePostureVerdict.why})`).join('; ')
    );
  }
  return null;
}
