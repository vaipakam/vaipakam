#!/usr/bin/env node
/**
 * Activity-refs coverage guardrail (#1794).
 *
 * `activity_events` denormalizes two cross-domain reference columns —
 * `loan_id` and `offer_id` — so the audit feed can be filtered by loan or by
 * offer. Those columns are populated by `pluckActivityRefs()` in
 * `apps/indexer/src/chainIndexer.ts`, which switches on the event name.
 *
 * An event with no `case` falls to that function's `default:` branch and is
 * stored with **all references NULL**. The row still exists, so nothing looks
 * broken: `/activity` shows it, the insert succeeds, no check fails. What
 * silently breaks is `/activity?loanId=N` and the indexer-backed
 * `LoanTimeline`, which cannot find it. The omission is only visible if you
 * happen to query by loan.
 *
 * That is not hypothetical and it is not rare. Codex found `LoanStatusChanged`
 * missing this way on #1792 — and it was the 46th such omission, with 45 other
 * `loanId`-carrying events in the same state. The event whose whole purpose was
 * to make a transition observable was invisible to the loan-scoped view.
 *
 * So this script enforces, per FIELD (not per event): every event whose
 * compiled ABI carries a `loanId` input must either map that id in
 * `pluckActivityRefs`, or carry an allowlist entry with a reason. Same for
 * `offerId`. Per-field matters because an event can be mapped for one and
 * silently drop the other.
 *
 * Ground truth is the compiled ABI bundle (`packages/contracts/src/abis/`),
 * the same single source of truth the indexer derives `EVENT_ABI` from — not a
 * hand-maintained list, which is the drift this guardrail exists to stop.
 *
 * Run: `node apps/indexer/scripts/check-activity-refs-coverage.mjs`
 *      (or `pnpm --filter @vaipakam/indexer check-activity-refs-coverage`)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const ABI_DIR = join(REPO_ROOT, 'packages', 'contracts', 'src', 'abis');
const CHAIN_INDEXER = join(REPO_ROOT, 'apps', 'indexer', 'src', 'chainIndexer.ts');

/**
 * Events deliberately NOT reference-scoped, each with a reason.
 *
 * Two kinds of entry, and the difference is honest debt-tracking rather than
 * decoration:
 *
 *   - a plain reason — the event genuinely does not belong on a loan/offer
 *     timeline (a companion payload, an internal bookkeeping breadcrumb).
 *   - a `TODO(#1794)` prefix — the event SHOULD be scoped and is not yet.
 *     These are the real gaps, enumerable with a grep, and each is meant to
 *     leave this list in a later slice. Allowlisting them without the marker
 *     would bury 40-odd real gaps behind the word "deliberately".
 *
 * Keyed `EventName` for both fields, or `EventName.loanId` / `.offerId` to
 * exempt a single field of an event that is mapped for the other.
 */
const DELIBERATELY_NOT_SCOPED = {
  // ── genuinely not loan/offer-scoped ────────────────────────────────────
  LoanInitiatedDetails:
    'companion payload to LoanInitiated, consumed to build the loans row — the LoanInitiated row already carries the loan reference, so a second row for the same event pair would double-count the timeline',
  FeeEntitlementStamped:
    'fee-entitlement bookkeeping stamped at accept — an internal accounting record, not an event a user reads on a loan timeline',
  FeeEntitlementRepriced:
    'twin of FeeEntitlementStamped — governance retune bookkeeping, not user-facing loan activity',
  NotificationFeeBilled:
    'per-notification billing record — belongs to the notification subsystem, not the loan timeline',

  // ── TODO(#1794): real gaps, awaiting per-slice mapping ─────────────────
  // Grep `TODO(#1794)` for the live backlog. Ordered roughly by how clearly
  // user-facing they are, since that is the order the slices should take.
  LoanSold: 'TODO(#1794) — direct lender sale; plainly loan-timeline material',
  LoanSaleCompleted: 'TODO(#1794) — listed lender sale completion; plainly loan-timeline material',
  LoanSaleOfferLinked: 'TODO(#1794) — sale listing bound to a loan',
  LoanSaleListingTornDown: 'TODO(#1794) — sale listing withdrawn',
  LoanPreclosedDirect: 'TODO(#1794) — borrower early close-out',
  LoanObligationTransferred: 'TODO(#1794) — obligation handover to a replacement borrower',
  CollateralAdded: 'TODO(#1794) — borrower collateral top-up',
  PartialCollateralWithdrawn: 'TODO(#1794) — surplus collateral release',
  CollateralConsolidated: 'TODO(#1794) — collateral consolidation to the NFT holder',
  HFLiquidationTriggered: 'TODO(#1794) — health-factor liquidation; the loans row IS flipped (#1293), only the activity reference is missing',
  LiquidationDiscounted: 'TODO(#1794) — twin of HFLiquidationTriggered',
  LoanPartiallyLiquidated: 'TODO(#1794) — partial liquidation',
  LiquidationFallback: 'TODO(#1794) — liquidation fallback entry',
  LiquidationFallbackSplit: 'TODO(#1794) — split-route liquidation fallback',
  LiquidationFallbackOracleUnavailable: 'TODO(#1794) — fallback taken because the oracle was unavailable',
  FlashLoanLiquidationCompleted: 'TODO(#1794) — flash-loan liquidation route',
  LoanFallbackPending: 'TODO(#1794) — fallback episode opened',
  LoanCuredFromFallback: 'TODO(#1794) — fallback episode cured',
  BackstopFilled: 'TODO(#1794) — backstop fill against a loan',
  BackstopLoanClaimed: 'TODO(#1794) — backstop claim',
  LenderBackstopOptInSet: 'TODO(#1794) — per-loan backstop opt-in',
  BorrowerSurplusClaimed: 'TODO(#1794) — borrower surplus claim',
  LoanClaimedAndCompounded: 'TODO(#1794) — claim-and-compound',
  ClaimRetryExecuted: 'TODO(#1794) — claim retry',
  SanctionedProceedsLocked: 'TODO(#1794) — proceeds withheld from a flagged party',
  OfferSaleProceedsSplit: 'TODO(#1794) — per-recipient proceeds split on a parallel-sale fill',
  IntentMatched: 'TODO(#1794) — standing-intent match',
  SignedOfferFilled: 'TODO(#1794) — gasless signed offer filled',
  SignedOfferMatched: 'TODO(#1794) — gasless signed offer matched',
  AutoDailyDeducted: 'TODO(#1794) — NFT-rental daily deduction',
  AutoExtendBorrowerCapsChanged: 'TODO(#1794) — borrower auto-extend caps',
  AutoExtendLenderCapsChanged: 'TODO(#1794) — lender auto-extend caps',
  AutoRefinanceCapsChanged: 'TODO(#1794) — auto-refinance caps',
  AutoListOptOutCleared: 'TODO(#1794) — auto-list opt-out cleared',
  LoanKeeperEnabled: 'TODO(#1794) — per-loan keeper authorization',
  PrepaySaleListingSynced: 'TODO(#1794) — sanctions-sync breadcrumb on a loan-keyed listening',
  SwapAdapterAttempted: 'TODO(#1794) — swap adapter attempt',
  SwapAdapterSucceeded: 'TODO(#1794) — swap adapter success',
  SwapAllAdaptersFailed: 'TODO(#1794) — every swap adapter failed',
  VPFIDiscountApplied: 'TODO(#1794) — VPFI fee discount applied',
  VPFIYieldFeeDiscountApplied: 'TODO(#1794) — VPFI yield-fee discount applied',

  // ── offerId side ───────────────────────────────────────────────────────
  // Genuinely not offer-scoped: companion payloads whose primary event already
  // carries the reference, so scoping both would double-count the timeline.
  // Same rationale as LoanInitiatedDetails above.
  OfferCreatedDetails: 'companion payload to OfferCreated, which is offer-scoped already',
  OfferCanceledDetails: 'companion payload to OfferCanceled, which is offer-scoped already',

  // TODO(#1794): real gaps on the offer side. NOTE these are NOT the same
  // question as `check-event-coverage.mjs`'s DELIBERATELY_NOT_HANDLED — that
  // list is about driving a typed `offers` row, this one is about being findable
  // on an offer's activity feed. An event can legitimately not mutate the row
  // and still belong on the timeline, so their reasons do not transfer.
  OfferClosed:
    'TODO(#1794) — offer-lifecycle terminal, and it IS handled (chainIndexer.ts:1253 flips the row + stamps cancelled_at). Handled but unscoped is the sharpest shape of this bug: the projection is right while the audit trail cannot find the event.',
  OfferCreatorFullTariffSet: 'TODO(#1794) — per-offer fee-tariff opt-in',
  OfferKeeperEnabled: 'TODO(#1794) — per-offer keeper authorization',
  OfferBackstopEligibilitySet: 'TODO(#1794) — per-offer backstop eligibility; no indexer reference at all today',
  OfferSaleProceedsCredited: 'TODO(#1794) — proceeds credited to the borrower vault on a sale',
  PostParallelSaleListing: 'TODO(#1794) — parallel-sale listing posted',
  ParallelSaleLockReleased: 'TODO(#1794) — parallel-sale binding unwound',
  PrepaySaleOfferSynced: 'TODO(#1794) — sanctions-sync breadcrumb on an offer-keyed listing',
};

// ── 1. Events whose compiled ABI carries loanId / offerId ───────────────
const REF_FIELDS = ['loanId', 'offerId'];
/** eventName -> Set<field> */
const carries = new Map();
for (const file of readdirSync(ABI_DIR)) {
  if (!file.endsWith('.json') || file.startsWith('_')) continue;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(ABI_DIR, file), 'utf8'));
  } catch {
    continue; // not an ABI document — index.ts et al are not read here
  }
  const items = Array.isArray(parsed) ? parsed : parsed.abi;
  if (!Array.isArray(items)) continue;
  for (const item of items) {
    if (item?.type !== 'event' || !Array.isArray(item.inputs)) continue;
    const names = item.inputs.map((i) => i?.name);
    for (const field of REF_FIELDS) {
      if (!names.includes(field)) continue;
      if (!carries.has(item.name)) carries.set(item.name, new Set());
      carries.get(item.name).add(field);
    }
  }
}

// ── 2. What pluckActivityRefs actually maps, per field ──────────────────
const src = readFileSync(CHAIN_INDEXER, 'utf8');
const fnMatch = src.match(/function pluckActivityRefs\([\s\S]*?\n\}\n/);
if (!fnMatch) {
  console.error(
    '[check-activity-refs-coverage] could not locate pluckActivityRefs() in chainIndexer.ts.\n' +
      'If it was renamed or moved, update this script — do not delete the check.',
  );
  process.exit(1);
}
const body = fnMatch[0];

/**
 * Split the switch into per-case blocks. Consecutive `case 'A': case 'B':`
 * labels share one return, so labels accumulate until a block with a body.
 */
/** eventName -> Set<field it returns non-null> */
const mapped = new Map();
{
  const CASE_RE = /case\s+'([A-Za-z0-9_]+)'\s*:/g;
  const labels = [];
  let m;
  const positions = [];
  while ((m = CASE_RE.exec(body)) !== null) positions.push({ name: m[1], end: m.index + m[0].length });
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].end;
    const stop = i + 1 < positions.length ? positions[i + 1].end : body.length;
    const chunk = body.slice(start, stop);
    labels.push(positions[i].name);
    // A fall-through label has nothing but whitespace before the next case.
    if (!/\S/.test(chunk.replace(/case\s+'[A-Za-z0-9_]+'\s*:/g, ''))) continue;
    const fields = new Set();
    for (const field of REF_FIELDS) {
      // `loanId: Number(args.loanId as bigint)` counts; `loanId: null` does not.
      const re = new RegExp(`${field}\\s*:\\s*([^,\\n]+)`);
      const hit = chunk.match(re);
      if (hit && !/^null\b/.test(hit[1].trim())) fields.add(field);
    }
    for (const label of labels) mapped.set(label, fields);
    labels.length = 0;
  }
}

// ── 3. Report ──────────────────────────────────────────────────────────
const gaps = [];
let mappedFields = 0;
let allowlisted = 0;
for (const [event, fields] of [...carries].sort((a, b) => a[0].localeCompare(b[0]))) {
  for (const field of fields) {
    if (mapped.get(event)?.has(field)) {
      mappedFields++;
      continue;
    }
    if (DELIBERATELY_NOT_SCOPED[event] || DELIBERATELY_NOT_SCOPED[`${event}.${field}`]) {
      allowlisted++;
      continue;
    }
    gaps.push({ event, field });
  }
}

// Dead entries: allowlisted but no longer carrying the field, or now mapped.
// Mirrors the dead-allowlist discipline in check-event-coverage.mjs — a stale
// allowlist quietly re-opens the hole it was meant to document.
const dead = [];
for (const key of Object.keys(DELIBERATELY_NOT_SCOPED)) {
  const [event, field] = key.split('.');
  const has = carries.get(event);
  if (!has) {
    dead.push(`${key} — no compiled event carries a loanId/offerId under this name`);
    continue;
  }
  const fields = field ? [field] : [...has];
  if (fields.every((f) => mapped.get(event)?.has(f))) {
    dead.push(`${key} — now mapped in pluckActivityRefs; remove this entry`);
  }
}

if (gaps.length || dead.length) {
  if (gaps.length) {
    console.error(
      `\n✖ activity-refs coverage: ${gaps.length} event/field pair(s) carry a reference the ledger drops.\n` +
        '  Each stores NULL, so /activity?loanId=N and LoanTimeline cannot find the row.\n' +
        '  Fix by adding a case to pluckActivityRefs(), or allowlist with a reason in this script.\n',
    );
    for (const { event, field } of gaps) console.error(`    ${event}.${field}`);
  }
  if (dead.length) {
    console.error('\n✖ activity-refs coverage: stale allowlist entries:\n');
    for (const d of dead) console.error(`    ${d}`);
  }
  console.error('');
  process.exit(1);
}

const todo = Object.values(DELIBERATELY_NOT_SCOPED).filter((r) => r.startsWith('TODO(#1794)')).length;
console.log(
  `✓ activity-refs coverage OK — ${carries.size} event(s) carry a reference; ` +
    `${mappedFields} field(s) mapped, ${allowlisted} allowlisted (${todo} of those are TODO(#1794) gaps awaiting mapping).`,
);
