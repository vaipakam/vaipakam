/**
 * What the deployed `/analytics` page must show for the bodies the deployed
 * indexer served it — the live-only half of the recycling account and loop
 * closure (COVERAGE.md, "Recycling account + loop closure, deployed-capture
 * half"; #1349 M5, #1956).
 *
 * Pure: the driver (`live-analytics-recycling.mjs`) hands in the two JSON
 * bodies THE PAGE ITSELF received, a snapshot of the page's `data-testid`
 * elements, the English copy and the bundle's Diamond. Comparing against the
 * bodies the page fetched — not a second fetch by the driver — means a
 * capture landing between two reads cannot produce a false FAIL: the page
 * and the oracle describe the same reading by construction.
 *
 * What this asserts is the WIRING between the deployed indexer and the
 * deployed app: that the page states the indexer's own verdict, relation,
 * reading moment, contract and day series, and nothing of its own. The
 * page's formatting rules (four decimals, below-precision labels, rounding
 * direction) are the CI-Anvil spec's job (`tests/analytics-recycling.spec.ts`)
 * and are not re-derived here; where a cell carries an amount, only the
 * part of its sentence that does not depend on formatting is compared, and
 * the check's detail says so.
 *
 * @typedef {{ text: string, verdict?: string|null, status?: string|null }} Node
 * @typedef {Record<string, Node>} Snapshot  testid → node (absent = not rendered)
 * @typedef {{ name: string, ok: boolean, detail: string }} Check
 */

/** Collapse whitespace the way a reader sees it. */
export const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Fill an en.json `{{name}}` template. */
export function fill(template, vars) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`template variable ${k} not supplied`);
    return String(vars[k]);
  });
}

/**
 * The verdict cell's posture and English sentence for a backing body,
 * following the rule the page states (RecyclingAccount `verdictContent`):
 * the indexer's `backed` answer, never one the page works out itself.
 *
 * `prefix: true` marks a sentence whose tail carries a formatted amount; only
 * the part before it is compared.
 */
export function expectedBacked(backed, c) {
  if (backed === null || backed === undefined) {
    return { posture: 'undetermined', text: c.backedNotServed, prefix: false };
  }
  if (!backed.determinable) {
    const text =
      backed.reason === 'custody-state-unknown'
        ? c.backedCustodyUnknown
        : backed.reason === 'holder-balance-unknown'
          ? c.backedHolderBalanceUnknown
          : c.backedSubtrahendUnknown;
    return { posture: 'undetermined', text, prefix: false };
  }
  if (backed.relation === 'diamond') {
    return backed.ok
      ? { posture: 'yes', text: c.backedYesDiamond, prefix: false }
      : { posture: 'short', text: c.backedShortDiamond.split('{{amount}}')[0], prefix: true };
  }
  return backed.ok
    ? { posture: 'yes', text: c.backedYesHolder, prefix: false }
    : { posture: 'short', text: c.backedNo, prefix: true };
}

/**
 * Every check, in reading order.
 *
 * @param {{ rec: any, loop: any, snap: Snapshot, copy: any, diamond: string|null, chainId: number }} input
 * @returns {Check[]}
 */
export function reviewAnalytics({ rec, loop, snap, copy, diamond, chainId }) {
  const c = copy.recycling;
  const lc = copy.loopClosure;
  /** @type {Check[]} */
  const out = [];
  const check = (name, ok, detail = '') => out.push({ name, ok: Boolean(ok), detail });
  const has = (id) => Object.prototype.hasOwnProperty.call(snap, id);
  const text = (id) => (has(id) ? norm(snap[id].text) : null);

  // ── the bodies themselves ───────────────────────────────────────────────
  check(
    'the recycling body is for the chain the page asked about',
    rec.chainId === chainId,
    `asked ${chainId}, body ${rec.chainId}`,
  );
  check(
    'the loop-closure body is for the chain the page asked about',
    loop.chainId === chainId,
    `asked ${chainId}, body ${loop.chainId}`,
  );

  const b = rec.backing ?? {};
  // COVERAGE: a non-null value names a migration the deploy did not apply,
  // and is why a verdict would stay "not determinable".
  check(
    'the indexer has applied every schema update its reading needs (backing.pendingMigration is null)',
    b.pendingMigration === null,
    `pendingMigration = ${JSON.stringify(b.pendingMigration)}`,
  );

  // ── the backing block ───────────────────────────────────────────────────
  if (b.unavailableReason !== null && b.unavailableReason !== undefined) {
    check(
      'a withheld reading is withheld whole, with a reason',
      has('recycling-backing-unavailable') && !has('recycling-backed') && !has('recycling-asof'),
      `indexer reason ${b.unavailableReason}; page: ${text('recycling-backing-unavailable') ?? 'no withheld notice'}`,
    );
  } else {
    check(
      'the indexer read the Diamond this deployment ships',
      typeof diamond === 'string' &&
        typeof b.diamond === 'string' &&
        b.diamond.toLowerCase() === diamond.toLowerCase(),
      `bundle ${diamond}, reading ${b.diamond}`,
    );

    const want = expectedBacked(b.backed, c);
    const got = text('recycling-backed');
    const verdict = has('recycling-backed') ? snap['recycling-backed'].verdict ?? null : null;
    check(
      "the verdict cell states the indexer's own posture",
      verdict === want.posture,
      `indexer ${JSON.stringify(b.backed)} → ${want.posture}; page data-verdict ${verdict}`,
    );
    check(
      "the verdict cell states the indexer's own answer",
      got !== null && (want.prefix ? got.startsWith(norm(want.text)) : got === norm(want.text)),
      `expected ${want.prefix ? 'to start with ' : ''}"${norm(want.text)}"${want.prefix ? ' (the amount is formatting, checked on CI-Anvil)' : ''}; page "${got}"`,
    );
    if (b.backed && b.backed.determinable && !b.backed.ok && b.backed.relation === 'holder') {
      check(
        'each failing leg the indexer names is listed, and no other',
        has('recycling-short-holder') === (b.backed.holderShortfall !== null) &&
          has('recycling-short-diamond') === (b.backed.diamondShortfall !== null),
        `holderShortfall ${b.backed.holderShortfall}, diamondShortfall ${b.backed.diamondShortfall}`,
      );
    }

    const relation = b.backed && b.backed.determinable ? b.backed.relation : null;
    if (relation !== null && relation !== undefined) {
      const wantCmp = relation === 'holder' ? c.comparisonHolder : c.comparisonDiamond;
      check(
        "the comparison named is the indexer's relation",
        text('recycling-comparison') === norm(wantCmp),
        `relation ${relation}; page "${text('recycling-comparison')}"`,
      );
    }

    const wantCustody =
      b.custodyActivated === null
        ? b.pendingMigration !== null
          ? fill(c.custodyPendingMigration, { migration: b.pendingMigration })
          : c.custodyUnknown
        : b.custodyActivated
          ? c.custodyHolder
          : c.custodyDiamond;
    check(
      "the custody line is the reading's own",
      text('recycling-custody') === norm(wantCustody),
      `custodyActivated ${b.custodyActivated}; page "${text('recycling-custody')}"`,
    );

    const wantAsOf = fill(c.asOfValue, { block: b.blockNumber, at: b.asOf, contract: b.diamond });
    check(
      "the reading's moment and contract are stated as the indexer published them",
      text('recycling-asof') === norm(wantAsOf),
      `expected "${norm(wantAsOf)}"; page "${text('recycling-asof')}"`,
    );
  }

  // ── the day series ──────────────────────────────────────────────────────
  const daily = Array.isArray(rec.daily) ? rec.daily : [];
  const servedDays = daily.map((d) => d.dayId);
  const pageDays = Object.keys(snap)
    .map((id) => /^recycling-day-(\d+)$/.exec(id))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  check(
    'the day table has exactly the programme days the indexer served',
    sameSet(servedDays, pageDays),
    `served [${servedDays.join(',')}]; page [${pageDays.sort((x, y) => x - y).join(',')}]`,
  );
  const badEstimate = daily.filter((d) => has(`estimate-${d.dayId}`) !== Boolean(d.estimate));
  check(
    'a day carries the estimate badge exactly when the indexer calls it an estimate',
    badEstimate.length === 0,
    badEstimate.length ? `mismatch on days ${badEstimate.map((d) => d.dayId).join(',')}` : `${daily.length} day(s) compared`,
  );
  if (rec.fromDay !== null && rec.toDay !== null && rec.fromDay !== undefined && rec.toDay !== undefined) {
    const range =
      rec.fromDay === rec.toDay
        ? fill(c.windowSingleDay, { day: rec.fromDay })
        : fill(c.windowRange, { from: rec.fromDay, to: rec.toDay });
    check(
      'the window note states the range the indexer served',
      (text('recycling-window') ?? '').startsWith(norm(range)),
      `expected to start with "${norm(range)}"; page "${text('recycling-window')}"`,
    );
  } else {
    check('no window note describes a table that is not there', !has('recycling-window'));
  }

  // ── loop closure ────────────────────────────────────────────────────────
  const wantRecorded =
    loop.recordedBefore === null ? lc.recordedBeforeUnknown : fill(lc.recordedBefore, { at: loop.recordedBefore });
  check(
    "the loop-closure record's moment is the indexer's",
    text('loop-recorded-before') === norm(wantRecorded),
    `expected "${norm(wantRecorded)}"; page "${text('loop-recorded-before')}"`,
  );
  const loopDaily = Array.isArray(loop.daily) ? loop.daily : [];
  const loopPage = Object.keys(snap)
    .map((id) => /^loop-day-(\d+)$/.exec(id))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  check(
    'the loop-closure table has exactly the calendar days the indexer served',
    sameSet(
      loopDaily.map((d) => d.dayId),
      loopPage,
    ),
    `served ${loopDaily.length} day(s); page ${loopPage.length}`,
  );
  const badStatus = loopDaily.filter(
    (d) => !has(`loop-day-${d.dayId}`) || snap[`loop-day-${d.dayId}`].status !== d.status,
  );
  check(
    "each loop-closure day carries the indexer's status",
    badStatus.length === 0,
    badStatus.length ? `mismatch on ${badStatus.map((d) => d.date).join(', ')}` : `${loopDaily.length} day(s) compared`,
  );
  const badDate = loopDaily.filter(
    (d) => !(text(`loop-date-${d.dayId}`) ?? '').startsWith(String(d.date)),
  );
  check(
    "each loop-closure day is labelled with the indexer's own UTC date",
    badDate.length === 0,
    badDate.length ? `mismatch on day ids ${badDate.map((d) => d.dayId).join(',')}` : `${loopDaily.length} day(s) compared`,
  );

  return out;
}

function sameSet(a, b) {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && a.length === x.size && b.length === y.size && [...x].every((v) => y.has(v));
}
