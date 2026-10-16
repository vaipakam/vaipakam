/**
 * M5 (#1218 / #1349) — the public recycling account and loop-closure
 * series, as the indexer serves them, VALIDATED before anything renders.
 *
 *   GET /metrics/recycling?chainId=&days=     apps/indexer/src/recycleRoutes.ts
 *   GET /metrics/loop-closure?chainId=&days=  apps/indexer/src/rewardRoutes.ts
 *
 * WHY VALIDATION LIVES HERE AND NOT IN THE COMPONENT. A malformed amount
 * reaching a render throws (`BigInt('')`), and the only error boundary
 * wraps the whole routed surface — one corrupt field from a bad D1 row
 * would replace all of /analytics with the crash fallback. Parsing up
 * front lets each section degrade to its OWN "cannot say" state instead.
 * The retired dashboard did this inside the component; it moves here so
 * the components receive only data they can render without re-checking.
 *
 * HOW NARROWLY EACH FAILURE DEGRADES (TokenomicsTechSpec: "a surface that
 * cannot trust its input refuses its own figures and no more"):
 *
 *  - a malformed DAY SERIES or cumulative figure withholds the whole
 *    recycling section — the series IS the account, there is nothing to
 *    fall back to;
 *  - a malformed BACKING figure withholds only the backing block — it is a
 *    separately captured chain reading, and its failure must not take the
 *    D1-derived day series down with it;
 *  - a malformed VERDICT withholds only the verdict — the amounts beside it
 *    are still well-formed and still publishable;
 *  - a NEW field an older indexer does not serve (the two recovery
 *    reservations, the custody state, the holder figures, the verdict) is
 *    NOT malformed: it reads as "not determinable" for that reading, never
 *    as zero and never as a reason to withdraw the reading.
 *
 * NOTHING HERE COMPUTES A FIGURE. In particular the backing verdict is the
 * indexer's (`backed`, decided by the one shared `recycleBackingVerdict`
 * in `@vaipakam/contracts/recycle-backing`) and is only CHECKED for shape
 * here. The retired dashboard decided "backed" itself as
 * `vpfiBalance >= bucket`, which was wrong before custody activation (it
 * ignored both recovery reservations) and after it (the bucket is then the
 * holder's custody, not a subtrahend of the platform's balance). A second
 * copy of the relation is a copy that has not drifted yet.
 */
import type {
  RecycleBackingRelation,
  RecycleBackingUndeterminedReason,
  RecycleBackingVerdict,
} from '@vaipakam/contracts/recycle-backing';
import { isWeiString } from '../lib/recyclingFormat';
import { getJson } from './indexer';

/* ── Wire shapes (mirrors of what the indexer serves) ─────────────────── */

/** One day of the recycling account, as `/metrics/recycling` serves it. */
export interface RecyclingDay {
  /** The programme's OWN day index — never converted to a calendar date. */
  dayId: number;
  stamped: boolean;
  armed: boolean;
  /** The day's figures are a schedule, not a commitment. Honour it. */
  estimate: boolean;
  origin: 'event' | 'backfill' | null;
  scheduleFloor: string | null;
  recycledBudget: string | null;
  aBar: string | null;
  marginBps: number | null;
  freshDrawdown: string | null;
  /** Only present for an armed, finalized day. Never derive it locally. */
  netEmission: string | null;
  selfFundingRatio: number | null;
  absorbedLocal: string;
  absorbedMirror: string;
  /** Global only once the day is finalized; `null` while partial. */
  absorbed: string | null;
}

/** `local-only` = this deployment has finalized no day itself. */
export type RecyclingScope = 'global' | 'local-only' | 'empty';

export interface RecyclingCumulative {
  absorbed: string;
  absorbedPreLaunch: string;
  absorbedLocal: string;
  absorbedMirror: string;
  freshDrawdown: string;
  recycledBudget: string;
  runwayExtensionDays: number | null;
  /** Why the runway is absent, when it is. Render the reason, not a dash. */
  runwayUnavailableReason: string | null;
  selfFunded: boolean;
}

/** The indexer's fixed codes for a withheld backing reading. */
export type BackingUnavailableCode =
  | 'not-captured-yet'
  | 'read-failed'
  | 'snapshot-stale'
  | 'chain-behind'
  | 'snapshot-other-deployment';

/**
 * The `backing` block as served — apps/indexer `BackingSnapshot`. Every
 * field optional on the WIRE because an older indexer omits the newer
 * ones; `parseBacking` decides what an absence means for each.
 */
interface BackingWire {
  vpfiBalance?: unknown;
  bucket?: unknown;
  unearmarked?: unknown;
  outstandingRecycled?: unknown;
  paidOutRecycled?: unknown;
  keeperBudget?: unknown;
  platformRetained?: unknown;
  blockNumber?: unknown;
  diamond?: unknown;
  releasedRemitStranded?: unknown;
  strandedRecoveryReserved?: unknown;
  recoveryPositionReserved?: unknown;
  custodyActivated?: unknown;
  holderBalanceKnown?: unknown;
  holderBalance?: unknown;
  holderAttributed?: unknown;
  backed?: unknown;
  unavailableReason?: unknown;
  asOf?: unknown;
  pendingMigration?: unknown;
}

/* ── Parsed shapes (what the components render) ───────────────────────── */

/**
 * The verdict as this page may present it. Three cases, because "the
 * indexer did not send one" and "it sent one this page cannot read" are
 * different facts, and both differ from a verdict the indexer stated.
 */
export type BackingVerdictView =
  | { kind: 'served'; verdict: RecycleBackingVerdict }
  /** An indexer that predates the verdict. NOT computed here instead. */
  | { kind: 'not-served' }
  /** Present, but not a shape the shared function produces. */
  | { kind: 'malformed' };

/** A backing reading complete enough to publish. */
export interface PublishableBacking {
  vpfiBalance: string;
  bucket: string;
  unearmarked: string;
  outstandingRecycled: string;
  paidOutRecycled: string;
  keeperBudget: string;
  platformRetained: string;
  releasedRemitStranded: string;
  /** `null` = this reading predates the figure (not determinable). */
  strandedRecoveryReserved: string | null;
  /** `null` = this reading predates the figure (not determinable). */
  recoveryPositionReserved: string | null;
  /** `null` = the reading does not record where custody is held. */
  custodyActivated: boolean | null;
  /** `false` = the chain reported the holder's balance unreadable. */
  holderBalanceKnown: boolean | null;
  holderBalance: string | null;
  holderAttributed: string | null;
  verdict: BackingVerdictView;
  blockNumber: string;
  diamond: string;
  /** The timestamp of the block these figures describe (ISO 8601). */
  asOf: string;
  /**
   * The schema migration the indexer is still waiting for, by name, when its
   * rollout has not applied it — `null` otherwise. A fact about the data
   * service, not about this reading: it is why custody can read as not
   * recorded indefinitely (Codex #2521 r1 P2), so the page says so.
   */
  pendingMigration: string | null;
}

/** Why the backing block is withheld — always a reason, never a dash. */
export type BackingWithheld =
  /** The indexer's own refusal, by its fixed code. */
  | { kind: 'indexer'; code: string; pendingMigration: string | null }
  /** An indexer that predates the backing block entirely. */
  | { kind: 'not-served' }
  /** A figure in the reading is not a well-formed amount or flag. */
  | { kind: 'malformed' }
  /** Served as available, but missing a figure, its moment or its source. */
  | { kind: 'incomplete' };

export type BackingView =
  | { kind: 'published'; backing: PublishableBacking }
  | { kind: 'withheld'; reason: BackingWithheld };

export interface RecyclingAccountData {
  chainId: number;
  days: number;
  fromDay: number | null;
  toDay: number | null;
  scope: RecyclingScope;
  coverageFromDay: number | null;
  daily: RecyclingDay[];
  cumulative: RecyclingCumulative;
  backing: BackingView;
}

/* ── Validation ───────────────────────────────────────────────────────── */

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** An amount the wire allows to be withheld: null, or a decimal wei string. */
const isWeiOrNull = (v: unknown) => v === null || isWeiString(v);

const isInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v);

const isIntOrNull = (v: unknown) => v === null || isInt(v);

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** A published ratio: a finite, non-negative number. */
const isRatio = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Every token amount a day carries. A field skipped here renders unchecked. */
const DAY_AMOUNTS = [
  'scheduleFloor',
  'recycledBudget',
  'aBar',
  'freshDrawdown',
  'netEmission',
  'absorbed',
] as const;

function isDay(v: unknown): v is RecyclingDay {
  if (!isRec(v)) return false;
  const wellTyped =
    isInt(v.dayId) &&
    isBool(v.stamped) &&
    isBool(v.armed) &&
    isBool(v.estimate) &&
    (v.origin === 'event' || v.origin === 'backfill' || v.origin === null) &&
    DAY_AMOUNTS.every((f) => isWeiOrNull(v[f])) &&
    // The two live components are always published, so never null.
    isWeiString(v.absorbedLocal) &&
    isWeiString(v.absorbedMirror) &&
    (v.marginBps === null || isInt(v.marginBps)) &&
    // A share of the day's pool: in [0, 1] by construction (recycled over
    // floor + recycled). Anything outside is not a figure this page can
    // stand behind, so the series is refused rather than the cell guessed.
    (v.selfFundingRatio === null ||
      (isRatio(v.selfFundingRatio) && v.selfFundingRatio <= 1));
  return wellTyped && isConsistentDay(v as unknown as RecyclingDay);
}

/**
 * Does this day's set of withheld figures match its finalization state?
 *
 * Each empty cell on the page NAMES its reason — "no pool, the day has not
 * closed", "none committed, estimate", "the pool was empty" — and the
 * reason is chosen from the day's flags. A row whose nulls disagree with
 * its flags would make a cell state a reason that is not true (an armed,
 * finalized day labelled as having committed nothing). So the row is held
 * to the exact shape the indexer builds, and refused otherwise.
 *
 * String comparisons only: nothing here adds or compares amounts.
 */
function isConsistentDay(d: RecyclingDay): boolean {
  if (!d.stamped) {
    // An open day has no pool, no draw, no ratio and no global sum —
    // only its live absorption components.
    return (
      !d.armed &&
      !d.estimate &&
      d.scheduleFloor === null &&
      d.recycledBudget === null &&
      d.freshDrawdown === null &&
      d.netEmission === null &&
      d.selfFundingRatio === null &&
      d.absorbed === null
    );
  }
  return (
    d.scheduleFloor !== null &&
    d.recycledBudget !== null &&
    d.freshDrawdown !== null &&
    d.absorbed !== null &&
    // Unarmed = a schedule, not a commitment: an estimate with no net
    // emission. Armed = committed, so the net emission is published.
    d.estimate === !d.armed &&
    (d.armed ? d.netEmission !== null : d.netEmission === null) &&
    // A finalized day's ratio is withheld only when its pool is empty.
    (d.selfFundingRatio !== null ||
      (d.scheduleFloor === '0' && d.recycledBudget === '0'))
  );
}

/** Every cumulative total. All always published (the scope decides display). */
const CUMULATIVE_AMOUNTS = [
  'absorbed',
  'absorbedPreLaunch',
  'absorbedLocal',
  'absorbedMirror',
  'freshDrawdown',
  'recycledBudget',
] as const;

function isCumulative(v: unknown): v is RecyclingCumulative {
  if (!isRec(v)) return false;
  return (
    CUMULATIVE_AMOUNTS.every((f) => isWeiString(v[f])) &&
    (v.runwayExtensionDays === null || isRatio(v.runwayExtensionDays)) &&
    (v.runwayUnavailableReason === null ||
      typeof v.runwayUnavailableReason === 'string') &&
    isBool(v.selfFunded)
  );
}

/**
 * Backing amounts a SUCCESSFUL reading always carries. A null among them on
 * an available reading is a partial payload, not a withheld one — and a
 * reserve published beside an empty balance is the all-or-nothing rule
 * failing on exactly the untrusted path it exists to cover.
 *
 * Driven from ONE list on purpose: the retired dashboard's gate drifted
 * from its amount list three times in one PR, each time a member was
 * added to one and not the other.
 */
const BACKING_REQUIRED_AMOUNTS = [
  'vpfiBalance',
  'bucket',
  'unearmarked',
  'outstandingRecycled',
  'paidOutRecycled',
  'keeperBudget',
  'platformRetained',
  'releasedRemitStranded',
  'blockNumber',
] as const;

/**
 * Backing amounts that are legitimately ABSENT on some readings: the two
 * recovery reservations predate #1930 on older rows, and the holder figures
 * predate migration 0056 (or the chain could not read the holder). Absent
 * is "not determinable for this reading" — but present-and-malformed is
 * still corruption, and withholds the block like any other bad figure.
 */
const BACKING_OPTIONAL_AMOUNTS = [
  'strandedRecoveryReserved',
  'recoveryPositionReserved',
  'holderBalance',
  'holderAttributed',
] as const;

const UNDETERMINED_REASONS: readonly RecycleBackingUndeterminedReason[] = [
  'custody-state-unknown',
  'holder-balance-unknown',
  'subtrahend-unknown',
];

const RELATIONS: readonly RecycleBackingRelation[] = ['diamond', 'holder'];

/** `undefined` (an older indexer) reads as `null`: absent, not false. */
const optional = (v: unknown): unknown => (v === undefined ? null : v);

/**
 * The operands a reading carries, by PRESENCE only. Its own fields, never
 * the verdict's.
 */
interface ReadingOperands {
  /** The holder's balance is published as known AND carried. */
  holderBalanceRead: boolean;
  holderAttributed: boolean;
  strandedRecoveryReserved: boolean;
  recoveryPositionReserved: boolean;
}

/**
 * Which "not determinable" reason this reading's own operand presence forces
 * on the relation its custody state selects — `null` when every operand that
 * relation reads is present, so the answer must be determinable.
 *
 * PRESENCE, NOT AMOUNTS. Nothing here compares a figure, so the page still
 * reaches no verdict of its own (TokenomicsTechSpec: a displaying surface
 * shows the published answer and "never reaches a verdict of its own from
 * the published amounts"). It only states which question the reading can
 * answer at all, in the order the shared function asks it: the custody
 * state first; on the Diamond relation both reservations; on the holder
 * relation the holder's balance first (that reason takes precedence when
 * both legs are unread), then each leg's subtracted term.
 */
function forcedUndeterminedReason(
  relation: RecycleBackingRelation | null,
  r: ReadingOperands,
): RecycleBackingUndeterminedReason | null {
  if (relation === null) return 'custody-state-unknown';
  if (relation === 'diamond') {
    return r.strandedRecoveryReserved && r.recoveryPositionReserved
      ? null
      : 'subtrahend-unknown';
  }
  if (!r.holderBalanceRead) return 'holder-balance-unknown';
  return r.holderAttributed && r.strandedRecoveryReserved ? null : 'subtrahend-unknown';
}

/**
 * Is this a verdict the shared function could have produced, for THIS
 * reading?
 *
 * A SHAPE check, not a recomputation: nothing here compares the amounts.
 * It refuses the combinations `recycleBackingVerdict` never emits — a
 * determinable answer with no relation, a failing answer with no
 * shortfall, a holder shortfall on the Diamond relation, a relation that
 * contradicts the custody state published beside it, a reason the
 * reading's own operands contradict. Any of those on screen would be a
 * statement the page cannot reconcile with its own figures, so the verdict
 * alone is withheld.
 *
 * A PARTIAL answer is refused too, whatever it is labelled. The holder
 * relation has two legs and is answered only when both were read; a
 * determinable answer beside a reading missing an operand of either leg is
 * one leg's shortfall offered as the whole answer. This surface renders a
 * shortfall list as THE answer, so serving it would say "No, short by X"
 * where the honest statement is "cannot be determined". The rule keys on
 * the READING's operands, never on fields the verdict carries about itself,
 * so it holds for any such answer however it is shaped.
 *
 * @param custodyActivated the reading's published custody state
 * @param operands         which operands the reading carries
 */
function isVerdictFor(
  v: unknown,
  custodyActivated: boolean | null,
  operands: ReadingOperands,
): v is RecycleBackingVerdict {
  if (!isRec(v)) return false;
  const relation = v.relation;
  if (relation !== null && !RELATIONS.includes(relation as RecycleBackingRelation)) {
    return false;
  }
  if (!isWeiOrNull(v.diamondShortfall) || !isWeiOrNull(v.holderShortfall)) {
    return false;
  }
  // The relation follows the custody state; an unknown state chooses none.
  const expected: RecycleBackingRelation | null =
    custodyActivated === null ? null : custodyActivated ? 'holder' : 'diamond';
  if (relation !== expected) return false;
  // What the reading can answer. A determinable verdict needs every operand
  // its relation reads; an undetermined one must give the reason the
  // reading forces, not another.
  const forced = forcedUndeterminedReason(expected, operands);

  if (v.determinable === true) {
    if (forced !== null) return false;
    if (v.reason !== null || relation === null || !isBool(v.ok)) return false;
    if (relation === 'diamond' && v.holderShortfall !== null) return false;
    const shortfalls = [v.diamondShortfall, v.holderShortfall].filter(
      (s) => s !== null,
    ) as string[];
    // A shortfall is a POSITIVE amount; "short by 0" is not a shortfall.
    if (shortfalls.some((s) => BigInt(s) === 0n)) return false;
    return v.ok ? shortfalls.length === 0 : shortfalls.length > 0;
  }
  if (v.determinable === false) {
    return (
      v.ok === null &&
      v.diamondShortfall === null &&
      v.holderShortfall === null &&
      UNDETERMINED_REASONS.includes(v.reason as RecycleBackingUndeterminedReason) &&
      forced !== null &&
      v.reason === forced
    );
  }
  return false;
}

/**
 * The backing block alone. Its failure withholds the BLOCK, never the
 * account. A response with no `backing` at all (an indexer that predates
 * it) is the same refusal a failed read produces — never a crash.
 */
export function parseBacking(raw: unknown): BackingView {
  if (raw === undefined || raw === null) {
    return { kind: 'withheld', reason: { kind: 'not-served' } };
  }
  if (!isRec(raw)) return { kind: 'withheld', reason: { kind: 'malformed' } };
  const b = raw as BackingWire;

  // The migration the indexer is still waiting for, if any — carried on
  // every outcome (it is about the database, not one reading); an older
  // indexer omits it, which reads as none.
  const pendingMigration = optional(b.pendingMigration);
  if (pendingMigration !== null && (typeof pendingMigration !== 'string' || pendingMigration === '')) {
    return { kind: 'withheld', reason: { kind: 'malformed' } };
  }

  // The indexer's own refusal comes first: a withheld reading is all-null
  // by design, and its REASON is the thing to publish.
  if (b.unavailableReason !== null && b.unavailableReason !== undefined) {
    return typeof b.unavailableReason === 'string' && b.unavailableReason !== ''
      ? {
          kind: 'withheld',
          reason: { kind: 'indexer', code: b.unavailableReason, pendingMigration: pendingMigration as string | null },
        }
      : { kind: 'withheld', reason: { kind: 'malformed' } };
  }

  const rec = b as Rec;
  // Malformed beats incomplete: a corrupt figure is a fault in the data,
  // a missing one a gap, and reporting the gap would hide the fault.
  if (!BACKING_REQUIRED_AMOUNTS.every((f) => isWeiOrNull(rec[f] ?? null))) {
    return { kind: 'withheld', reason: { kind: 'malformed' } };
  }
  if (!BACKING_OPTIONAL_AMOUNTS.every((f) => isWeiOrNull(optional(rec[f])))) {
    return { kind: 'withheld', reason: { kind: 'malformed' } };
  }
  const custodyActivated = optional(b.custodyActivated);
  const holderBalanceKnown = optional(b.holderBalanceKnown);
  if (
    (custodyActivated !== null && !isBool(custodyActivated)) ||
    (holderBalanceKnown !== null && !isBool(holderBalanceKnown))
  ) {
    return { kind: 'withheld', reason: { kind: 'malformed' } };
  }

  if (!BACKING_REQUIRED_AMOUNTS.every((f) => isWeiString(rec[f]))) {
    return { kind: 'withheld', reason: { kind: 'incomplete' } };
  }
  // The capture moment is part of the success tuple, not decoration: these
  // figures are read on a schedule, and the ONLY thing making that honest
  // is the reader being able to judge their currency. A PARSEABLE instant
  // — `asOf: "unknown"` once passed a length check and was rendered as the
  // freshness disclosure.
  if (typeof b.asOf !== 'string' || !Number.isFinite(Date.parse(b.asOf))) {
    return { kind: 'withheld', reason: { kind: 'incomplete' } };
  }
  // WHOSE state. A block says when; after a redeploy only the contract
  // address identifies the state, and reproducing a figure needs both.
  if (typeof b.diamond !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(b.diamond)) {
    return { kind: 'withheld', reason: { kind: 'incomplete' } };
  }

  const verdictRaw = b.backed;
  const verdict: BackingVerdictView =
    verdictRaw === undefined || verdictRaw === null
      ? { kind: 'not-served' }
      : isVerdictFor(verdictRaw, custodyActivated as boolean | null, {
            holderBalanceRead: holderBalanceKnown === true && optional(rec.holderBalance) !== null,
            holderAttributed: optional(rec.holderAttributed) !== null,
            strandedRecoveryReserved: optional(rec.strandedRecoveryReserved) !== null,
            recoveryPositionReserved: optional(rec.recoveryPositionReserved) !== null,
          })
        ? { kind: 'served', verdict: verdictRaw }
        : { kind: 'malformed' };

  return {
    kind: 'published',
    backing: {
      vpfiBalance: b.vpfiBalance as string,
      bucket: b.bucket as string,
      unearmarked: b.unearmarked as string,
      outstandingRecycled: b.outstandingRecycled as string,
      paidOutRecycled: b.paidOutRecycled as string,
      keeperBudget: b.keeperBudget as string,
      platformRetained: b.platformRetained as string,
      releasedRemitStranded: b.releasedRemitStranded as string,
      strandedRecoveryReserved: optional(b.strandedRecoveryReserved) as string | null,
      recoveryPositionReserved: optional(b.recoveryPositionReserved) as string | null,
      custodyActivated: custodyActivated as boolean | null,
      holderBalanceKnown: holderBalanceKnown as boolean | null,
      holderBalance: optional(b.holderBalance) as string | null,
      holderAttributed: optional(b.holderAttributed) as string | null,
      verdict,
      blockNumber: b.blockNumber as string,
      diamond: b.diamond,
      asOf: b.asOf,
      pendingMigration: pendingMigration as string | null,
    },
  };
}

/**
 * The whole `/metrics/recycling` response. `null` = the series itself is
 * malformed (or absent), which withholds the whole section; a malformed
 * BACKING block alone comes back as `backing: { kind: 'withheld' }` with
 * the series intact.
 */
export function parseRecyclingSeries(raw: unknown): RecyclingAccountData | null {
  if (!isRec(raw)) return null;
  const { scope, daily, cumulative } = raw;
  if (scope !== 'global' && scope !== 'local-only' && scope !== 'empty') return null;
  if (!Array.isArray(daily) || !daily.every(isDay)) return null;
  if (!isCumulative(cumulative)) return null;
  if (
    !isInt(raw.chainId) ||
    !isInt(raw.days) ||
    !isIntOrNull(raw.fromDay) ||
    !isIntOrNull(raw.toDay) ||
    !isIntOrNull(raw.coverageFromDay)
  ) {
    return null;
  }
  return {
    chainId: raw.chainId,
    days: raw.days,
    fromDay: raw.fromDay as number | null,
    toDay: raw.toDay as number | null,
    scope,
    coverageFromDay: raw.coverageFromDay as number | null,
    daily,
    cumulative,
    backing: parseBacking(raw.backing),
  };
}

/** How many days the recycling table asks for. Disclosed in the copy. */
export const RECYCLING_WINDOW_DAYS = 30;

/**
 * The recycling account, validated. `null` when no indexer origin is
 * configured, the read fails, or the series is malformed — the caller
 * renders "cannot say" rather than substituting zeros, which on this
 * surface would be indistinguishable from a real quiet period.
 */
export async function fetchRecyclingAccount(
  chainId: number,
  days: number = RECYCLING_WINDOW_DAYS,
): Promise<RecyclingAccountData | null> {
  const raw = await getJson<unknown>(
    `/metrics/recycling?chainId=${chainId}&days=${days}`,
  );
  return raw === null ? null : parseRecyclingSeries(raw);
}

/* ── Loop closure ─────────────────────────────────────────────────────── */

/**
 * How complete one day of the loop-closure series is, as the indexer
 * decided it (its `status`; the page never re-derives it — that would make
 * it a second authority on where the record ends):
 *
 *  - `complete`   the day has ended and every claim in it is recorded.
 *  - `partial`    the day in progress, or the day the record stops in. Its
 *                 amounts are what is recorded SO FAR; it has no ratio.
 *  - `unrecorded` the record does not reach this day. No amounts at all —
 *                 unknown, which is not zero.
 */
export type LoopDayStatus = 'complete' | 'partial' | 'unrecorded';

/**
 * One day of the loop-closure series.
 *
 * NOTE THE DAY: this series is bucketed by the CALENDAR day (UTC) the
 * tokens left the platform — the claim-day basis the metric is defined on
 * — not by the programme day the recycling account uses. The two indices
 * are differently based and their boundaries fall at different moments
 * (TokenomicsTechSpec: "neither may be substituted for the other"), so the
 * page shows this series by the date the indexer itself publishes, as
 * served, and never converts between the two.
 */
export type LoopClosureDay =
  | {
      dayId: number;
      /** `YYYY-MM-DD`, UTC, exactly as the indexer publishes it. */
      date: string;
      status: 'complete' | 'partial';
      distributed: string;
      netVaultDelivered: string;
      absorbed: string;
      /**
       * Flow ratio. On a complete day `null` means nothing was distributed
       * (not applicable); a partial day never carries one.
       */
      ratio: number | null;
    }
  | {
      dayId: number;
      date: string;
      status: 'unrecorded';
      distributed: null;
      netVaultDelivered: null;
      absorbed: null;
      ratio: null;
    };

export interface LoopClosureData {
  chainId: number;
  days: number;
  /**
   * Every claim timestamped before this instant is in the series (ISO);
   * `null` = the indexer has not recorded how far its record reaches, in
   * which case every day is `unrecorded`.
   */
  recordedBefore: string | null;
  daily: LoopClosureDay[];
  /**
   * Lifetime figures, stated only against a recorded moment: `null` when
   * `recordedBefore` is `null` (the indexer has not substantiated them), so
   * the page shows each as not yet recorded rather than as a lifetime zero.
   */
  cumulative: {
    cumDistributed: string;
    cumAbsorbed: string;
    retainedStock: string;
    /** Stock ratio; `null` while nothing has been distributed. */
    ratio: number | null;
  } | null;
}

/**
 * The not-applicable rule is checked, not assumed: the indexer reports a
 * ratio of `null` exactly when its denominator is zero. A payload that
 * pairs a zero distribution with a number (or a positive one with `null`)
 * would make the page print "not applicable" beside a real figure, or a
 * share beside nothing — so it is refused like any other malformed value.
 */
const ratioMatchesDenominator = (ratio: unknown, denominator: string) =>
  denominator === '0' ? ratio === null : isRatio(ratio);

const LOOP_STATUS_ORDER: Record<LoopDayStatus, number> = {
  complete: 0,
  partial: 1,
  unrecorded: 2,
};

function isLoopDay(v: unknown): v is LoopClosureDay {
  if (!isRec(v)) return false;
  if (!isInt(v.dayId) || typeof v.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) {
    return false;
  }
  switch (v.status) {
    case 'complete':
      return (
        isWeiString(v.distributed) &&
        isWeiString(v.netVaultDelivered) &&
        isWeiString(v.absorbed) &&
        ratioMatchesDenominator(v.ratio, v.distributed)
      );
    case 'partial':
      // Amounts so far; a share of a day not yet over would be shown as a
      // final one, and it is not a lower bound on the day's final share.
      return (
        isWeiString(v.distributed) &&
        isWeiString(v.netVaultDelivered) &&
        isWeiString(v.absorbed) &&
        v.ratio === null
      );
    case 'unrecorded':
      // Unknown, so nothing — a zero here is the defect this status exists
      // to end ("nothing paid out" on a day nobody has recorded).
      return (
        v.distributed === null &&
        v.netVaultDelivered === null &&
        v.absorbed === null &&
        v.ratio === null
      );
    default:
      // Includes an indexer that predates `status`: its padded zeros cannot
      // be told apart from recorded ones, so the series is refused rather
      // than shown as facts.
      return false;
  }
}

/** The whole `/metrics/loop-closure` response; `null` if any of it is malformed. */
export function parseLoopClosure(raw: unknown): LoopClosureData | null {
  if (!isRec(raw)) return null;
  const { daily, cumulative } = raw;
  if (!isInt(raw.chainId) || !isInt(raw.days)) return null;
  const recordedBefore = raw.recordedBefore;
  if (
    recordedBefore !== null &&
    (typeof recordedBefore !== 'string' || !Number.isFinite(Date.parse(recordedBefore)))
  ) {
    return null;
  }
  if (!Array.isArray(daily) || !daily.every(isLoopDay)) return null;
  // The record reaches forward in time and stops once: complete days, then
  // at most the day it stops in, then days it has not reached. Any other
  // order is a series the page could not describe with one as-of moment.
  // With no moment at all, no day can be known.
  for (let i = 1; i < daily.length; i++) {
    if (LOOP_STATUS_ORDER[daily[i].status] < LOOP_STATUS_ORDER[daily[i - 1].status]) return null;
  }
  if (daily.filter((d) => d.status === 'partial').length > 1) return null;
  if (recordedBefore === null && daily.some((d) => d.status !== 'unrecorded')) return null;
  // Lifetime figures exist only against a recorded moment (Codex #2521 r1):
  // with none they must be absent — a block beside no moment is a lifetime
  // claim nothing substantiates; with one they must be present and well formed.
  if (recordedBefore === null) {
    if (cumulative !== null) return null;
    return { chainId: raw.chainId, days: raw.days, recordedBefore: null, daily, cumulative: null };
  }
  if (!isRec(cumulative)) return null;
  if (
    !isWeiString(cumulative.cumDistributed) ||
    !isWeiString(cumulative.cumAbsorbed) ||
    !isWeiString(cumulative.retainedStock) ||
    !ratioMatchesDenominator(cumulative.ratio, cumulative.cumDistributed)
  ) {
    return null;
  }
  return {
    chainId: raw.chainId,
    days: raw.days,
    recordedBefore: recordedBefore as string,
    daily,
    cumulative: {
      cumDistributed: cumulative.cumDistributed,
      cumAbsorbed: cumulative.cumAbsorbed,
      retainedStock: cumulative.retainedStock,
      ratio: cumulative.ratio as number | null,
    },
  };
}

/** How many calendar days the loop-closure table asks for. */
export const LOOP_CLOSURE_WINDOW_DAYS = 30;

/** The loop-closure series, validated; `null` = cannot say. */
export async function fetchLoopClosure(
  chainId: number,
  days: number = LOOP_CLOSURE_WINDOW_DAYS,
): Promise<LoopClosureData | null> {
  const raw = await getJson<unknown>(
    `/metrics/loop-closure?chainId=${chainId}&days=${days}`,
  );
  return raw === null ? null : parseLoopClosure(raw);
}
