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
import { readFileSync } from 'node:fs';
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
  // Surfaced by the alias table (Codex round-2 P2) — it carries `oldLoanId` /
  // `newLoanId` and no exact `loanId`, so it had been outside the guardrail
  // entirely. Left as a TODO rather than mapped here because the choice is
  // genuinely ambiguous and deserves a deliberate decision: a refinance leaves
  // TWO loan records (the old one terminalized Repaid, a new one created), and
  // `activity_events` has one `loan_id` column. Mapping it to the old loan makes
  // the row appear on the position the user is leaving; mapping it to the new
  // one makes it appear on the position they end up with. Both are defensible
  // and the slice that maps it should say which and why.
  'LoanRefinanced.loanId':
    'TODO(#1794) — refinance; needs a decision on old-vs-new loan for the single loan_id column',
  LoanSold: 'TODO(#1794) — direct lender sale; plainly loan-timeline material',
  LoanSaleCompleted: 'TODO(#1794) — listed lender sale completion; plainly loan-timeline material',
  'LoanSaleOfferLinked.loanId': 'TODO(#1794) — sale listing bound to a loan',
  'LoanSaleOfferLinked.offerId': 'TODO(#1794) — the same binding, sale-offer side (saleOfferId)',
  'LoanSaleListingTornDown.loanId': 'TODO(#1794) — sale listing withdrawn',
  'LoanSaleListingTornDown.offerId': 'TODO(#1794) — listing withdrawn, sale-offer side (saleOfferId)',
  LoanPreclosedDirect: 'TODO(#1794) — borrower early close-out',
  LoanObligationTransferred: 'TODO(#1794) — obligation handover to a replacement borrower',
  // The offset route. Both entered scope with the round-3 shape derivation: they
  // name their references `originalLoanId` / `newOfferId`, so the earlier
  // enumerated alias table could not see either event at all. `chainIndexer.ts`
  // already handles both for STATE (terminalising the loan, flagging the offset
  // vehicle) and `flipLoanStatus` even carries a `loanIdOverride` parameter
  // documented for `OffsetCompleted.originalLoanId` — so the indexer knew about
  // this naming before the guardrail did.
  'OffsetCompleted.loanId': 'TODO(#1794) — offset route completed; terminalises the original loan',
  'OffsetCompleted.offerId': 'TODO(#1794) — offset completion, vehicle-offer side (newOfferId)',
  'OffsetOfferCreated.loanId': 'TODO(#1794) — offset vehicle offer created against the original loan',
  'OffsetOfferCreated.offerId': 'TODO(#1794) — the offset vehicle offer itself (newOfferId)',
  CollateralAdded: 'TODO(#1794) — borrower collateral top-up',
  PartialCollateralWithdrawn: 'TODO(#1794) — surplus collateral release',
  CollateralConsolidated: 'TODO(#1794) — collateral consolidation to the NFT holder',
  HFLiquidationTriggered: 'TODO(#1794) — health-factor liquidation; the loans row IS flipped (#1293), only the activity reference is missing',
  LiquidationDiscounted: 'TODO(#1794) — twin of HFLiquidationTriggered',
  LoanPartiallyLiquidated: 'TODO(#1794) — partial liquidation',
  LiquidationFallback: 'TODO(#1794) — liquidation fallback entry',
  LiquidationFallbackSplit: 'TODO(#1794) — split-route liquidation fallback',
  LiquidationFallbackOracleUnavailable: 'TODO(#1794) — fallback taken because the oracle was unavailable',
  LoanFallbackPending: 'TODO(#1794) — fallback episode opened',
  LoanCuredFromFallback: 'TODO(#1794) — fallback episode cured',
  // Dual-carrying: split per field so mapping one cannot mask a regression on
  // the other (Codex round-1 P2).
  'BackstopFilled.loanId': 'TODO(#1794) — backstop fill against a loan',
  'BackstopFilled.offerId': 'TODO(#1794) — backstop fill, offer side',
  BackstopLoanClaimed: 'TODO(#1794) — backstop claim',
  LenderBackstopOptInSet: 'TODO(#1794) — per-loan backstop opt-in',
  BorrowerSurplusClaimed: 'TODO(#1794) — borrower surplus claim',
  ClaimRetryExecuted: 'TODO(#1794) — claim retry',
  SanctionedProceedsLocked: 'TODO(#1794) — proceeds withheld from a flagged party',
  'OfferSaleProceedsSplit.loanId': 'TODO(#1794) — proceeds split, loan side',
  'OfferSaleProceedsSplit.offerId': 'TODO(#1794) — proceeds split, offer side',
  'IntentMatched.loanId': 'TODO(#1794) — standing-intent match',
  'IntentMatched.offerId':
    'TODO(#1794) — standing-intent match, offer side; carries sliceOfferId AND counterpartyOfferId, so the slice must pick one and say why',
  'SignedOfferFilled.loanId': 'TODO(#1794) — gasless signed offer filled, loan side',
  'SignedOfferFilled.offerId': 'TODO(#1794) — gasless signed offer filled, offer side',
  'SignedOfferMatched.loanId': 'TODO(#1794) — gasless signed offer matched',
  'SignedOfferMatched.offerId':
    'TODO(#1794) — signed-offer match, offer side; same sliceOfferId / counterpartyOfferId choice as IntentMatched',
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

  // NB: FlashLoanLiquidationCompleted and LoanClaimedAndCompounded are NOT
  // listed. They exist only in standalone ABIs (FlashLoanLiquidator,
  // AggregatorAdapterImplementation) that the barrel never spreads into
  // DIAMOND_ABI, so no log carrying them can reach pluckActivityRefs. They were
  // phantom backlog admitted by an over-broad directory scan (Codex round-1 P2);
  // the stale-entry check now flags them if re-added.

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
// Membership comes from the barrel's `DIAMOND_ABI` spread list, NOT from every
// JSON in the directory (Codex round-1 P2). The directory also holds STANDALONE
// contracts the barrel imports and re-exports but deliberately does NOT spread —
// `AggregatorAdapterImplementation`, `FlashLoanLiquidator`. Their events can
// never reach `pluckActivityRefs`, because the indexer's `EVENT_ABI` is derived
// from `DIAMOND_ABI_VIEM`, so enforcing them manufactures phantom backlog that
// would grow with every future standalone contract. Enforced set == decodable set.
const REF_FIELDS = ['loanId', 'offerId'];

/**
 * Which ABI input names populate each reference COLUMN — DERIVED by shape, not
 * enumerated (Codex rounds 2 and 3).
 *
 * Round 2 established the scope was wrong: keying the enforced set on inputs
 * named exactly `loanId` / `offerId` made it an ABI naming coincidence rather
 * than a statement about what the ledger references. `OfferMatched` populates
 * `offer_id` from `args.lenderOfferId` and has no input called `offerId`, so
 * that mapping was never enforced; `LoanRefinanced` carries `oldLoanId` /
 * `newLoanId` and no exact `loanId`, so a whole event sat outside the guardrail.
 *
 * The round-2 fix was a hand-written six-name table, and round 3 found the
 * second batch of names missing from it — `loanIdA/B/C` on
 * `InternalMatchExecuted` (a live, deliberate mapping that was unguarded),
 * `originalLoanId` / `newOfferId` on both offset events, plus `saleOfferId`,
 * `sliceOfferId`, `counterpartyOfferId`. That is the same defect as round 2 with
 * a shorter list: an enumerated allowlist of reference names cannot be complete
 * by construction, so its completeness is exactly as unverified as the naming
 * assumption it replaced.
 *
 * So membership is derived from the input NAME SHAPE instead: an optional
 * qualifier, the column name, and an optional leg suffix. `oldLoanId`,
 * `originalLoanId`, `loanIdA` and `newOfferId` all resolve; a new event naming a
 * reference in any of these ways enters scope automatically. The failure mode
 * inverts — instead of silent under-coverage, a new name shows up as a visible
 * gap someone must map or allowlist with a reason.
 *
 * What this does NOT catch, stated because it is now the boundary worth
 * reviewing: a reference named without the column in it at all (`positionId`,
 * `matchRef`). No derivation from names can, and the same is true of a table. If
 * one appears, it needs an explicit entry in `REF_EXTRA_ALIASES` below — the
 * escape hatch exists so an unnameable case is recorded rather than invisible.
 *
 * Several ids may target one column (`loanIdA/B/C` → `loan_id`; the offset
 * events' original loan and new offer). Policy: the event CARRIES the column if
 * it has any alias, and the mapping must derive from one of them, with the
 * choice of leg documented at the mapping — `chainIndexer.ts` already does this
 * for leg A.
 */
const REF_SHAPE = {
  loanId: /^[A-Za-z0-9]*loanId(?:[A-C]|[0-9]+)?$/i,
  offerId: /^[A-Za-z0-9]*offerId(?:[A-C]|[0-9]+)?$/i,
};

/**
 * Escape hatch for a reference whose ABI name does not contain its column name,
 * so the shape rules above cannot see it. Empty today — every reference in the
 * compiled bundle is shape-derivable. Add here with a reason rather than
 * widening the regexes, which would start matching unrelated inputs.
 */
const REF_EXTRA_ALIASES = {
  loanId: [],
  offerId: [],
};

/** Does this ABI input name populate `field`? */
const isAliasOf = (field, name) =>
  typeof name === 'string' &&
  (REF_SHAPE[field].test(name) || REF_EXTRA_ALIASES[field].includes(name));

/**
 * The barrel, with comments stripped (Codex round-4 P2).
 *
 * The spread and import patterns below are text matches, so a member disabled
 * by commenting it out — `// ...OfferMatchFacetABI`, the natural way to remove
 * one — still read as live. The enforced set then included a facet the indexer
 * no longer decodes, every mapping and exemption for it stayed falsely current,
 * and the event count did not budge. Same defect as the commented-out mapping in
 * `pluckActivityRefs` (round 1): I stripped comments there and not here.
 *
 * Line comments are cut only where `//` is not part of `://`, so a URL inside a
 * string survives.
 */
const barrelSrc = readFileSync(join(ABI_DIR, 'index.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/**
 * `import FooABI from './Foo.json'` → identifier -> filename. Either quote
 * style: a member whose import this cannot read becomes an unresolved spread,
 * which is now a hard failure rather than a silent omission.
 */
const importedFile = new Map();
for (const m of barrelSrc.matchAll(/import\s+([A-Za-z0-9_]+)\s+from\s+['"]\.\/([^'"]+\.json)['"]/g)) {
  importedFile.set(m[1], m[2]);
}

const diamondBlock = barrelSrc.match(/export const DIAMOND_ABI\s*=\s*\[([\s\S]*?)\n\]/);
if (!diamondBlock) {
  console.error(
    '[check-activity-refs-coverage] could not locate the DIAMOND_ABI array in the abis barrel.\n' +
      'If it was restructured, update this script — do not delete the check.',
  );
  process.exit(1);
}
/**
 * Every spread must resolve to a file (Codex round-3 P2).
 *
 * Skipping an unresolvable member and only guarding `length === 0` means losing
 * ONE facet leaves the check green while every reference-bearing event in it
 * drops out of coverage. The realistic trigger is a member this script's import
 * regex cannot read — a locally constructed ABI constant, or (before the quote
 * class below) an import written with double quotes. A vacuity guard has to be
 * per-item, not per-run.
 */
const memberFiles = [];
const unresolvedMembers = [];
for (const m of diamondBlock[1].matchAll(/\.\.\.([A-Za-z0-9_]+)/g)) {
  const file = importedFile.get(m[1]);
  if (file) memberFiles.push(file);
  else unresolvedMembers.push(m[1]);
}
if (unresolvedMembers.length) {
  console.error(
    `\n✖ activity-refs coverage: ${unresolvedMembers.length} DIAMOND_ABI member(s) could not be\n` +
      '  resolved to an ABI file, so their events would silently leave coverage:\n',
  );
  for (const id of unresolvedMembers) console.error(`    ...${id}`);
  console.error(
    '\n  Each must be a `import X from \'./X.json\'` this script can follow. If the barrel\n' +
      '  now builds an ABI in TypeScript, teach this script to resolve it — do not let the\n' +
      '  member drop.\n',
  );
  process.exit(1);
}
if (memberFiles.length === 0) {
  console.error(
    '[check-activity-refs-coverage] resolved zero DIAMOND_ABI members — refusing to pass vacuously.',
  );
  process.exit(1);
}

/** eventName -> Set<field> */
const carries = new Map();
/** eventName -> Map<field, Set<ABI input name that can populate it>> */
const aliasNames = new Map();
for (const file of memberFiles) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(ABI_DIR, file), 'utf8'));
  } catch {
    continue;
  }
  const items = Array.isArray(parsed) ? parsed : parsed.abi;
  if (!Array.isArray(items)) continue;
  for (const item of items) {
    if (item?.type !== 'event' || !Array.isArray(item.inputs)) continue;
    const names = item.inputs.map((i) => i?.name);
    for (const field of REF_FIELDS) {
      const aliases = names.filter((n) => isAliasOf(field, n));
      if (aliases.length === 0) continue;
      if (!carries.has(item.name)) carries.set(item.name, new Set());
      carries.get(item.name).add(field);
      // Kept per event+field for the mapping check below, which must confirm the
      // returned expression reads one of THESE inputs (Codex round-3 P2).
      if (!aliasNames.has(item.name)) aliasNames.set(item.name, new Map());
      aliasNames.get(item.name).set(field, new Set(aliases));
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
/**
 * The function body with comments stripped ONCE, before any parsing.
 *
 * Round 1 stripped comments per case-chunk, which left every structural decision
 * — where cases begin, where `default:` ends the last one — reading raw text. Two
 * consequences, the second found while fixing the first:
 *
 *   · a comment mentioning `case 'Foo':` invents a label and a phantom chunk;
 *   · the `default:` clamp below latched onto the words "falls to `default:`"
 *     inside the #1782 comment, 8.5k characters before the real one.
 *
 * Comments cannot be a structural input. Line comments are cut only where `//`
 * is not part of `://`, so a URL in a string survives.
 */
const body = fnMatch[0]
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/**
 * Split the switch into per-case blocks. Consecutive `case 'A': case 'B':`
 * labels share one return, so labels accumulate until a block with a body.
 */
/** eventName -> Set<field it returns non-null> */
const mapped = new Map();
/** Mappings that look present but do not unconditionally read a real alias. */
const suspectMappings = [];
{
  // Either quote style (Codex round-5 P2). A `case "LoanSold":` — valid
  // TypeScript, and what a reformat or a different author produces — was never
  // discovered, so the event's allowlist entry stayed falsely live and went on
  // masking a later removal of the very mapping that should have retired it.
  // Fixing a TODO has to trip the stale-entry check, or the allowlist rots.
  const CASE_RE = /case\s+['"]([A-Za-z0-9_]+)['"]\s*:/g;
  const labels = [];
  let m;
  const positions = [];
  while ((m = CASE_RE.exec(body)) !== null) positions.push({ name: m[1], end: m.index + m[0].length });
  // `default:` terminates the last case's chunk. Without this the final case
  // runs to the end of the function and absorbs the default clause's
  // `{ actor: null, loanId: null, offerId: null }` — which the every-path rule
  // below then reads as a nullable fallback belonging to that case. Found by
  // that rule flagging `PrepayListingMatched.loanId`, a mapping that is in fact
  // correct and unconditional: the defect was in this splitter, not the indexer.
  const defaultIdx = body.search(/\bdefault\s*:/);
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].end;
    let stop = i + 1 < positions.length ? positions[i + 1].end : body.length;
    if (defaultIdx !== -1 && defaultIdx > start && defaultIdx < stop) stop = defaultIdx;
    const chunk = body.slice(start, stop);
    labels.push(positions[i].name);
    // A fall-through label has nothing but whitespace before the next case.
    if (!/\S/.test(chunk.replace(/case\s+['"][A-Za-z0-9_]+['"]\s*:/g, ''))) continue;

    // Already comment-free: `body` is stripped once, above. That is what closes
    // Codex round-1 P2 — a mapping left commented out by a refactor, sitting
    // above a live `loanId: null`, used to be the first match and read as mapped,
    // so the regression this script exists to catch passed green.
    const code = chunk;

    // EVERY return path, not just the first (Codex round-5 P2).
    //
    // Restricting to the returned object keeps an unrelated `loanId:` in a
    // local literal from standing in for the return — but reading only the FIRST
    // returned object meant a case shaped like
    //
    //     if (ok) return { actor, loanId: Number(args.loanId as bigint), ... };
    //     return { actor: null, loanId: null, offerId: null };
    //
    // was marked mapped off the happy path while the fallback wrote NULL. The
    // shape rule from round 4 did not establish an unconditional read after all,
    // because "unconditional" is a property of ALL paths and I was checking one.
    //
    // A `return` this cannot parse as an object literal is reported rather than
    // ignored, so an unparsed path cannot pass as a clean one.
    const retObjects = [...code.matchAll(/return\s*\{([\s\S]*?)\}\s*;/g)].map((r) => r[1]);
    const returnCount = (code.match(/\breturn\b/g) ?? []).length;
    const unparsedReturns = returnCount - retObjects.length;
    const scopes = retObjects.length > 0 ? retObjects : [code];

    /**
     * A mapping counts only if it UNCONDITIONALLY reads one of the event's own
     * ABI aliases (Codex round-3 P2).
     *
     * Accepting anything but a literal leading `null` let a nullable or
     * misspelled expression stand in for a real mapping:
     *
     *     offerId: args.offerID == null ? null : Number(args.offerID as bigint)
     *
     * `offerID` is not in the decoded args, so every row gets `offer_id = NULL`
     * — exactly the state this guardrail exists to detect — while TypeScript and
     * the old check both stayed green. A field-name typo is the realistic
     * version. So two conditions now: the expression must name an accepted alias
     * for THIS event, and must not be able to resolve to null.
     *
     * Reported per case rather than silently un-counted: a mapping that looks
     * present but fails these tests is a likelier bug than an absent one.
     */
    // Per label, not shared: consecutive `case 'A': case 'B':` labels share one
    // return statement but are different events, so they can accept different
    // aliases — one may legitimately map from the shared expression while the
    // other does not carry that reference at all.
    for (const label of labels) {
      const fields = new Set();
      for (const field of REF_FIELDS) {
        // One expression per return path that names this field.
        const exprs = scopes
          .map((s) => s.match(new RegExp(`\\b${field}\\s*:\\s*([^,\\n]+)`)))
          .filter(Boolean)
          .map((h) => h[1].trim());
        if (exprs.length === 0) continue;
        // Deliberately unmapped on every path.
        if (exprs.every((e) => /^null\b/.test(e))) continue;

        const accepted = aliasNames.get(label)?.get(field);
        if (!accepted || accepted.size === 0) continue; // event carries no such ref

        // Accept only the exact shape every live mapping already uses:
        //   Number(args.<accepted alias> as bigint)
        //
        // A POSITIVE shape rule, not a blacklist (Codex round-4 P2). Round 3
        // rejected a leading literal `null`; round 4 slipped
        // `args.offerID == null ? (null) : Number(args.lenderOfferId as bigint)`
        // past it — the accepted alias appears, and the parenthesised `null`
        // dodged the pattern, so a misspelled condition wrote NULL to every row
        // while the check read green. Each round I widened the blacklist and
        // each round a new decoration walked through it, which is the argument
        // for enumerating what is ALLOWED instead: a shape cannot be satisfied
        // by wrapping, and "unconditionally reads a decoded argument" is
        // precisely what this shape expresses.
        //
        // Deliberately narrow. A future mapping needing a different form (an
        // offset event picking one of two aliases still fits; something genuinely
        // computed does not) is REPORTED, not silently dropped, and widening it
        // is then a conscious edit here rather than an accident.
        //
        // Applied to EVERY return path (round 5): the weakest path decides, so a
        // guarded happy path plus a null fallback is not an unconditional read.
        const badExpr = exprs.find((e) => {
          const shapeOk = [...accepted].some((alias) =>
            new RegExp(`^Number\\(\\s*args\\.${alias}(\\s+as\\s+bigint)?\\s*\\)$`).test(e),
          );
          // Belt and braces: `null` anywhere in a mapping expression means the
          // column can end up empty, whatever the surrounding syntax.
          return !shapeOk || /\bnull\b/.test(e);
        });
        const expr = badExpr ?? exprs[0];
        const mentionsNull = badExpr !== undefined && /\bnull\b/.test(badExpr);

        if (badExpr === undefined && unparsedReturns === 0) {
          fields.add(field);
        } else {
          suspectMappings.push({
            event: label,
            field,
            expr,
            why: mentionsNull
              ? 'can resolve to null'
              : badExpr === undefined
                ? `${unparsedReturns} return path(s) in this case could not be read as an object literal`
                : `not an unconditional read of an accepted alias (${[...accepted].join(' / ')})`,
          });
        }
      }
      mapped.set(label, fields);
    }
    labels.length = 0;
  }
}

// ── 2b. Dual-carrying events must be exempted per field ────────────────
// Codex round-1 P2. An event-wide key exempts BOTH references, and the stale
// check below only fires when EVERY carried field is mapped. So for an event
// carrying both, a slice that maps only `loanId` leaves the event-wide entry
// live, and a later regression dropping that mapping is silently re-covered by
// it — defeating the per-field guarantee this script advertises. Requiring
// `Event.loanId` / `Event.offerId` keys for dual-carrying events also makes the
// summary count exemptions in the same unit it reports gaps.
const wideOnDual = [];
for (const key of Object.keys(DELIBERATELY_NOT_SCOPED)) {
  if (key.includes('.')) continue;
  const fields = carries.get(key);
  if (fields && fields.size > 1) wideOnDual.push(key);
}
if (wideOnDual.length) {
  console.error(
    '\n✖ activity-refs coverage: these events carry BOTH loanId and offerId, so an\n' +
      '  event-wide allowlist entry would mask a per-field regression. Split each into\n' +
      "  '<Event>.loanId' and '<Event>.offerId' entries:\n",
  );
  for (const k of wideOnDual) console.error(`    ${k} (carries ${[...carries.get(k)].join(', ')})`);
  console.error('');
  process.exit(1);
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
  // Codex round-1 P2: a field-specific key must be checked against THAT field.
  // Testing only that some reference-bearing `Foo` exists leaves a `Foo.loanId`
  // exemption live after an ABI revision drops `loanId` but keeps `offerId` —
  // an obsolete exemption that never reports stale, contradicting the guarantee.
  if (field && !has.has(field)) {
    dead.push(`${key} — the event no longer carries ${field}; remove this entry`);
    continue;
  }
  const fields = field ? [field] : [...has];
  if (fields.every((f) => mapped.get(event)?.has(f))) {
    dead.push(`${key} — now mapped in pluckActivityRefs; remove this entry`);
  }
}

if (gaps.length || dead.length || suspectMappings.length) {
  if (suspectMappings.length) {
    console.error(
      `\n✖ activity-refs coverage: ${suspectMappings.length} mapping(s) look present but do not\n` +
        '  unconditionally read one of the event\'s decoded arguments, so the column would be\n' +
        '  NULL at runtime while the code reads as mapped:\n',
    );
    for (const s of suspectMappings) {
      console.error(`    ${s.event}.${s.field} — ${s.why}\n      ${s.expr}`);
    }
  }
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

// Print what the shape rules actually resolved. Derivation replaced a
// hand-written alias table precisely because a list's completeness cannot be
// verified by reading it; the derived set is only reviewable if it is visible,
// so a new reference name shows up here rather than being taken on trust.
for (const field of REF_FIELDS) {
  const found = new Set();
  for (const perField of aliasNames.values()) {
    for (const alias of perField.get(field) ?? []) found.add(alias);
  }
  console.log(`  ${field} ← ${[...found].sort().join(', ')}`);
}
console.log(
  `✓ activity-refs coverage OK — ${carries.size} event(s) carry a reference; ` +
    `${mappedFields} field(s) mapped, ${allowlisted} allowlisted (${todo} of those are TODO(#1794) gaps awaiting mapping).`,
);
