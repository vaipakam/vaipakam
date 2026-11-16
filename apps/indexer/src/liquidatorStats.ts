/**
 * #3366 — distinct liquidators per chain over rolling 7- and 30-day windows.
 *
 * This is the trigger metric for #3355: the bonus auction is built once at
 * least five independent liquidators are active on a chain over 30 days. The
 * protocol's own keeper is counted apart from third parties, because a
 * liquidation market made only of the protocol keeper is the condition the
 * auction is meant to wait out.
 *
 * Everything is read from `activity_events`, which keeps every decoded
 * Diamond log with its args. Each route reports its caller the way its event
 * names it, and this module says which field it read:
 *
 *   - PRIMARY routes, the ones #3355's threshold counts:
 *       `HFLiquidationTriggered.liquidator` (the single-swap and the split
 *       HF routes emit the same event, so they are one row here),
 *       `LoanPartiallyLiquidated.liquidator`, `LiquidationDiscounted.liquidator`.
 *   - OTHER routes, reported separately rather than dropped:
 *       `InternalMatchExecuted.matcher`, `PeriodicInterestAutoLiquidated.settler`,
 *       and the time-based default's sale, `ForcedSaleSettled.keeper` on the
 *       rows whose `kind` is `TimeBasedDefault` (#3367). The other kinds of
 *       that event repeat a sale another route above already names, so they
 *       are filtered out rather than counted twice.
 *   - A time-based default that sells nothing (the in-kind transfer of
 *       illiquid collateral, or the fallback entered when the collateral is
 *       unpriced or every swap failed) pays its caller no bonus and is not a
 *       liquidator's sale, so it is not counted here. The response says so.
 *
 * What a figure here does NOT say, and the response says so too:
 *   - A distinct ADDRESS is not an independent OPERATOR: one party can run
 *     several wallets. The count is a lower bar for #3355, not proof.
 *   - A liquidation through a flash-loan receiver contract names that
 *     contract, so each deployment counts once, whoever operates it.
 *   - The keeper is identified by the chain's published `keeperAddress`
 *     deployment key. Where none is published the keeper cannot be told
 *     apart, and the response states that instead of counting it as a third
 *     party silently.
 */

/** The routes counted toward #3355's threshold, keyed by event name. */
export const PRIMARY_LIQUIDATION_ROUTES = {
  HFLiquidationTriggered: { route: 'hf', field: 'liquidator' },
  LoanPartiallyLiquidated: { route: 'partial', field: 'liquidator' },
  LiquidationDiscounted: { route: 'discounted', field: 'liquidator' },
} as const;

/**
 * `ForcedSaleFacet.ForcedSaleKind.TimeBasedDefault`. The enum is append-only,
 * so the value is fixed.
 */
export const FORCED_SALE_KIND_TIME_BASED_DEFAULT = 3;

/** Routes that name their caller but are outside the request's list. */
export const OTHER_LIQUIDATION_ROUTES = {
  InternalMatchExecuted: { route: 'internalMatch', field: 'matcher' },
  PeriodicInterestAutoLiquidated: { route: 'periodicAutoLiquidation', field: 'settler' },
  ForcedSaleSettled: {
    route: 'timeBasedDefault',
    field: 'keeper',
    onlyKind: FORCED_SALE_KIND_TIME_BASED_DEFAULT,
  },
} as const;

export const LIQUIDATOR_WINDOWS = { '7d': 7 * 86_400, '30d': 30 * 86_400 } as const;

/**
 * One route: the event field that names its caller, and, for an event that
 * several routes share, the `kind` arg value this route's rows carry.
 */
type RouteSpec = { route: string; field: string; onlyKind?: number };
const NAMED: Record<string, RouteSpec> = {
  ...PRIMARY_LIQUIDATION_ROUTES,
  ...OTHER_LIQUIDATION_ROUTES,
};

/** One `(kind, caller)` group from the window query. */
export interface LiquidatorRow {
  kind: string;
  /** Lower-cased caller, or null when the row's field is missing. */
  who: string | null;
  /** Events in the 7-day window. */
  n7: number;
  /** Events in the 30-day window (a superset of the 7-day one). */
  n30: number;
}

/**
 * The window query. Grouped in SQL so the scan returns one row per caller
 * per route, never one per event. `json_extract` reads the field each route
 * names; a route outside the list contributes nothing.
 */
export function liquidatorWindowSql(): string {
  const entries = Object.entries(NAMED);
  const whoCase = entries
    .map(([kind, s]) => `WHEN '${kind}' THEN LOWER(json_extract(args_json, '$.${s.field}'))`)
    .join(' ');
  // One predicate per event: its name, plus its `kind` arg where the event
  // is shared by several routes.
  const admit = entries
    .map(([kind, s]) =>
      s.onlyKind === undefined
        ? `kind = '${kind}'`
        : `(kind = '${kind}' AND CAST(json_extract(args_json, '$.kind') AS INTEGER) = ${s.onlyKind})`,
    )
    .join(' OR ');
  return `SELECT kind,
       CASE kind ${whoCase} ELSE NULL END AS who,
       SUM(CASE WHEN block_at >= ? THEN 1 ELSE 0 END) AS n7,
       COUNT(*) AS n30
     FROM activity_events
     WHERE chain_id = ? AND block_at >= ?
       AND (${admit})
     GROUP BY kind, who`;
}

/** The binds for {@link liquidatorWindowSql}, from one `now`. */
export function liquidatorWindowBinds(chainId: number, nowSec: number): [number, number, number] {
  return [nowSec - LIQUIDATOR_WINDOWS['7d'], chainId, nowSec - LIQUIDATOR_WINDOWS['30d']];
}

interface WindowCounts {
  /** Distinct third-party callers across the group's routes. */
  thirdParty: number;
  /** 1 when the published keeper acted in the window, else 0; null when no keeper is published. */
  keeper: 0 | 1 | null;
  /** Liquidation events, all callers. */
  events: number;
  /** Per route: distinct third-party callers and events. */
  byRoute: Record<string, { thirdParty: number; keeper: 0 | 1 | null; events: number }>;
}

export interface LiquidatorStats {
  /** The window end, unix seconds. The windows are `[end - 7d, end]` and `[end - 30d, end]`. */
  asOf: number;
  /** The keeper address the split was made against, or null when the chain publishes none. */
  keeperAddress: string | null;
  windows: Record<keyof typeof LIQUIDATOR_WINDOWS, {
    /** The routes #3355's threshold counts: HF (single and split), partial, discounted. */
    primary: WindowCounts;
    /** Internal match, periodic auto-liquidation and the time-based default's sale, reported apart. */
    otherRoutes: WindowCounts;
  }>;
  /** What the figures do not establish. Fixed text, so a reader of the JSON sees it. */
  caveats: string[];
}

export const LIQUIDATOR_CAVEATS = [
  'Counts distinct addresses, not independent operators: one party can run several wallets.',
  'A liquidation through a flash-loan receiver contract names that contract, so each deployment counts once.',
  'A time-based default that sells nothing (an in-kind transfer, or a fallback entered because the collateral is unpriced or every swap failed) pays its caller no bonus and is not counted.',
  'Windows are measured against the indexer clock; see `indexer.updatedAt` for how current the ingest is.',
];

function emptyCounts(keeperKnown: boolean): WindowCounts {
  return { thirdParty: 0, keeper: keeperKnown ? 0 : null, events: 0, byRoute: {} };
}

function tally(
  rows: LiquidatorRow[],
  routes: Record<string, RouteSpec>,
  keeper: string | null,
  pick: (r: LiquidatorRow) => number,
): WindowCounts {
  const out = emptyCounts(keeper !== null);
  const all = new Set<string>();
  const perRoute = new Map<string, Set<string>>();
  for (const r of rows) {
    const spec = routes[r.kind];
    const n = pick(r);
    if (!spec || n <= 0) continue;
    const route = (out.byRoute[spec.route] ??= {
      thirdParty: 0,
      keeper: keeper !== null ? 0 : null,
      events: 0,
    });
    route.events += n;
    out.events += n;
    if (!r.who) continue;
    if (keeper !== null && r.who === keeper) {
      route.keeper = 1;
      out.keeper = 1;
      continue;
    }
    all.add(r.who);
    let s = perRoute.get(spec.route);
    if (!s) perRoute.set(spec.route, (s = new Set()));
    s.add(r.who);
  }
  out.thirdParty = all.size;
  for (const [route, s] of perRoute) out.byRoute[route].thirdParty = s.size;
  return out;
}

/**
 * Fold the grouped rows into the published shape. Pure, so the counting
 * rules are tested without a database.
 */
export function summariseLiquidators(
  rows: LiquidatorRow[],
  keeperAddress: string | undefined | null,
  nowSec: number,
): LiquidatorStats {
  const keeper = keeperAddress ? keeperAddress.toLowerCase() : null;
  const windows = {} as LiquidatorStats['windows'];
  for (const w of Object.keys(LIQUIDATOR_WINDOWS) as (keyof typeof LIQUIDATOR_WINDOWS)[]) {
    const pick = (r: LiquidatorRow) => Number(w === '7d' ? r.n7 : r.n30) || 0;
    windows[w] = {
      primary: tally(rows, PRIMARY_LIQUIDATION_ROUTES, keeper, pick),
      otherRoutes: tally(rows, OTHER_LIQUIDATION_ROUTES, keeper, pick),
    };
  }
  const caveats = [...LIQUIDATOR_CAVEATS];
  if (keeper === null) {
    caveats.push(
      'This chain publishes no keeper address, so the protocol keeper cannot be told apart and any keeper liquidation is counted as a third party.',
    );
  }
  return { asOf: nowSec, keeperAddress: keeper, windows, caveats };
}
