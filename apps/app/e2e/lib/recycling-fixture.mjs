// Deterministic fixtures for the two recycling-transparency reads the
// analytics page makes (#1218 / #1349 M5):
//
//   GET /metrics/recycling?chainId=&days=     (apps/indexer/src/recycleRoutes.ts)
//   GET /metrics/loop-closure?chainId=&days=  (apps/indexer/src/rewardRoutes.ts)
//
// WHY FIXTURES AND NOT THE CHAIN. Every other route in the stub is hydrated
// live from the e2e chain, because the facts it serves (offers, loans) are
// created by the specs themselves. These two are not: the production
// figures come from a cron-captured D1 history (day stamps, a scheduled
// backing reading) that a freshly deployed chain has none of — an unarmed,
// day-0 Diamond would serve an empty series and the page would only ever be
// exercised on its empty posture. The page's JOB is the non-empty postures
// (armed vs unarmed days, a below-precision amount, the custody-dependent
// backing verdict, a withheld reading), so the stub serves a fixed history
// in the indexer's exact wire shape. The capture itself (cron + D1) is the
// Live-only half — see apps/app/e2e/COVERAGE.md.
//
// SHAPE FIDELITY. Field names, nullability and the refusal rules follow the
// route handlers line for line: unstamped days carry null pool figures and
// a null global `absorbed`; unarmed days are `estimate` with null
// `netEmission`; cumulatives sum only stamped days (and only ARMED stamped
// days for the emission/budget totals); `selfFundingRatio` is the 6-dp
// floor the indexer's ratio6 computes. The cumulative block is COMPUTED
// here from the day rows with those same rules, so the fixture cannot
// publish a lifetime total its own days contradict.
//
// THE BACKING VERDICT IS NOT RE-DERIVED HERE. Each variant states the
// verdict the shared `recycleBackingVerdict` (packages/contracts/src/
// recycleBacking.ts) returns for its operands, as a literal. Plain .mjs
// cannot import that TypeScript module on CI's Node, so instead the spec
// (`tests/analytics-recycling.spec.ts`, which Playwright transpiles) fetches
// every variant from the running stub and asserts the literal EQUALS the
// shared function's output — a fixture that drifts from the relation fails
// there, naming the variant.
//
// VARIANT SWITCH. `?recyclingFixture=<name>` selects a backing variant on
// /metrics/recycling. The stub serves exactly one chain, so a second
// chainId is not available as a switch; a query parameter the production
// route ignores is. Specs add it with `page.route` (see the spec).

const E18 = 10n ** 18n;
const vpfi = (whole) => (BigInt(whole) * E18).toString();

/** 6-dp floor ratio — the indexer's `ratio6`, verbatim. */
function ratio6(num, den) {
  if (den === 0n) return null;
  return Number((num * 1_000_000n) / den) / 1_000_000;
}

/** Same clamp as both route handlers' parseDays. */
export function parseDays(raw, max) {
  if (!raw) return 30;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(n, max);
}

/**
 * The stored day history, as the merged view the handler builds would hold
 * it. Programme day indices — never calendar dates (the route publishes
 * none and the surface must not invent them).
 *
 *   day 3 — finalized + armed: an ordinary committed day.
 *   day 4 — finalized, UNARMED: an estimate; no net emission.
 *   day 5 — finalized + armed, whose mirror absorption is 1000 wei: a
 *           POSITIVE amount far below any display precision, which must
 *           render as below precision and never as zero.
 *   day 6 — finalized + armed, fresh floor of 1 wei against a large
 *           recycled budget: the self-funded share is 0.999999, which must
 *           NOT display as fully self-funded (a share rounds down).
 *   day 7 — not finalized (the day in progress): no pool, own absorption
 *           live, no global sum.
 */
const DAY_ROWS = [
  {
    day_id: 3, stamped: 1, armed: 1, origin: 'event',
    schedule_floor: vpfi(1000), recycled_budget: vpfi(250), a_bar: vpfi(240),
    margin_bps: 1000, fresh_drawdown: vpfi(900),
    absorbed_local: vpfi(200), absorbed_mirror: vpfi(50),
  },
  {
    day_id: 4, stamped: 1, armed: 0, origin: 'event',
    schedule_floor: vpfi(1000), recycled_budget: vpfi(300), a_bar: vpfi(260),
    margin_bps: 1000, fresh_drawdown: vpfi(950),
    absorbed_local: vpfi(180), absorbed_mirror: vpfi(40),
  },
  {
    day_id: 5, stamped: 1, armed: 1, origin: 'event',
    schedule_floor: vpfi(1000), recycled_budget: vpfi(320), a_bar: vpfi(280),
    margin_bps: 1000, fresh_drawdown: vpfi(980),
    absorbed_local: vpfi(300), absorbed_mirror: '1000',
  },
  {
    day_id: 6, stamped: 1, armed: 1, origin: 'event',
    schedule_floor: '1', recycled_budget: vpfi(1_000_000), a_bar: vpfi(900_000),
    margin_bps: 1000, fresh_drawdown: '1',
    absorbed_local: vpfi(400), absorbed_mirror: vpfi(60),
  },
  {
    day_id: 7, stamped: 0, armed: 0, origin: 'event',
    schedule_floor: '0', recycled_budget: '0', a_bar: '0', margin_bps: 0,
    fresh_drawdown: '0', absorbed_local: vpfi(10), absorbed_mirror: '0',
  },
];

/** Absorption credited before the schedule started — no day carries it. */
const PRE_LAUNCH = vpfi(5);

/**
 * The backing variants. Operands are the reading; `backed` is the verdict
 * the shared function returns for them (checked by the spec, see header).
 *
 * The amounts are chosen so each variant is unambiguous at display
 * precision: the default holder variant clears BOTH legs by whole tokens,
 * the holder-short variant misses the holder leg by exactly 25 VPFI, and
 * the diamond-short variant misses the pre-activation relation by exactly
 * 35 VPFI — a figure equal to none of its operands, so the shortfall the
 * page states can only have come from the verdict.
 *
 * WHY THE PRE-ACTIVATION VARIANTS MATTER MOST. Every live chain is
 * pre-activation today, so the 'diamond' relation is the first one a live
 * visitor sees. Their holder fields take the shape migration 0056 stores
 * for a Diamond with no holder bound: `tryBalance` reports an unbound
 * holder as unknown (so the balance is stored NULL, never the view's
 * placeholder zero) and the attributed total is the empty row set's 0.
 */
function backingVariants(diamond, asOf) {
  const reading = {
    vpfiBalance: vpfi(800),
    bucket: vpfi(600),
    // ACTIVATED arithmetic (LibVpfiRecycle.backingPosition): the bucket and
    // the recovery position are the holder's, so this balance nets only its
    // own reservation — 800 − 40. Overridden on the pre-activation variant.
    unearmarked: vpfi(760),
    outstandingRecycled: vpfi(120),
    paidOutRecycled: vpfi(310),
    keeperBudget: '0',
    // bucket − outstandingRecycled − keeperBudget = 600 − 120 − 0; all
    // three subtrahends are in this same reading.
    platformRetained: vpfi(480),
    blockNumber: '123456',
    diamond,
    releasedRemitStranded: '0',
    strandedRecoveryReserved: vpfi(40),
    recoveryPositionReserved: vpfi(25),
    unavailableReason: null,
    asOf,
  };
  /** Pre-activation custody columns as 0056 stores them (see above). */
  const preActivation = {
    custodyActivated: false,
    holderBalanceKnown: false,
    holderBalance: null,
    holderAttributed: '0',
  };
  return {
    // Custody ACTIVATED, holder covers its rows (700 >= 625) and the
    // Diamond covers its one remaining reservation (800 >= 40).
    'holder-backed': {
      ...reading,
      custodyActivated: true,
      holderBalanceKnown: true,
      holderBalance: vpfi(700),
      holderAttributed: vpfi(625),
      backed: {
        determinable: true, relation: 'holder', ok: true,
        diamondShortfall: null, holderShortfall: null, reason: null,
      },
    },
    // Custody ACTIVATED, holder short by 25 VPFI (600 < 625).
    'holder-short': {
      ...reading,
      custodyActivated: true,
      holderBalanceKnown: true,
      holderBalance: vpfi(600),
      holderAttributed: vpfi(625),
      backed: {
        determinable: true, relation: 'holder', ok: false,
        diamondShortfall: null, holderShortfall: vpfi(25), reason: null,
      },
    },
    // Custody ACTIVATED, but the chain reported the holder's balance
    // unreadable — not determinable, the relation still named.
    'holder-unknown': {
      ...reading,
      custodyActivated: true,
      holderBalanceKnown: false,
      holderBalance: null,
      holderAttributed: vpfi(625),
      backed: {
        determinable: false, relation: 'holder', ok: null,
        diamondShortfall: null, holderShortfall: null,
        reason: 'holder-balance-unknown',
      },
    },
    // Custody ACTIVATED, holder balance unreadable AND the Diamond-side leg
    // short: 30 < 40 stranded. The relation needs BOTH legs read (API
    // contract; TokenomicsTechSpec "Recycling transparency series"), so the
    // answer is NOT determinable with the holder reason — never "No" with
    // the Diamond leg's 10 VPFI presented as the whole shortfall. This
    // variant pins that rule: a regression to the per-leg rule renders a
    // shortfall here, and the spec asserts none appears.
    'holder-unread-diamond-short': {
      ...reading,
      vpfiBalance: vpfi(30),
      // Activated arithmetic, saturating: 30 − 40 → 0.
      unearmarked: '0',
      custodyActivated: true,
      holderBalanceKnown: false,
      holderBalance: null,
      holderAttributed: vpfi(625),
      backed: {
        determinable: false, relation: 'holder', ok: null,
        diamondShortfall: null, holderShortfall: null,
        reason: 'holder-balance-unknown',
      },
    },
    // Custody NOT activated, Diamond covers the pool plus both reservations:
    // 800 >= 600 + 40 + 25 = 665.
    'diamond-backed': {
      ...reading,
      // Pre-activation arithmetic: 800 − 600 − 40 − 25.
      unearmarked: vpfi(135),
      ...preActivation,
      backed: {
        determinable: true, relation: 'diamond', ok: true,
        diamondShortfall: null, holderShortfall: null, reason: null,
      },
    },
    // Custody NOT activated, Diamond short: 630 < 665, by 35 VPFI. The
    // retired `vpfiBalance >= bucket` check would have called this backed
    // (630 >= 600) — the case the shared relation exists to catch.
    'diamond-short': {
      ...reading,
      vpfiBalance: vpfi(630),
      // Saturating, as LibVpfiRecycle.backingPosition is: 630 − 665 → 0.
      unearmarked: '0',
      ...preActivation,
      backed: {
        determinable: true, relation: 'diamond', ok: false,
        diamondShortfall: vpfi(35), holderShortfall: null, reason: null,
      },
    },
    // A reading taken before the activation state was recorded (or via the
    // legacy view): no relation can be chosen at all.
    'custody-unknown': {
      ...reading,
      // Pre-activation arithmetic for a reading of that era:
      // 800 − 600 − 40 − 25.
      unearmarked: vpfi(135),
      custodyActivated: null,
      holderBalanceKnown: null,
      holderBalance: null,
      holderAttributed: null,
      backed: {
        determinable: false, relation: null, ok: null,
        diamondShortfall: null, holderShortfall: null,
        reason: 'custody-state-unknown',
      },
    },
    // A pre-#1930 row: it predates BOTH reservations (the handler serves
    // them null, not missing) AND migration 0056's custody columns. The
    // reservation cells must read as predating the figure, never as 0, and
    // the verdict is not determinable for want of a custody state — the
    // first gate the shared function applies, ahead of any subtrahend.
    'older-reading': {
      ...reading,
      // That era's view subtracted only the bucket: 800 − 600.
      unearmarked: vpfi(200),
      strandedRecoveryReserved: null,
      recoveryPositionReserved: null,
      custodyActivated: null,
      holderBalanceKnown: null,
      holderBalance: null,
      holderAttributed: null,
      backed: {
        determinable: false, relation: null, ok: null,
        diamondShortfall: null, holderShortfall: null,
        reason: 'custody-state-unknown',
      },
    },
    // The whole block withheld — the route's BACKING_UNAVAILABLE shape.
    withheld: {
      vpfiBalance: null, bucket: null, unearmarked: null,
      outstandingRecycled: null, paidOutRecycled: null, keeperBudget: null,
      platformRetained: null, releasedRemitStranded: null,
      strandedRecoveryReserved: null, recoveryPositionReserved: null,
      custodyActivated: null, holderBalanceKnown: null,
      holderBalance: null, holderAttributed: null,
      backed: null, blockNumber: null, diamond: null,
      unavailableReason: 'snapshot-stale', asOf: null,
    },
  };
}

/** Every variant name `?recyclingFixture=` accepts; the first is the default. */
export const RECYCLING_FIXTURE_VARIANTS = [
  'holder-backed',
  'holder-short',
  'holder-unknown',
  'holder-unread-diamond-short',
  'diamond-backed',
  'diamond-short',
  'custody-unknown',
  'older-reading',
  'withheld',
];

/**
 * The `/metrics/recycling` body, or null for an unknown variant (the stub
 * answers that 400 — a typo in a spec must not silently serve the default).
 *
 * @param {URL} url     the request URL (`days`, `recyclingFixture`)
 * @param {number} chainId
 * @param {string} diamond  the e2e Diamond, so the reading names a real deployment
 * @param {number} nowMs    the stub host's clock, for a FRESH capture time
 */
export function recyclingBody(url, chainId, diamond, nowMs) {
  const variant = url.searchParams.get('recyclingFixture') ?? RECYCLING_FIXTURE_VARIANTS[0];
  // Five minutes old: inside any staleness bound, so the default variants
  // exercise the published-reading posture rather than a stale one.
  const asOf = new Date(nowMs - 5 * 60_000).toISOString();
  const backing = backingVariants(diamond, asOf)[variant];
  if (!backing) return null;

  const days = parseDays(url.searchParams.get('days'), 365);
  const maxDay = Math.max(...DAY_ROWS.map((r) => r.day_id));
  const coverageFromDay = Math.min(...DAY_ROWS.map((r) => r.day_id));
  const cutoff = Math.max(coverageFromDay, maxDay - days + 1);
  const byDay = new Map(DAY_ROWS.map((r) => [r.day_id, r]));

  // Lifetime folds — the handler's rules, over every stored day.
  let cumAbsorbed = 0n;
  let cumLocal = 0n;
  let cumMirror = 0n;
  let cumFresh = 0n;
  let cumBudget = 0n;
  for (const r of DAY_ROWS) {
    cumLocal += BigInt(r.absorbed_local);
    cumMirror += BigInt(r.absorbed_mirror);
    if (r.stamped !== 1) continue;
    cumAbsorbed += BigInt(r.absorbed_local) + BigInt(r.absorbed_mirror);
    if (r.armed === 1) {
      cumFresh += BigInt(r.fresh_drawdown);
      cumBudget += BigInt(r.recycled_budget);
    }
  }

  const daily = [];
  for (let dayId = cutoff; dayId <= maxDay; dayId++) {
    const r = byDay.get(dayId);
    const absorbedLocal = BigInt(r?.absorbed_local ?? '0');
    const absorbedMirror = BigInt(r?.absorbed_mirror ?? '0');
    if (r?.stamped !== 1) {
      daily.push({
        dayId, stamped: false, armed: false, estimate: false,
        origin: r?.origin ?? null,
        scheduleFloor: null, recycledBudget: null, aBar: null, marginBps: null,
        freshDrawdown: null, netEmission: null, selfFundingRatio: null,
        absorbedLocal: absorbedLocal.toString(),
        absorbedMirror: absorbedMirror.toString(),
        absorbed: null,
      });
      continue;
    }
    const armed = r.armed === 1;
    const floor = BigInt(r.schedule_floor);
    const budget = BigInt(r.recycled_budget);
    daily.push({
      dayId, stamped: true, armed, estimate: !armed, origin: r.origin,
      scheduleFloor: floor.toString(),
      recycledBudget: budget.toString(),
      aBar: r.a_bar,
      marginBps: r.margin_bps,
      freshDrawdown: r.fresh_drawdown,
      netEmission: armed ? r.fresh_drawdown : null,
      selfFundingRatio: ratio6(budget, floor + budget),
      absorbedLocal: absorbedLocal.toString(),
      absorbedMirror: absorbedMirror.toString(),
      absorbed: (absorbedLocal + absorbedMirror).toString(),
    });
  }

  return {
    chainId,
    days,
    fromDay: cutoff,
    toDay: maxDay,
    scope: 'global',
    coverageFromDay,
    daily,
    cumulative: {
      absorbed: cumAbsorbed.toString(),
      absorbedPreLaunch: PRE_LAUNCH,
      absorbedLocal: cumLocal.toString(),
      absorbedMirror: cumMirror.toString(),
      freshDrawdown: cumFresh.toString(),
      recycledBudget: cumBudget.toString(),
      // A stated figure rather than a re-derivation: the runway's numerator
      // involves cross-chain report rows this fixture does not model, and a
      // half-modelled computation would be a second, wrong definition.
      runwayExtensionDays: 12.5,
      runwayUnavailableReason: null,
      selfFunded: false,
    },
    backing,
  };
}

/**
 * The `/metrics/loop-closure` body. Days here are the route's own UTC-epoch
 * day index, anchored on the host clock exactly as the handler anchors
 * them, with a `date` field because the route serves one; the surface shows
 * it unchanged and labelled as a UTC calendar day — never converted to or
 * from programme days.
 *
 * The record is modelled as LAGGING (#1349 M5): `recordedBefore` is 06:00
 * UTC yesterday, so the route's three day states all appear —
 *
 *   today − 3 — complete, distribution with a ratio (0.75)
 *   today − 2 — complete, distribution whose absorption is 1000 wei: a
 *               positive amount below display precision (ratio 0.2)
 *   today − 1 — PARTIAL: the record stops in it. 5 VPFI paid out so far,
 *               no ratio — shown as still being recorded, never as final
 *   today     — UNRECORDED: no amounts at all — shown as not yet recorded,
 *               never as 0 or "nothing paid out"
 *   every earlier day — complete with zero distribution: ratio null, which
 *               the surface shows as not applicable, never 0
 *
 * The status rule is the route's own (`loopDayStatus` in rewardRoutes.ts),
 * restated here because this stub is plain .mjs.
 */
export function loopClosureBody(url, chainId, nowMs) {
  const days = parseDays(url.searchParams.get('days'), 90);
  const todayId = Math.floor(nowMs / 86_400_000);
  const cutoff = todayId - days + 1;
  const recordedBefore = (todayId - 1) * 86_400 + 6 * 3_600;
  const rows = new Map([
    [todayId - 3, { distributed: vpfi(100), netVaultDelivered: vpfi(60), absorbed: vpfi(15) }],
    [todayId - 2, { distributed: vpfi(50), netVaultDelivered: vpfi(10), absorbed: '1000' }],
    [todayId - 1, { distributed: vpfi(5), netVaultDelivered: vpfi(5), absorbed: '0' }],
  ]);
  const daily = [];
  for (let dayId = cutoff; dayId <= todayId; dayId++) {
    const date = new Date(dayId * 86_400_000).toISOString().slice(0, 10);
    const start = dayId * 86_400;
    const status =
      start >= recordedBefore
        ? 'unrecorded'
        : dayId >= todayId || start + 86_400 > recordedBefore
          ? 'partial'
          : 'complete';
    if (status === 'unrecorded') {
      daily.push({
        dayId,
        date,
        status,
        distributed: null,
        netVaultDelivered: null,
        absorbed: null,
        ratio: null,
      });
      continue;
    }
    const d = rows.get(dayId) ?? { distributed: '0', netVaultDelivered: '0', absorbed: '0' };
    daily.push({
      dayId,
      date,
      status,
      distributed: d.distributed,
      netVaultDelivered: d.netVaultDelivered,
      absorbed: d.absorbed,
      ratio:
        status === 'complete'
          ? ratio6(BigInt(d.netVaultDelivered) + BigInt(d.absorbed), BigInt(d.distributed))
          : null,
    });
  }
  // Lifetime totals include the partial day's 5 VPFI: they run to the
  // ingest cursor, not to the day boundary.
  const cumDistributed = BigInt(vpfi(155));
  const cumAbsorbed = BigInt(vpfi(15));
  const retainedStock = BigInt(vpfi(65));
  return {
    chainId,
    days,
    recordedBefore: new Date(recordedBefore * 1000).toISOString(),
    daily,
    cumulative: {
      cumDistributed: cumDistributed.toString(),
      cumAbsorbed: cumAbsorbed.toString(),
      retainedStock: retainedStock.toString(),
      ratio: ratio6(retainedStock + cumAbsorbed, cumDistributed),
    },
  };
}
