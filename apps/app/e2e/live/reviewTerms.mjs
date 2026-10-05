/**
 * READING THE TERMS A REVIEW SCREEN ACTUALLY SHOWS (#2422 r7).
 *
 * The drive's write gate binds what is SIGNED to the reviewed intent. That
 * leaves one gap: what the page DISPLAYED before consent. A review that
 * showed the wrong principal, rate, length or fee would be consented to and
 * then signed correctly — the signature would be right and the consent
 * would be to something else. So before every consent tick the drive reads
 * the review receipt's rows and compares the figures in them with the chain.
 *
 * HOW, without guessing and without copying the app's formatters:
 *   - The receipt is `ReviewReceipt` (apps/app/src/components): rows of
 *     `.receipt-row > dt/dd`, labelled by `copy.receipt.*`. Rows are found
 *     by their LABEL from en.json, not by position.
 *   - Each row's text is matched against the en.json TEMPLATE that produced
 *     it (`templateRegex`): the literal text must match exactly, and each
 *     `{{placeholder}}` is captured. A row that does not fit its template is
 *     UNPARSEABLE — a failure, not a skip.
 *   - Captured values are compared with the chain at the precision the app
 *     displays: an amount is the token's own symbol plus a number that must
 *     equal the true value as `formatTokenAmount` would round it (four
 *     significant digits below one, four decimals above); a percent is
 *     `formatBpsAsPercent`'s two-decimal figure; a length is parsed back
 *     through the en.json unit words and compared in days; a grace window is
 *     compared as the exact label `formatGraceSeconds` renders for the
 *     configured seconds (r8 — that formatter rounds, so parsing back is
 *     lossy). Equality at display precision means a figure that RENDERS
 *     the same as the true one passes, and any visibly different one fails.
 *   - Each label must label EXACTLY ONE row (r8): none, or two, is a
 *     mismatch — a duplicate row with a different figure is something the
 *     reader saw.
 *
 * Pure; `reviewTerms.test.mjs` pins it with the strings the deployed app
 * rendered on 2026-10-05.
 */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A RegExp for an en.json template: literals exact, each `{{name}}` (or
 * `{{name, format}}`) a lazy named capture. Anchored at the start; anchored
 * at the end unless `prefix` (a row that carries further sentences after the
 * template); `anywhere` finds the template inside a longer row. Every template used here ends in literal text, so a lazy
 * capture is always bounded.
 */
export function templateRegex(template, { prefix = false, anywhere = false } = {}) {
  let src = '';
  let last = 0;
  const re = /\{\{\s*(\w+)[^}]*\}\}/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(template))) {
    src += escapeRe(template.slice(last, m.index));
    const name = m[1];
    src += seen.has(name) ? `\\k<${name}>` : `(?<${name}>.+?)`;
    seen.add(name);
    last = m.index + m[0].length;
  }
  src += escapeRe(template.slice(last));
  // `anywhere`: a sentence that sits inside a longer row (the wallet note
  // after the payoff line) — unanchored, still bounded by its literals.
  if (anywhere) return new RegExp(src);
  return new RegExp(`^${src}${prefix ? '' : '$'}`);
}

/** Captured placeholders, or null when the text does not fit. */
export function matchTemplate(template, text, opts) {
  const m = templateRegex(template, opts).exec(squash(text));
  return m ? { ...m.groups } : null;
}

export const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** "0.005 WETH" / "1,234.5 USDC" → { num, symbol }; null if not that shape. */
export function parseAmount(s) {
  const m = /^~?\s*([\d,]+(?:\.\d+)?)\s+(\S+)$/.exec(squash(s));
  if (!m) return null;
  return { num: Number(m[1].replace(/,/g, '')), symbol: m[2] };
}

/**
 * Does a displayed number equal the raw on-chain amount AT DISPLAY
 * PRECISION? Mirrors `formatTokenAmount`'s rounding rule without copying
 * its code: below one, four significant digits; otherwise four decimals.
 */
export function amountMatches(displayed, raw, decimals) {
  if (typeof displayed !== 'number' || !Number.isFinite(displayed)) return false;
  const truth = Number(raw) / 10 ** decimals;
  if (truth === 0) return displayed === 0;
  const halfStep =
    Math.abs(truth) < 1 ? 0.5 * 10 ** (Math.floor(Math.log10(Math.abs(truth))) - 3) : 0.5e-4;
  return Math.abs(displayed - truth) <= halfStep * (1 + 1e-9);
}

/** "2%" / "0.2%" → bps as a Number (two decimals of percent, as displayed). */
export function parsePercentBps(s) {
  const m = /^([\d.]+)%$/.exec(squash(s));
  return m ? Math.round(Number(m[1]) * 100) : null;
}

/** `formatBpsAsPercent`'s value: percent rounded to two decimals. */
export const percentMatches = (displayedBps, bps) =>
  displayedBps !== null && displayedBps === Math.round(Number((Number(bps) / 100).toFixed(2)) * 100);

/**
 * A length rendered by `formatDurationDays`, parsed back through the en.json
 * unit words (`copy.units.duration{Day,Month,Year}_{one,other}`) → days.
 * A month is 30 days and a year 365, exactly as the formatter collapses.
 */
export function parseDurationDays(s, units) {
  const t = squash(s);
  const forms = [
    ['Day', 1],
    ['Month', 30],
    ['Year', 365],
  ];
  for (const [unit, mult] of forms) {
    if (t === units[`duration${unit}_one`]) return mult;
    const m = templateRegex(units[`duration${unit}_other`]).exec(t);
    if (m) return Number(m.groups.count.replace(/,/g, '')) * mult;
  }
  return null;
}

/**
 * The label the app renders for a grace window of `seconds` — a mirror of
 * `formatGraceSeconds` (apps/app/src/lib/grace.ts), the single formatter
 * every grace label in the app goes through (`data/protocol.ts`,
 * `offerSchema.gracePeriodLabel`).
 *
 * WHY a mirror and not a parser (#2422 r8): the formatter ROUNDS. 3,700 s
 * renders "1 hour"; parsing "1 hour" back gives 3,600 s, which is not the
 * configured 3,700 — so a parse-and-compare-seconds check failed a review
 * that showed exactly what the app was meant to show. The question the
 * review check asks is "did the page render the label for the configured
 * grace?", and that is answered by formatting the configured seconds the
 * same way and comparing STRINGS. The test pins this mirror against the
 * formatter's branch table, 3,700 s → "1 hour" among them.
 */
export function formatGraceSeconds(seconds) {
  const s = Number(seconds);
  if (s < 3_600) return `${Math.max(1, Math.round(s / 60))} minutes`;
  if (s < 86_400) {
    const h = Math.round(s / 3_600);
    return h === 1 ? '1 hour' : `${h} hours`;
  }
  const days = Math.round(s / 86_400);
  if (days === 1) return '1 day';
  if (days === 7) return '1 week';
  if (days === 14) return '2 weeks';
  return `${days} days`;
}

/**
 * Collect mismatches as readable lines: `want(label, ok, shown, expected)`.
 * Returned list empty ⇔ every compared term matched.
 */
export function termLedger() {
  const out = [];
  return {
    want(label, ok, shown, expected) {
      if (!ok) out.push(`${label}: shown ${JSON.stringify(shown)}, expected ${expected}`);
    },
    mismatches: () => out,
  };
}

// ---------------------------------------------------------------------
// The two receipts this drive consents to, compared term by term.
// ---------------------------------------------------------------------

/**
 * The rows carrying a label: EXACTLY ONE is the only usable answer
 * (#2422 r8). With a first-match lookup, a receipt that rendered the right
 * figure in one row and a different figure in a second row of the same
 * label passed — the comparison read whichever came first, and the reader
 * of the page saw both. Zero rows and two-or-more rows are both mismatches.
 */
export function rowsLabelled(rows, label) {
  const want = squash(label);
  return rows.filter((r) => squash(r.label) === want);
}

/** One comparison over receipt rows ({ label, value } text). Rows are
 *  found by their en.json LABEL — exactly one per label; `compared` lists
 *  every term looked at. */
function comparer(rows, en) {
  const L = termLedger();
  const compared = [];
  const reported = new Set();
  /** The single row's value, or null — and a non-single count is recorded
   *  as a mismatch once per label, however many terms read that row. */
  const valueOf = (key) => {
    const hits = rowsLabelled(rows, en.receipt[key]);
    if (hits.length === 1) return squash(hits[0].value);
    if (!reported.has(key)) {
      reported.add(key);
      L.want(
        `"${en.receipt[key]}" row`,
        false,
        hits.map((r) => squash(r.value)),
        hits.length === 0 ? 'exactly one row (none rendered)' : `exactly one row (${hits.length} rendered)`,
      );
    }
    return null;
  };
  const fit = (key, template, opts) => {
    const v = valueOf(key);
    if (v === null) return null;
    const g = matchTemplate(template, v, opts);
    if (!g) L.want(`"${en.receipt[key]}" row`, false, v, `text fitting ${JSON.stringify(template)}`);
    return g;
  };
  const amount = (label, shown, raw, decimals, symbol) => {
    compared.push(label);
    const p = parseAmount(shown ?? '');
    const truth = `${Number(raw) / 10 ** decimals} ${symbol}`;
    L.want(label, p !== null && p.symbol === symbol && amountMatches(p.num, raw, decimals), shown, truth);
  };
  const percent = (label, shown, bps) => {
    compared.push(label);
    L.want(label, percentMatches(parsePercentBps(shown ?? ''), bps), shown, `${Number(bps) / 100}%`);
  };
  const exact = (key, text) => {
    compared.push(`"${en.receipt[key]}" text`);
    const v = valueOf(key);
    if (v !== null) L.want(`"${en.receipt[key]}" row`, v === squash(text), v, JSON.stringify(text));
  };
  return { L, compared, valueOf, fit, amount, percent, exact };
}

/**
 * The LENDER's funding review (OfferFlow, accept mode, lender side) vs the
 * request on chain and the live fee config. Principal and the full-term
 * interest at the request's CEILING rate (the rate a lender accepting an
 * ERC-20 borrow request binds), the collateral, the yield fee, the length
 * and the new loan's grace window. The rate is not printed on its own; it
 * is bound through the interest figure here and exactly by the signed
 * AcceptTerms.
 *
 * ctx: { en, req: { amount, interestRateBpsMax, durationDays,
 *   collateralAmount }, principal: { decimals, symbol }, collateral:
 *   { decimals, symbol }, treasuryFeeBps, graceSeconds }
 */
export function compareLenderReceipt(rows, ctx) {
  const { en, req } = ctx;
  const c = comparer(rows, en);
  const R = en.offerFlow.receipts;
  const P = ctx.principal;
  const interest = (req.amount * req.interestRateBpsMax * req.durationDays) / (10_000n * 365n);
  const g1 = c.fit('youReceive', R.lenderYouReceive, { prefix: true });
  if (g1) {
    c.amount('interest (full term at the ceiling rate)', g1.interest, interest, P.decimals, P.symbol);
    c.amount('principal returned', g1.principal, req.amount, P.decimals, P.symbol);
  }
  const g2 = c.fit('youLock', R.lenderYouLockAccept);
  if (g2) c.amount('principal lent', g2.principal, req.amount, P.decimals, P.symbol);
  c.exact('youMayOwe', en.offerFlow.receiptOweNothing);
  const g3 = c.fit('youCanLose', `${en.lend.defaultOutcome} ${R.lenderCollateralLock}`, { prefix: true });
  if (g3) c.amount('collateral', g3.collateral, req.collateralAmount, ctx.collateral.decimals, ctx.collateral.symbol);
  const g4 = c.fit('fees', en.fees.lenderYieldFee);
  if (g4) c.percent('yield fee (treasuryFeeBps)', g4.pct, ctx.treasuryFeeBps);
  const g5 = c.fit('whenThisEnds', R.lenderWhenEndsAccept);
  if (g5) {
    c.compared.push('loan length', 'grace window');
    const days = parseDurationDays(g5.duration, en.units);
    c.L.want('loan length', days !== null && BigInt(days) === BigInt(req.durationDays), g5.duration, `${req.durationDays} days`);
    const graceLabel = formatGraceSeconds(BigInt(ctx.graceSeconds));
    c.L.want('grace window', squash(g5.grace) === graceLabel, g5.grace, `"${graceLabel}" (formatGraceSeconds of ${ctx.graceSeconds}s)`);
  }
  return { mismatches: c.L.mismatches(), compared: c.compared };
}

/**
 * The BORROWER's refinance review (RefinanceFlow's ConfirmReceipt) vs the
 * figures the drive computes from the chain with the app's own formulas:
 * today's payoff, the late-fee headroom when the approval bound exceeds it,
 * the wallet top-up (payoff interest + the new loan's LIF), the LIF and
 * treasury rates, and the request's lifetime branch (30 days after posting,
 * or clamped to the loan's grace end — then dated). The typed rate ceiling
 * and length are not printed in this receipt; the createOffer expected
 * object binds them exactly instead.
 *
 * ctx: { en, principal: { decimals, symbol }, payoffNow, headroom, topUp,
 *   lifBps, treasuryFeeBps, clamped, graceEndDates: string[],
 *   requestWindowDays }
 */
export function compareBorrowerReceipt(rows, ctx) {
  const { en } = ctx;
  const c = comparer(rows, en);
  const Rf = en.refinance;
  const P = ctx.principal;
  c.exact('youReceive', Rf.receiptReceive);
  c.exact('youLock', Rf.receiptLock);
  const g1 = c.fit('youMayOwe', Rf.receiptYouMayOwe, { prefix: true });
  if (g1) c.amount('payoff (today)', g1.payoff, ctx.payoffNow, P.decimals, P.symbol);
  const owe = c.valueOf('youMayOwe') ?? '';
  const late = matchTemplate(Rf.lateFeeDisclosure, owe, { anywhere: true });
  if (ctx.headroom > 0n) {
    if (!late) c.L.want('late-fee headroom disclosure', false, owe, 'present (the approval covers a later, larger payoff)');
    else c.amount('late-fee headroom', late.maxGrowth, ctx.headroom, P.decimals, P.symbol);
  } else {
    c.compared.push('no late-fee headroom disclosure');
    c.L.want('late-fee headroom disclosure', late === null, owe, 'absent (no headroom)');
  }
  const wallet = matchTemplate(Rf.walletNote, owe, { anywhere: true });
  if (!wallet) c.L.want('wallet top-up note', false, owe, 'present');
  else c.amount('wallet top-up (payoff interest + LIF)', wallet.topUp, ctx.topUp, P.decimals, P.symbol);
  const g2 = c.fit('fees', en.fees.borrowerLIF, { prefix: true });
  if (g2) c.percent('loan initiation fee (live LIF)', g2.pct, ctx.lifBps);
  const tre = matchTemplate(Rf.feesTreasuryNote, c.valueOf('fees') ?? '', { anywhere: true });
  if (!tre) c.L.want('treasury-cut note', false, c.valueOf('fees'), 'present');
  else c.percent('treasury cut (treasuryFeeBps)', tre.cut, ctx.treasuryFeeBps);
  const g3 = c.fit('whenThisEnds', Rf.whenEndsComposed, { prefix: true });
  if (g3) {
    c.compared.push('request lifetime');
    if (ctx.clamped) {
      const d = matchTemplate(Rf.expiresAtGraceEnd, g3.branch);
      c.L.want(
        'request lifetime (clamped to the grace end)',
        d !== null && ctx.graceEndDates.includes(d.date),
        g3.branch,
        `the grace-end branch dated ${ctx.graceEndDates[0]}`,
      );
    } else {
      const d = matchTemplate(Rf.expiresAfterDays, g3.branch);
      c.L.want('request lifetime', d !== null && Number(d.days) === Number(ctx.requestWindowDays), g3.branch, `${ctx.requestWindowDays} days after posting`);
    }
  }
  return { mismatches: c.L.mismatches(), compared: c.compared };
}

