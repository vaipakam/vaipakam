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
 *   - Captured values are compared with the chain: an amount is the
 *     token's own symbol plus a number that must equal the on-chain amount
 *     EXACTLY, in base units — since #2537 every receipt amount is rendered
 *     by `formatTokenAmountExact` (en-US grouping, every significant
 *     decimal), so a nearby-but-different figure is a mismatch, never a
 *     rounding allowance; a percent is
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
 * rendered on 2026-10-05 (the lender's review) and with the permit-route
 * borrower review that replaced the approval-route one (#3295).
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

/** "0.005 WETH" / "1,234.5 USDC" → { text, symbol } with `text` the number
 *  as rendered (grouping removed, never converted through a float); null if
 *  not that shape. An approximation mark (`~`) is not that shape: an exact
 *  receipt never carries one. */
export function parseAmount(s) {
  const m = /^(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d+))?\s+(\S+)$/.exec(squash(s));
  if (!m) return null;
  return { text: m[2] === undefined ? m[1].replace(/,/g, '') : `${m[1].replace(/,/g, '')}.${m[2]}`, symbol: m[3] };
}

/**
 * The displayed decimal as base units, EXACTLY: null when it carries more
 * significant decimals than the token has (it cannot be any on-chain
 * amount) or is not a plain decimal.
 */
export function exactUnits(text, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(text ?? ''));
  if (!m) return null;
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > decimals) return null;
  return BigInt(m[1] + frac.padEnd(decimals, '0'));
}

/** Does the displayed decimal equal the raw on-chain amount exactly? */
export function amountMatches(displayedText, raw, decimals) {
  const units = exactUnits(displayedText, decimals);
  return units !== null && units === BigInt(raw);
}

/**
 * A BRACKET for a figure the page computed at a moment the drive cannot see
 * (#3302): `{ lo, hi }` in base units, the figure evaluated at a moment known
 * to be no later than the page's and at one known to be no earlier. A plain
 * bigint is the degenerate bracket `{ lo: v, hi: v }` — an exact figure.
 * The ends are ordered here, so a caller passes the two evaluations as read.
 * There is no tolerance in it: the ends ARE the figure, at two real moments.
 */
export function bracketOf(v, w = v) {
  if (v && typeof v === 'object') return bracketOf(v.lo, v.hi);
  const a = BigInt(v);
  const b = BigInt(w);
  return a <= b ? { lo: a, hi: b } : { lo: b, hi: a };
}

/** Does the displayed decimal, in base units, lie inside `bracket`? */
export function amountWithin(displayedText, bracket, decimals) {
  const units = exactUnits(displayedText, decimals);
  const { lo, hi } = bracketOf(bracket);
  return units !== null && units >= lo && units <= hi;
}

/** The raw amount as the exact decimal it should render as (for reports). */
function exactText(raw, decimals) {
  const s = BigInt(raw).toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
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
    const truth = `${exactText(raw, decimals)} ${symbol}`;
    L.want(label, p !== null && p.symbol === symbol && amountMatches(p.text, raw, decimals), shown, truth);
  };
  /** An amount the page computed at a moment inside a bracket (#3302). */
  const amountIn = (label, shown, bracket, decimals, symbol) => {
    compared.push(label);
    const p = parseAmount(shown ?? '');
    const { lo, hi } = bracketOf(bracket);
    const truth =
      lo === hi
        ? `${exactText(lo, decimals)} ${symbol}`
        : `between ${exactText(lo, decimals)} and ${exactText(hi, decimals)} ${symbol} (the figure at the moments bracketing the page's read)`;
    L.want(label, p !== null && p.symbol === symbol && amountWithin(p.text, { lo, hi }, decimals), shown, truth);
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
  return { L, compared, valueOf, fit, amount, amountIn, percent, exact };
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
 *   collateralAmount, refinanceTargetLoanId?, refinanceCarryOver? }, principal: { decimals, symbol }, collateral:
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
  // #2421 — a refinance request's collateral is described from its recorded
  // carry-over decision and names the loan it refinances; only an untagged
  // request reads as a fresh "They lock".
  const refinanced = (req.refinanceTargetLoanId ?? 0n) > 0n;
  const lockLine = !refinanced
    ? R.lenderCollateralLock
    : req.refinanceCarryOver
      ? R.lenderCollateralCarriedOver
      : R.lenderCollateralFreshPledge;
  const g3 = c.fit('youCanLose', `${en.lend.defaultOutcome} ${lockLine}`, { prefix: true });
  if (g3) {
    c.amount('collateral', g3.collateral, req.collateralAmount, ctx.collateral.decimals, ctx.collateral.symbol);
    if (refinanced) {
      c.compared.push('refinanced loan');
      c.L.want('refinanced loan', g3.loanId === String(req.refinanceTargetLoanId), g3.loanId, `#${req.refinanceTargetLoanId}`);
    }
  }
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
 * The BORROWER's refinance review (RefinanceFlow's ConfirmReceipt) on the
 * PAYOFF-PERMIT route (#1558 / #3042, #3295) vs the contract's own figures
 * (`getRefinancePayoff` for the request's last fillable moment — what the
 * app reads):
 *   - today's payoff;
 *   - the payoff's growth before that moment (`copy.refinance.permit
 *     .growthDisclosure`) — present exactly when it can grow, with the
 *     growth figure;
 *   - the permit disclosure (`permit.signDisclosure`, signed "for at most"
 *     the wallet's share at that moment, ending "nothing stays approved to
 *     the protocol") and the Permit2 approval note — present exactly when
 *     the share can be above zero (`permitNeeded`), with the share figure;
 *   - the wallet top-up (the share today: payoff interest + the new loan's
 *     LIF);
 *   - the LIF and treasury rates, and the request's lifetime branch (30
 *     days after posting, or clamped to the loan's grace end — then dated);
 *   - the card's wallet-steps note (`permit.multiStepNote`: "up to five
 *     wallet steps … the Permit2 approval if needed, the request, your
 *     signature on the payoff permit, and the transaction that attaches
 *     it"), which sits below the receipt rather than in a row, so it is read
 *     from the card's whole text.
 * The RETIRED approval-route wording — "The approval you grant covers that
 * too" (`refinance.lateFeeDisclosure`) and the three-confirmation note
 * (`refinance.multiStepNote`) — is a mismatch wherever it appears: it
 * describes an approval of the Diamond this route never makes.
 * The typed rate ceiling and length are not printed in this receipt; the
 * createOffer expected object binds them exactly instead.
 *
 * THE FOUR AMOUNTS ARE BRACKETS (#3302). The page computes them from the
 * chain time of its own last loan poll and a view read at its own block —
 * a moment the drive cannot observe — so `payoffNow`, `headroom`, `topUp`
 * and `bound` are each `{ lo, hi }` (`bracketOf`; a bigint is exact): the
 * figure evaluated at a block the drive read BEFORE the page loaded and at
 * one it read AFTER reading the rows. A disclosure that may be absent (the
 * growth, the permit) is required when `lo > 0`, refused when `hi = 0`, and
 * when the bracket straddles zero the page's choice is accepted and any
 * figure it shows must still lie inside the bracket.
 *
 * ctx: { en, principal: { decimals, symbol }, payoffNow, headroom, topUp,
 *   bound, lifBps, treasuryFeeBps, clamped, graceEndDates: string[],
 *   requestWindowDays, cardText }
 */
export function compareBorrowerReceipt(rows, ctx) {
  const { en } = ctx;
  const c = comparer(rows, en);
  const Rf = en.refinance;
  const Pm = Rf.permit;
  const P = ctx.principal;
  c.exact('youReceive', Rf.receiptReceive);
  c.exact('youLock', Rf.receiptLock);
  const headroom = bracketOf(ctx.headroom);
  const bound = bracketOf(ctx.bound);
  const g1 = c.fit('youMayOwe', Rf.receiptYouMayOwe, { prefix: true });
  if (g1) c.amountIn('payoff (today)', g1.payoff, ctx.payoffNow, P.decimals, P.symbol);
  const owe = c.valueOf('youMayOwe') ?? '';
  const growth = matchTemplate(Pm.growthDisclosure, owe, { anywhere: true });
  if (growth && headroom.hi === 0n) {
    c.compared.push('no payoff-growth disclosure');
    c.L.want('payoff-growth disclosure', false, owe, 'absent (the payoff cannot grow)');
  } else if (growth) {
    c.amountIn('payoff growth before the last fillable moment', growth.maxGrowth, headroom, P.decimals, P.symbol);
  } else if (headroom.lo > 0n) {
    c.L.want('payoff-growth disclosure', false, owe, 'present (the permit covers a later, larger payoff)');
  } else {
    c.compared.push('no payoff-growth disclosure');
  }
  // The retired approval-route sentence must not be what the borrower reads.
  c.compared.push('no approval-route disclosure');
  c.L.want(
    'approval-route disclosure ("The approval you grant covers that too")',
    matchTemplate(Rf.lateFeeDisclosure, owe, { anywhere: true }) === null,
    owe,
    'absent — this route approves nothing to the protocol',
  );
  const sign = matchTemplate(Pm.signDisclosure, owe, { anywhere: true });
  const p2 = owe.includes(squash(Pm.permit2ApprovalNote));
  if (bound.hi === 0n && (sign || p2)) {
    c.compared.push('no payoff-permit disclosure');
    c.L.want('payoff-permit disclosure', false, owe, 'absent (the wallet share is zero, so no permit is signed)');
  } else if (sign) {
    c.amountIn('payoff permit maximum (wallet share at the last fillable moment)', sign.amount, bound, P.decimals, P.symbol);
    c.compared.push('Permit2 approval note');
    c.L.want('Permit2 approval note', p2, owe, 'present');
  } else if (bound.lo > 0n) {
    c.L.want('payoff-permit disclosure', false, owe, 'present (a permit is signed for the wallet share)');
  } else {
    c.compared.push('no payoff-permit disclosure');
    c.L.want('payoff-permit disclosure', !p2, owe, 'absent (the wallet share is zero, so no permit is signed)');
  }
  const wallet = matchTemplate(Rf.walletNote, owe, { anywhere: true });
  if (!wallet) c.L.want('wallet top-up note', false, owe, 'present');
  else c.amountIn('wallet top-up (payoff interest + LIF)', wallet.topUp, ctx.topUp, P.decimals, P.symbol);
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
  // The wallet-steps note under the receipt: the permit route's, never the
  // retired three-confirmation one.
  c.compared.push('wallet-steps note');
  const card = squash(ctx.cardText ?? '');
  c.L.want(
    'wallet-steps note (copy.refinance.permit.multiStepNote)',
    card.includes(squash(Pm.multiStepNote)) && !card.includes(squash(Rf.multiStepNote)),
    card.slice(0, 200),
    JSON.stringify(Pm.multiStepNote),
  );
  return { mismatches: c.L.mismatches(), compared: c.compared };
}
