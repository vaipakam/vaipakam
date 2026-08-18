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
/**
 * Validated below: every entry must carry a NON-EMPTY reason.
 *
 * Membership-only checks accepted `''` (Codex round-12 P2), which silently turns
 * "deliberately unscoped, and here is why" into "unscoped" — the exact thing the
 * TODO marker exists to prevent, achieved by deleting the text rather than
 * omitting the entry.
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
  // The two loan-side entries carry the SAME open choice as the refinance: an
  // offset leaves the original loan and the position that replaces it, against one
  // loan_id column. The two offer-side entries do not — `newOfferId` is
  // unambiguously the vehicle offer — so they are ordinary TODOs.
  'OffsetCompleted.loanId':
    'TODO(#1794) — offset completed; needs the same original-vs-replacement decision as the refinance for the single loan_id column',
  'OffsetCompleted.offerId': 'TODO(#1794) — offset completion, vehicle-offer side (newOfferId)',
  'OffsetOfferCreated.loanId':
    'TODO(#1794) — offset vehicle offer created; same original-vs-replacement decision as above',
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
  'OfferCreatedDetails.offerId': 'companion payload to OfferCreated, which is offer-scoped already',
  // Entered scope with the round-6 tuple traversal: the loan reference is
  // `fields.refinanceTargetLoanId`, nested in the terms struct. Marked TODO
  // rather than exempt because it is a genuine question, not a companion-payload
  // case like the offer side: that id is the loan a refinance offer TARGETS, not
  // a loan this event happened to. Filing the row under it would put an offer
  // creation on the target loan's timeline, which may well be what a reader
  // wants — but that is a product call for the slice that makes it.
  'OfferCreatedDetails.loanId':
    'TODO(#1794) — refinance TARGET loan inside the terms tuple; scoping it puts an offer creation on that loan timeline, which needs a deliberate decision',
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
  // Any UPPERCASE leg letter or digits — not just A-C (Codex round-13 P2). The
  // three-way match happens to use A/B/C today, and baking that in meant a
  // fourth leg (`loanIdD`) matched neither the shape nor the empty escape list,
  // so it could be filed NULL with no mapping and no exemption. An enumerated
  // range inside a derivation is the same mistake as the enumerated alias table
  // this shape rule replaced, just smaller.
  //
  // Uppercase deliberately: `loanIds` (a plural, i.e. an array) is not a single
  // reference and must not be treated as one.
  // The column name matches either case (`loanId`, `oldLoanId`), but the leg
  // suffix must be UPPERCASE so a plural like `loanIds` — an array, not a single
  // reference — is not treated as one.
  loanId: /^[A-Za-z0-9_]*[Ll]oanId(?:[A-Z]|[0-9]+)?$/,
  offerId: /^[A-Za-z0-9_]*[Oo]fferId(?:[A-Z]|[0-9]+)?$/,
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

/**
 * Names the accepted mapping shape depends on. A local binding OR a write to
 * either one makes `Number(args.x)` mean something this checker cannot resolve.
 */
const SHADOWABLE_NAMES = new Set(['args', 'Number']);

/** Does a binding name — plain or destructured — bind `wanted`? */
const bindsName = (name, wanted) => {
  if (!name) return false;
  if (ts.isIdentifier(name)) return name.text === wanted;
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.some((el) => ts.isBindingElement(el) && bindsName(el.name, wanted));
  }
  return false;
};

/** Does a binding name — plain or destructured — bind one of those names? */
const bindsShadowable = (name) => {
  if (!name) return false;
  if (ts.isIdentifier(name)) return SHADOWABLE_NAMES.has(name.text);
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.some((el) => ts.isBindingElement(el) && bindsShadowable(el.name));
  }
  return false;
};

/**
 * Is this node a WRITE to one of those names? Any assignment operator, and the
 * increment/decrement forms (Codex round-14 P2) — `args.loanId &&= 0n` and
 * `args.loanId++` rebind the decoded value just as `=` does, and a check for
 * `EqualsToken` alone sees none of them.
 */
const mutatesShadowable = (n) => {
  // Assertions and parentheses are unwrapped at EVERY step, the same way
  // `readsArgPath` learned to in round 10. `args` is typed `Record<string,
  // unknown>`, so the natural way to write a mutation is
  // `(args as any).loanId = 0n` — and a walk that only peels property access
  // stops at the ParenthesizedExpression and reports no write at all.
  const rootOf = (expr) => {
    let t = expr;
    for (;;) {
      if (ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t)) t = t.expression;
      else if (ts.isParenthesizedExpression(t) || ts.isAsExpression(t) || ts.isTypeAssertionExpression?.(t)) t = t.expression;
      else if (ts.isNonNullExpression(t) || ts.isSatisfiesExpression?.(t)) t = t.expression;
      else return t;
    }
  };
  // An ASSIGNMENT PATTERN is a binary assignment whose left side is an object or
  // array literal (Codex round-15 P2): `({ loanId: args.loanId } = { loanId: 0n })`
  // rebinds the decoded value exactly like `args.loanId = 0n`, but `rootOf` walks
  // property access and never reaches the target nested inside the literal. The
  // pattern is therefore descended, and its leaves are tested the ordinary way.
  const targetWrites = (expr) => {
    if (!expr) return false;
    if (ts.isParenthesizedExpression(expr)) return targetWrites(expr.expression);
    if (ts.isObjectLiteralExpression(expr)) {
      return expr.properties.some((p) => {
        if (ts.isPropertyAssignment(p)) return targetWrites(p.initializer);
        if (ts.isShorthandPropertyAssignment(p)) return SHADOWABLE_NAMES.has(p.name.text);
        if (ts.isSpreadAssignment(p)) return targetWrites(p.expression);
        return false;
      });
    }
    if (ts.isArrayLiteralExpression(expr)) {
      return expr.elements.some((e) =>
        ts.isSpreadElement(e) ? targetWrites(e.expression) : targetWrites(e),
      );
    }
    // `[args = fallback]` inside a pattern: the default is not the target.
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return targetWrites(expr.left);
    }
    const t = rootOf(expr);
    return ts.isIdentifier(t) && SHADOWABLE_NAMES.has(t.text);
  };
  if (ts.isBinaryExpression(n) && ts.isAssignmentOperator?.(n.operatorToken.kind)) {
    return targetWrites(n.left);
  }
  if (
    (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
    (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    const t = rootOf(n.operand);
    return ts.isIdentifier(t) && SHADOWABLE_NAMES.has(t.text);
  }
  return false;
};

/** Escape every regex metacharacter, so a name can only match itself. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
/**
 * And the array may contain NOTHING BUT spreads (Codex round-15 P2).
 *
 * The loop above only looks for `...X`, so a direct element — an event object
 * written inline, or an identifier without a spread — is neither resolved nor
 * rejected. `EVENT_ABI` still decodes it at runtime, so the enforced set ends up
 * smaller than the decoded set: exactly the "silently outside coverage" shape
 * the per-item guard above exists to prevent, arriving through the other door.
 * Removing every spread must leave only separators behind.
 */
const abiResidue = diamondBlock[1].replace(/\.\.\.[A-Za-z0-9_]+/g, '').trim();
if (/[^\s,]/.test(abiResidue)) {
  console.error(
    '\n✖ activity-refs coverage: DIAMOND_ABI contains entries that are not spreads of an\n' +
      '  imported ABI file, so this script cannot tell what events they carry while\n' +
      '  EVENT_ABI still decodes them:\n\n' +
      // Printed verbatim rather than split on commas: the residue is whatever
      // is left once the spreads are removed, and an object literal's own
      // commas would chop it into fragments that read like separate entries.
      // Printed verbatim rather than split on commas: the residue is whatever is
      // left once the spreads are removed, and an object literal's own commas
      // would chop it into fragments that read like separate entries. The
      // separator-only lines each removed spread leaves behind are dropped.
      abiResidue
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /[^\s,]/.test(l))
        .map((l) => `    ${l.length > 160 ? `${l.slice(0, 157)}…` : l}`)
        .join('\n') +
      '\n\n  Move the entry into an ABI JSON and spread it, or teach this script to read it —\n' +
      '  do not let an event into the decoded set that coverage cannot see.\n',
  );
  process.exit(1);
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
/**
 * eventName -> Set<every decoded argument path the event has.
 *
 * Not just the reference-shaped ones: this is what lets a mapping reading an
 * argument the event NO LONGER HAS be reported (Codex round-7 P2), rather than
 * skipped because the event dropped out of the reference-carrying set entirely.
 */
const eventInputs = new Map();
/** ABI-side problems: overloaded signatures, reference names that aren't numeric. */
const abiConflicts = [];
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
    // Tuple components too, carrying the decoded ACCESS PATH (Codex round-6 P2).
    // Collecting only top-level input names left references nested in a struct
    // outside coverage entirely — and one is live in the current ABI:
    // `OfferCreatedDetails` carries `fields.refinanceTargetLoanId`, so the event
    // was enforced for its top-level `offerId` and never asked about the loan.
    // The path is what the mapping check needs, since the indexer would read it
    // as `args.fields.refinanceTargetLoanId`.
    const names = [];
    /** path -> ABI type, so a reference can be required to be numeric. */
    const typeOf = new Map();
    const collect = (inputs, prefix) => {
      for (const i of inputs ?? []) {
        if (!i?.name) {
          // An UNNAMED input carrying named components is reported, not skipped
          // (Codex round-17 P2). Skipping it dropped every reference underneath
          // — a `uint256 loanId` inside an unnamed tuple left the event in the
          // decoded set and outside coverage, with the tally unchanged. There is
          // no access path this checker can name for it (the indexer would have
          // to read it positionally), so the honest answer is that this shape is
          // unsupported rather than that the event carries nothing.
          if (Array.isArray(i?.components) && i.components.some((c) => c?.name)) {
            abiConflicts.push({
              kind: 'unnamed-tuple',
              event: item.name,
              message: `${item.name} — an unnamed input carries named components (${i.components
                .filter((c) => c?.name)
                .map((c) => c.name)
                .join(', ')}); this checker cannot name an access path for them, so any reference inside would silently leave coverage`,
            });
          }
          continue;
        }
        const path = prefix ? `${prefix}.${i.name}` : i.name;
        names.push(path);
        typeOf.set(path, i.type ?? '');
        if (Array.isArray(i.components)) collect(i.components, path);
      }
    };
    collect(item.inputs, '');

    // An overloaded event name is two different argument bags reaching ONE case
    // (Codex round-8 P2). `decodeEventLog` can produce either, so a mapper keyed
    // on the name cannot be right for both unless they agree. Rejected rather
    // than silently collapsed to whichever signature was parsed last.
    const priorInputs = eventInputs.get(item.name);
    if (priorInputs) {
      const differs =
        priorInputs.size !== names.length || names.some((n) => !priorInputs.has(n));
      if (differs) {
        abiConflicts.push({
          kind: 'overload',
          event: item.name,
          message: `${item.name} — two ABI signatures with different arguments (${[...priorInputs].join(', ')} vs ${names.join(', ')}); a name-keyed mapper cannot be correct for both`,
        });
      }
    }
    eventInputs.set(item.name, new Set(names));
    for (const field of REF_FIELDS) {
      // Shape-matching applies to the LAST path segment: `fields.newLoanId` is a
      // loan reference for the same reason `newLoanId` is.
      const aliases = names.filter((n) => isAliasOf(field, n.split('.').pop()));
      // A reference must also DECODE as a number (Codex round-8 P2). The accepted
      // mapping shape is `Number(args.x as bigint)`, so a reference-shaped name
      // typed `bytes32` or `address` would hand viem a hex string and persist an
      // imprecise or out-of-range value. Name shape says "this is meant to be a
      // reference"; the type says "and it can actually be read as one".
      const numeric = aliases.filter((a) => /^u?int(\d+)?$/.test(typeOf.get(a) ?? ''));
      const nonNumeric = aliases.filter((a) => !numeric.includes(a));
      for (const a of nonNumeric) {
        abiConflicts.push({
          kind: 'nonNumericReference',
          event: item.name,
          message: `${item.name}.${a} — named like a ${field} reference but typed '${typeOf.get(a)}', which the Number(args…) mapping shape cannot read as an id`,
        });
      }
      if (numeric.length === 0) continue;
      if (!carries.has(item.name)) carries.set(item.name, new Set());
      carries.get(item.name).add(field);
      // Kept per event+field for the mapping check below, which must confirm the
      // returned expression reads one of THESE inputs (Codex round-3 P2).
      if (!aliasNames.has(item.name)) aliasNames.set(item.name, new Map());
      aliasNames.get(item.name).set(field, new Set(numeric));
    }
  }
}

// Every allowlist entry must state a reason (Codex round-12 P2).
{
  const blank = Object.entries(DELIBERATELY_NOT_SCOPED)
    .filter(([, reason]) => typeof reason !== 'string' || reason.trim() === '')
    .map(([key]) => key);
  if (blank.length) {
    console.error(
      '\n✖ activity-refs coverage: allowlist entries with no stated reason:\n',
    );
    for (const k of blank) console.error(`    ${k}`);
    console.error(
      '\n  An exemption without a reason is an undocumented gap wearing the word\n' +
        '  "deliberately". Give it a reason, or a TODO(#1794) marker if it is a gap.\n',
    );
    process.exit(1);
  }
}

// ── 2. What pluckActivityRefs actually maps, per field ──────────────────
/**
 * Parsed with the TypeScript compiler, not with regexes.
 *
 * The regex version of this section survived eight review rounds, and every one
 * of them found another way for text to satisfy it while the indexer did
 * something else: a commented-out mapping, a `case "X":` in the other quote
 * style, a second return path, a parenthesised `null`, a spread, an unbraced
 * guard that falls through, a `loanId:` nested inside another object literal.
 * Each fix was correct and none of them ended the class, because "does this
 * source text mean what I think" is not a question a regex can answer — the
 * supply of decorations is unbounded, and every one of them reports GREEN.
 *
 * `typescript` is already a devDependency here and `tsc` already runs in the
 * same `typecheck` chain, so parsing properly costs no new dependency. The AST
 * answers all of those structurally: comments are not nodes; a case label is a
 * string literal whatever quotes it was written with; `return` statements are
 * enumerable; a spread is a distinct node kind; property lookup is top-level by
 * construction; and whether control can leave a clause is a statement question,
 * not a suffix-matching one.
 */
const ts = (await import('typescript')).default;

/**
 * Every node kind that opens a new `this`/scope boundary a walk must not cross.
 * Declared here — immediately after `ts` exists — because the switch-discovery
 * walk below is the FIRST consumer; a later `const` would be in its temporal
 * dead zone and crash the whole check.
 */
const isFunctionLike = (node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isClassDeclaration(node) ||
  ts.isClassExpression(node);

const src = readFileSync(CHAIN_INDEXER, 'utf8');
const sourceFile = ts.createSourceFile(CHAIN_INDEXER, src, ts.ScriptTarget.Latest, true);

/** Find `function pluckActivityRefs(...)`. */
let fnNode = null;
const findFn = (node) => {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'pluckActivityRefs') fnNode = node;
  if (!fnNode) ts.forEachChild(node, findFn);
};
ts.forEachChild(sourceFile, findFn);
if (!fnNode) {
  console.error(
    '[check-activity-refs-coverage] could not locate pluckActivityRefs() in chainIndexer.ts.\n' +
      'If it was renamed or moved, update this script — do not delete the check.',
  );
  process.exit(1);
}

/**
 * The switch on the event name.
 *
 * The DISCRIMINANT is checked, not just the shape (Codex round-15 P2). Every case
 * label in this switch is read as an event name, so a switch on anything else
 * makes each label mean something different while the tally stays identical —
 * `switch (String(args.kind))` kept the check green at 92/39/66 even though
 * decoded arguments carry no `kind` and every event fell to the all-null default.
 * The parameter is read off the function rather than hardcoded, so renaming it is
 * not a false failure.
 */
const eventNameParam = fnNode.parameters?.[0]?.name;
const discriminantName =
  eventNameParam && ts.isIdentifier(eventNameParam) ? eventNameParam.text : null;
/** Unwrap parens/assertions so `(eventName as string)` still resolves. */
const bareIdentifierOf = (expr) => {
  let t = expr;
  while (
    t &&
    (ts.isParenthesizedExpression(t) ||
      ts.isAsExpression(t) ||
      ts.isNonNullExpression(t) ||
      ts.isSatisfiesExpression?.(t) ||
      ts.isTypeAssertionExpression?.(t))
  ) {
    t = t.expression;
  }
  return t && ts.isIdentifier(t) ? t.text : null;
};
/**
 * The name must still MEAN the parameter (Codex round-16 P2).
 *
 * A comparison by name alone accepts `const eventName = String(args.kind)`
 * declared in a nested block and switched on there — the identifier matches, the
 * binding does not, and every decoded event falls past the cases. Resolving
 * bindings properly needs a type checker; refusing on any redeclaration of the
 * name inside the mapper costs nothing real, because shadowing the very
 * parameter this function dispatches on has no legitimate use.
 */
let shadowsDiscriminant = false;
if (discriminantName && fnNode.body) {
  const findShadow = (n) => {
    if (shadowsDiscriminant) return;
    // The declaration's OWN NAME is tested BEFORE declining to walk its body
    // (Codex round-17 P2). `isFunctionLike` covers function and class
    // declarations, so an early return placed above this test made it
    // unreachable for exactly the two kinds that declare a name in the
    // enclosing scope — `function eventName() {}` shadows just as a `const`
    // does, and skipping it because it is "a nested function" reads the wrong
    // scope. Same mistake this file made in round 11, in a different walk.
    if (
      (ts.isVariableDeclaration(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isClassDeclaration(n) ||
        ts.isParameter(n)) &&
      bindsName(n.name, discriminantName)
    ) {
      shadowsDiscriminant = true;
      return;
    }
    if (isFunctionLike(n)) return; // a nested function's own scope cannot reach here
    ts.forEachChild(n, findShadow);
  };
  ts.forEachChild(fnNode.body, findShadow);
}
if (shadowsDiscriminant) {
  console.error(
    `[check-activity-refs-coverage] pluckActivityRefs() redeclares \`${discriminantName}\` inside\n` +
      '  its own body, so a switch on that name need not be switching on the decoded\n' +
      '  event name at all. Every case label here is read as an EVENT NAME, so this\n' +
      '  checker cannot tell the two apart. Rename the local — do not delete the check.',
  );
  process.exit(1);
}

let switchNode = null;
let sawOtherSwitch = null;
const findSwitch = (node) => {
  if (switchNode) return;
  // Never descend into a nested function (Codex round-14 P2). Otherwise an
  // uncalled local helper's switch satisfies the entire coverage check while
  // `pluckActivityRefs` itself returns the all-null object — the checker would be
  // validating dead code and reporting the live path as fully mapped.
  if (isFunctionLike(node)) return;
  if (ts.isSwitchStatement(node)) {
    // Keep LOOKING past a switch on something else rather than rejecting outright:
    // a future mapper may legitimately switch on a sub-key first. Only when no
    // switch in the body discriminates on the event-name parameter is this a
    // failure, and the one that was rejected is named so the message is actionable.
    if (discriminantName && bareIdentifierOf(node.expression) === discriminantName) {
      switchNode = node;
      return;
    }
    if (!sawOtherSwitch) sawOtherSwitch = node.expression.getText();
  }
  ts.forEachChild(node, findSwitch);
};
/**
 * ...and the switch must be REACHABLE (Codex round-16 P2).
 *
 * Round 14 stopped a switch in an uncalled helper from standing in for the live
 * path. The same substitution works one level up: a `return { …all null }` placed
 * immediately above the live switch leaves it syntactically present and never
 * executed, and every count stays identical. Statement order at the top level is
 * enough to see it — an unconditional exit before the switch means nothing after
 * it runs. Conditional exits are fine and common, so only a bare `return`/`throw`
 * statement counts.
 */
/**
 * Does control definitely leave the function at this statement? Followed THROUGH
 * blocks and if/else (Codex round-17 P2): a bare `{ return { …null }; }` placed
 * before the switch exits just as surely as a top-level return, and a node-kind
 * test on the statement itself sees a Block and moves on. Same shape as
 * `alwaysExits` further down, declared here because this walk runs first.
 */
const exitsFunction = (st) => {
  if (!st) return false;
  if (ts.isReturnStatement(st) || ts.isThrowStatement(st)) return true;
  if (ts.isBlock(st)) return st.statements.some(exitsFunction);
  if (ts.isLabeledStatement(st)) return exitsFunction(st.statement);
  if (ts.isIfStatement(st)) {
    return (
      Boolean(st.elseStatement) && exitsFunction(st.thenStatement) && exitsFunction(st.elseStatement)
    );
  }
  if (ts.isTryStatement(st)) {
    // The finally block runs whatever happens, so an exit there is unconditional.
    return Boolean(st.finallyBlock) && exitsFunction(st.finallyBlock);
  }
  return false;
};
if (fnNode.body) {
  for (const st of fnNode.body.statements) {
    if (!switchNode) findSwitch(st);
    if (switchNode) break;
    if (exitsFunction(st)) {
      console.error(
        '[check-activity-refs-coverage] pluckActivityRefs() leaves unconditionally before\n' +
          '  its event switch, so the switch never runs and every event would be stored with\n' +
          '  all references NULL — while this check reads the cases and reports them mapped.\n' +
          '  Remove the early exit, or update this script — do not delete the check.',
      );
      process.exit(1);
    }
  }
}
if (!switchNode) {
  console.error(
    sawOtherSwitch
      ? '[check-activity-refs-coverage] pluckActivityRefs() has a switch, but on\n' +
          `  \`${sawOtherSwitch}\` — not on its event-name parameter` +
          (discriminantName ? ` \`${discriminantName}\`.\n` : '.\n') +
          '  Every case label here is read as an EVENT NAME, so a different discriminant\n' +
          '  silently changes what each label means while the coverage tally stays the\n' +
          '  same. Restore the dispatch, or update this script — do not delete the check.'
      : '[check-activity-refs-coverage] pluckActivityRefs() no longer contains a switch.\n' +
          'If its shape changed, update this script — do not delete the check.',
  );
  process.exit(1);
}

/** eventName -> Set<field it returns non-null on every path> */
const mapped = new Map();
/** Mappings that look present but do not unconditionally read a real alias. */
const suspectMappings = [];
/** Structural problems in the switch itself. */
const structural = [];

/**
 * Does this clause definitely leave the switch?
 *
 * A clause falls through when control can reach its end, which is a property of
 * its LAST statement — not of whether a `return` appears somewhere inside it.
 * An `if` without an `else` never qualifies, which is exactly the unbraced-guard
 * case; an if/else where both arms return does.
 */
const alwaysExits = (stmt) => {
  if (!stmt) return false;
  if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)) return true;
  if (ts.isBreakStatement(stmt) || ts.isContinueStatement(stmt)) return true;
  if (ts.isBlock(stmt)) return alwaysExits(stmt.statements[stmt.statements.length - 1]);
  if (ts.isIfStatement(stmt)) {
    return Boolean(stmt.elseStatement) && alwaysExits(stmt.thenStatement) && alwaysExits(stmt.elseStatement);
  }
  return false;
};

/**
 * Stricter than `alwaysExits`: does this statement guarantee the FUNCTION
 * returned? (Codex round-9 P2.)
 *
 * `break` leaves the switch but not the function — control lands after it, where
 * `pluckActivityRefs` returns the all-null fallback. So a clause that
 * conditionally returns a good mapping and otherwise breaks was being treated as
 * finished, while the false branch filed NULL. Leaving the switch and having
 * returned are different claims, and only the second is what "mapped" means.
 */
const alwaysReturns = (stmt) => {
  if (!stmt) return false;
  // A `throw` is NOT a successful return (Codex round-11 P2). It aborts
  // `recordActivityEvents` before the row is inserted, so the reference is not
  // "mapped" on that path — it is a path with no row at all. Only `return`
  // establishes coverage.
  if (ts.isReturnStatement(stmt)) return true;
  if (ts.isBlock(stmt)) return alwaysReturns(stmt.statements[stmt.statements.length - 1]);
  if (ts.isIfStatement(stmt)) {
    return (
      Boolean(stmt.elseStatement) && alwaysReturns(stmt.thenStatement) && alwaysReturns(stmt.elseStatement)
    );
  }
  return false;
};

/** Every `return` in a clause, not descending into nested functions. */
const collectReturns = (node, out) => {
  // EVERY function-like boundary, not just the three plain forms (Codex round-11
  // P2): a `return` inside an object method or accessor belongs to that method,
  // and counting it let a case "map" a field it never returns.
  if (isFunctionLike(node)) return;
  if (ts.isReturnStatement(node)) out.push(node);
  ts.forEachChild(node, (c) => collectReturns(c, out));
};

/**
 * Read `Number(args.<path> as bigint)` — as a SHAPE in the tree, not as text.
 * Returns the argument path, or null when the expression is anything else.
 */
const readsArgPath = (expr) => {
  if (!expr || !ts.isCallExpression(expr)) return null;
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== 'Number') return null;
  if (expr.arguments.length !== 1) return null;
  // Assertions and parentheses are unwrapped at EVERY step, not just the outside
  // (Codex round-10 P2). `args.fields` is typed `unknown`, so the only type-safe
  // way to read a tuple reference is
  // `(args.fields as { refinanceTargetLoanId: bigint }).refinanceTargetLoanId` —
  // valid TypeScript that the old walk rejected, because it stopped at the inner
  // AsExpression before reaching `args`. That made the round-6 tuple expectation
  // unsatisfiable by any type-safe mapping: the checker demanded a reference it
  // would then refuse to accept.
  const unwrap = (n) => {
    let cur = n;
    while (
      ts.isAsExpression(cur) ||
      ts.isParenthesizedExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isTypeAssertionExpression?.(cur)
    ) {
      cur = cur.expression;
    }
    return cur;
  };
  // `args.a.b.c` → "a.b.c"; anything not rooted at `args` is rejected.
  const parts = [];
  let cur = unwrap(expr.arguments[0]);
  while (ts.isPropertyAccessExpression(cur)) {
    parts.unshift(cur.name.text);
    cur = unwrap(cur.expression);
  }
  if (!ts.isIdentifier(cur) || cur.text !== 'args') return null;
  return parts.length ? parts.join('.') : null;
};

// ONLY the `null` keyword (Codex round-14 P2). `undefined` is an identifier and
// can be rebound — `const undefined = 123` makes `loanId: undefined` a numeric
// value while reading here as "deliberately unmapped", which would both persist a
// wrong id and keep the exemption falsely live. Anything else that is not an
// accepted read falls through to the shape check and is reported.
const isNullLiteral = (expr) => Boolean(expr) && expr.kind === ts.SyntaxKind.NullKeyword;

/**
 * A shadow declared in the ENCLOSING function body — before the switch — binds
 * for every clause (Codex round-13 P2). Scanning only clause statements missed
 * `const Number = () => 0` sitting immediately above the switch, which silently
 * turns every accepted conversion into a call to something else.
 */
{
  let outerShadow = null;
  const walkOuter = (n) => {
    if (outerShadow) return;
    if (n === switchNode) return; // clause bodies are scanned per case
    // Declarations (including DESTRUCTURED ones) and WRITES alike — the enclosing
    // body needs the same treatment the per-case scan gets (Codex round-14 P2):
    // `const { Number } = …` and `args.loanId = 0n` sitting just above the switch
    // affect every case, and a name-identifier-only test saw neither.
    if (
      (ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) ||
        ts.isParameter(n)) &&
      bindsShadowable(n.name)
    ) {
      outerShadow = ts.isIdentifier(n.name) ? n.name.text : 'args/Number (destructured)';
      return;
    }
    if (mutatesShadowable(n)) {
      outerShadow = 'args/Number (assigned)';
      return;
    }
    ts.forEachChild(n, walkOuter);
  };
  if (fnNode.body) ts.forEachChild(fnNode.body, walkOuter);
  if (outerShadow) {
    structural.push(
      `pluckActivityRefs declares '${outerShadow}' in its own body, shadowing what the accepted mapping shape relies on for EVERY case — this checker cannot tell the two apart`,
    );
  }
}

{
  /** Labels accumulate across fall-through clauses, along with their returns. */
  let pendingLabels = [];
  let pendingReturns = [];
  /**
   * Statements accumulate across fall-through clauses too (Codex round-17 P2).
   * Labels and returns already did; the mutation / abrupt-exit scans read only
   * the TERMINAL clause's statements, so `args.loanId = 0n` written under a
   * clause that falls through to a shared return was never looked at, and every
   * row for that event was filed under loan zero. Whatever binds a group of
   * labels has to be examined for the whole group.
   */
  let pendingStatements = [];
  const seenLabels = new Set();

  /**
   * Labels still pending when the case list ends — because the last non-default
   * clause can fall through — are flushed against the default continuation
   * (Codex round-11 P2).
   *
   * Skipping `default` outright left them unprocessed, so a final clause with a
   * conditional return kept its allowlist entry and its false branch (which
   * reaches the all-null default) was never examined. Falling into `default` is
   * exactly the state this whole guardrail exists to detect, so it must not be the
   * one path that escapes examination.
   */
  const flushPending = (reason) => {
    if (pendingLabels.length === 0) return;
    for (const label of pendingLabels) {
      for (const field of REF_FIELDS) {
        if (!aliasNames.get(label)?.get(field)) continue;
        suspectMappings.push({ event: label, field, expr: '<falls through>', why: reason });
      }
      mapped.set(label, new Set());
    }
    pendingLabels = [];
    pendingReturns = [];
    pendingStatements = [];
  };

  for (const clause of switchNode.caseBlock.clauses) {
    if (ts.isDefaultClause(clause)) {
      // The NULL fallback itself is by design; what matters is anything that fell
      // INTO it.
      flushPending('this case can fall through into the all-null default clause');
      continue;
    }
    const label = ts.isStringLiteralLike(clause.expression) ? clause.expression.text : null;
    if (label === null) {
      structural.push(
        `a case label is not a string literal (${clause.expression.getText(sourceFile)}) — this checker cannot resolve it`,
      );
      continue;
    }
    // A duplicate label is dead code: JavaScript takes the FIRST match, so a
    // later case silently never runs while overwriting this checker's view of
    // the event (Codex round-8 P2).
    if (seenLabels.has(label)) {
      structural.push(`duplicate case label '${label}' — the later case is dead code, the first one wins at runtime`);
    }
    seenLabels.add(label);

    pendingLabels.push(label);
    const returns = [];
    for (const stmt of clause.statements) collectReturns(stmt, returns);
    pendingReturns.push(...returns);
    pendingStatements.push(...clause.statements);

    const last = clause.statements[clause.statements.length - 1];
    if (!alwaysExits(last)) continue; // falls through: bind the next clause too
    // Exits the switch WITHOUT returning: control continues after the switch, to
    // the all-null fallback this checker never sees. Record that as an
    // unresolvable path so any field claimed here is reported, not trusted.
    //
    // Any statement, not just the last (Codex round-10 P2): `if (…) break;` before
    // a final valid return leaves `alwaysReturns(last)` true while the break path
    // still reaches the fallback. Nested loops and switches are NOT descended
    // into — a `break` inside them binds to them, not to this clause.
    const hasAbruptExit = (nodes) => {
      let found = false;
      // Labels in scope, so a `break local;` can be told from a bare `break`
      // (Codex round-12 P2). Round 11 skipped the whole labeled subtree to stop a
      // false positive, which then hid an UNLABELED break inside it — and that
      // one does target the switch. Precision both ways: ignore only the breaks
      // that name an enclosing label.
      const walk = (n, labels) => {
        if (found) return;
        if (isFunctionLike(n)) return;
        // A loop or nested switch owns its OWN break/continue, but not its throws
        // (Codex round-14 P2): skipping those subtrees entirely hid a
        // `while (true) { throw … }` that aborts the insertion before any row is
        // written. Descend for throws, with breaks/continues treated as local.
        if (
          ts.isForStatement(n) ||
          ts.isForOfStatement(n) ||
          ts.isForInStatement(n) ||
          ts.isWhileStatement(n) ||
          ts.isDoStatement(n) ||
          ts.isSwitchStatement(n)
        ) {
          const scanThrows = (m) => {
            if (found) return;
            if (isFunctionLike(m)) return;
            if (ts.isThrowStatement(m)) found = true;
            ts.forEachChild(m, scanThrows);
          };
          ts.forEachChild(n, scanThrows);
          return;
        }
        if (ts.isLabeledStatement(n)) {
          const inner = new Set(labels);
          inner.add(n.label.text);
          ts.forEachChild(n, (c) => walk(c, inner));
          return;
        }
        if (ts.isBreakStatement(n) || ts.isContinueStatement(n)) {
          if (!n.label || !labels.has(n.label.text)) found = true;
        }
        // A `throw` anywhere in the clause is an abrupt path too (Codex round-12
        // P2): it aborts before the row is written, so it is no more "mapped"
        // than a break. Round 11 fixed only the throw in terminal position.
        if (ts.isThrowStatement(n)) found = true;
        ts.forEachChild(n, (c) => walk(c, labels));
      };
      for (const n of nodes) walk(n, new Set());
      return found;
    };
    const groupStatements = pendingStatements;
    const escapesWithoutReturning =
      !alwaysReturns(last) || hasAbruptExit(groupStatements);

    const labels = pendingLabels;
    const returnNodes = pendingReturns;
    pendingLabels = [];
    pendingReturns = [];
    pendingStatements = [];

    // Each return contributes one "scope": its top-level properties, or a marker
    // that this checker cannot see them.
    const scopes = returnNodes.map((r) => {
      const e = r.expression;
      if (!e || !ts.isObjectLiteralExpression(e)) return { opaque: 'not an object literal' };
      const props = new Map();
      let spread = false;
      for (const p of e.properties) {
        if (ts.isSpreadAssignment(p)) {
          spread = true;
          continue;
        }
        if (ts.isShorthandPropertyAssignment(p)) {
          props.set(p.name.text, { shorthand: true });
          continue;
        }
        if (ts.isPropertyAssignment(p)) {
          // `['loanId']: …` is a ComputedPropertyName wrapping a string literal —
          // statically resolvable, and valid TypeScript, so ignoring it let a real
          // mapping go uncounted and its exemption stay falsely live (Codex
          // round-12 P2).
          let key = null;
          if (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) key = p.name.text;
          else if (ts.isComputedPropertyName(p.name) && ts.isStringLiteralLike(p.name.expression)) {
            key = p.name.expression.text;
          }
          if (key !== null) props.set(key, { expr: p.initializer });
          else spread = true; // an unresolvable key could be this field
        }
      }
      return { props, spread };
    });
    if (escapesWithoutReturning) {
      scopes.push({
        opaque:
          'a path leaves this case without returning a mapped object — a break/continue, or a throw — so the row is either filed from the all-null default or never written',
      });
    }

    // A local `args` shadows the function parameter, so `args.loanId` in this
    // clause is NOT the decoded event arguments (Codex round-9 P2). Resolving it
    // properly needs a type checker and a full Program; refusing to reason about
    // a shadowed name is the sound alternative, and the shape rule below would
    // otherwise accept a hand-built object as if it were the wire data.
    // `Number` as well as `args` (Codex round-12 P2): a local
    // `const Number = () => 0` makes the accepted call shape a call to something
    // else entirely, and every row lands with loan id zero. Same reasoning as the
    // `args` shadow — resolving callees symbolically needs a full Program, and
    // refusing to reason about a shadowed name is the sound cheap answer.
    const shadowsArgs = (() => {
      let found = null;
      const walk = (n) => {
        if (found) return;
        // Name FIRST, then decline to traverse (Codex round-12 P2). Returning on
        // every function declaration made the name test below dead code, so a
        // block-local `function args() {}` shadowed the parameter unnoticed —
        // a bug I introduced in the round-11 fix for exactly this class.
        if (
          (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isEnumDeclaration(n)) &&
          SHADOWABLE_NAMES.has(n.name?.text)
        ) {
          found = 'declares a local named';
          return;
        }
        if (isFunctionLike(n)) return;
        // Binding NAMES recursively (Codex round-10 P2): `const { args } = …` puts
        // the binding inside an ObjectBindingPattern, which an identifier-only
        // test walks straight past.
        // A WRITE and a DECLARATION are both disqualifying but are not the same
        // thing, and saying "declares a local" for `({ loanId: args.loanId } = …)`
        // sends the reader looking for a declaration that is not there.
        if (mutatesShadowable(n)) { found = found || 'assigns to'; }
        if (ts.isVariableDeclaration(n) || ts.isParameter(n)) {
          if (bindsShadowable(n.name)) found = found || 'declares a local named';
        }
        ts.forEachChild(n, walk);
      };
      for (const st of groupStatements) walk(st);
      return found;
    })();
    if (shadowsArgs) {
      structural.push(
        `case '${label}' ${shadowsArgs} 'args' or 'Number', shadowing what the accepted mapping shape relies on — this checker cannot tell the two apart`,
      );
    }

    for (const label of labels) {
      const fields = new Set();
      for (const field of REF_FIELDS) {
        const accepted = aliasNames.get(label)?.get(field);

        const named = scopes.filter((s) => s.props?.has(field));
        if (named.length === 0) continue; // this field is never returned here

        // Deliberately unmapped on every path that names it, with nothing opaque.
        const allNull = named.every((s) => isNullLiteral(s.props.get(field).expr));
        const anyOpaque = scopes.some((s) => s.opaque || s.spread || !s.props?.has(field));
        if (allNull && !anyOpaque) continue;

        // The event carries no alias for this field, yet something non-null is
        // filed under it — always a defect, whatever argument it reads
        // (Codex round-8 P2). Checking only that the path EXISTS accepted
        // `loanId: Number(args.interestPaid as bigint)`, persisting an interest
        // amount as a loan id.
        if (!accepted || accepted.size === 0) {
          for (const s of named) {
            const e = s.props.get(field).expr;
            if (isNullLiteral(e)) continue;
            suspectMappings.push({
              event: label,
              field,
              expr: e ? e.getText(sourceFile) : '<shorthand>',
              why: `this event carries no ${field} reference in its ABI, so nothing here can be a valid source for it`,
            });
          }
          continue;
        }

        let bad = null;
        for (const s of named) {
          const entry = s.props.get(field);
          if (entry.shorthand) {
            bad = { text: `${field} (shorthand)`, why: 'shorthand property — the source cannot be resolved here' };
            break;
          }
          if (isNullLiteral(entry.expr)) {
            bad = { text: entry.expr.getText(sourceFile), why: 'one return path files nothing' };
            break;
          }
          const path = readsArgPath(entry.expr);
          if (path === null) {
            bad = {
              text: entry.expr.getText(sourceFile),
              why: 'not a direct Number(args.…) read of a decoded argument',
            };
            break;
          }
          if (!accepted.has(path)) {
            bad = {
              text: entry.expr.getText(sourceFile),
              why: `reads args.${path}, which is not a ${field} reference on this event (${[...accepted].join(' / ')})`,
            };
            break;
          }
        }
        if (!bad && anyOpaque) {
          // Name the specific reason rather than listing every possibility: a
          // `break` that falls past the switch is a different defect from a
          // spread, and the reader should not have to work out which one it was.
          const opaqueScope = scopes.find((sc) => sc.opaque);
          const spreadScope = scopes.find((sc) => sc.spread);
          bad = {
            text: '<some return path>',
            why: opaqueScope
              ? opaqueScope.opaque
              : spreadScope
                ? 'a return path supplies this field by spread, so its source cannot be resolved here'
                : 'a return path does not name this field at all',
          };
        }

        if (bad) {
          suspectMappings.push({ event: label, field, expr: bad.text, why: bad.why });
        } else {
          fields.add(field);
        }
      }
      mapped.set(label, fields);
    }
  }
  // No default clause, or pending labels after the last one: same situation —
  // control leaves the switch without a mapped return.
  flushPending('this case can fall out of the switch without returning a mapped object');
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
    // `Object.hasOwn`, not truthiness (Codex round-10 P2): an event named like an
    // inherited prototype member — `toString`, `constructor` — would otherwise
    // find that inherited value and read as allowlisted with no entry present.
    if (
      Object.hasOwn(DELIBERATELY_NOT_SCOPED, event) ||
      Object.hasOwn(DELIBERATELY_NOT_SCOPED, `${event}.${field}`)
    ) {
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

// The relevance filter applies to OVERLOADS ONLY (Codex round-9 P2).
//
// The live ABI has one genuine overload — `StuckERC20Recovered`, an ops recovery
// event carrying no reference and mapped nowhere — and failing the run on that
// would be reporting a problem this check does not have.
//
// A non-numeric reference name is the opposite case, and filtering it the same way
// made the type validation self-defeating: an event named `bytes32 loanId` is
// EXCLUDED from `carries` by the numeric filter and has no case, so it is neither
// carried nor mapped — precisely the condition that discarded its own conflict.
// The check only ever fired for events that were already in scope, which is where
// it was least needed. These are always reported.
const relevantAbiConflicts = abiConflicts.filter(
  (c) => c.kind !== 'overload' || carries.has(c.event) || mapped.has(c.event),
);

if (
  gaps.length ||
  dead.length ||
  suspectMappings.length ||
  structural.length ||
  relevantAbiConflicts.length
) {
  if (relevantAbiConflicts.length) {
    console.error('\n✖ activity-refs coverage: ABI problems this checker cannot reason around:\n');
    for (const c of relevantAbiConflicts) console.error(`    ${c.message}`);
  }
  if (structural.length) {
    console.error('\n✖ activity-refs coverage: problems in the switch itself:\n');
    for (const s of structural) console.error(`    ${s}`);
  }
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
