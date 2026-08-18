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
  'LoanInitiatedDetails.loanId':
    'companion payload to LoanInitiated, consumed to build the loans row — the LoanInitiated row already carries the loan reference, so a second row for the same event pair would double-count the timeline',
  'FeeEntitlementStamped.loanId':
    'fee-entitlement bookkeeping stamped at accept — an internal accounting record, not an event a user reads on a loan timeline',
  'FeeEntitlementRepriced.loanId':
    'twin of FeeEntitlementStamped — governance retune bookkeeping, not user-facing loan activity',
  'NotificationFeeBilled.loanId':
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
  'LoanSold.loanId': 'TODO(#1794) — direct lender sale; plainly loan-timeline material',
  'LoanSaleCompleted.loanId': 'TODO(#1794) — listed lender sale completion; plainly loan-timeline material',
  'LoanSaleOfferLinked.loanId': 'TODO(#1794) — sale listing bound to a loan',
  'LoanSaleOfferLinked.offerId': 'TODO(#1794) — the same binding, sale-offer side (saleOfferId)',
  'LoanSaleListingTornDown.loanId': 'TODO(#1794) — sale listing withdrawn',
  'LoanSaleListingTornDown.offerId': 'TODO(#1794) — listing withdrawn, sale-offer side (saleOfferId)',
  'LoanPreclosedDirect.loanId': 'TODO(#1794) — borrower early close-out',
  'LoanObligationTransferred.loanId': 'TODO(#1794) — obligation handover to a replacement borrower',
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
  'CollateralAdded.loanId': 'TODO(#1794) — borrower collateral top-up',
  'PartialCollateralWithdrawn.loanId': 'TODO(#1794) — surplus collateral release',
  'CollateralConsolidated.loanId': 'TODO(#1794) — collateral consolidation to the NFT holder',
  'HFLiquidationTriggered.loanId': 'TODO(#1794) — health-factor liquidation; the loans row IS flipped (#1293), only the activity reference is missing',
  'LiquidationDiscounted.loanId': 'TODO(#1794) — twin of HFLiquidationTriggered',
  'LoanPartiallyLiquidated.loanId': 'TODO(#1794) — partial liquidation',
  'LiquidationFallback.loanId': 'TODO(#1794) — liquidation fallback entry',
  'LiquidationFallbackSplit.loanId': 'TODO(#1794) — split-route liquidation fallback',
  'LiquidationFallbackOracleUnavailable.loanId': 'TODO(#1794) — fallback taken because the oracle was unavailable',
  'LoanFallbackPending.loanId': 'TODO(#1794) — fallback episode opened',
  'LoanCuredFromFallback.loanId': 'TODO(#1794) — fallback episode cured',
  // Dual-carrying: split per field so mapping one cannot mask a regression on
  // the other (Codex round-1 P2).
  'BackstopFilled.loanId': 'TODO(#1794) — backstop fill against a loan',
  'BackstopFilled.offerId': 'TODO(#1794) — backstop fill, offer side',
  'BackstopLoanClaimed.loanId': 'TODO(#1794) — backstop claim',
  'LenderBackstopOptInSet.loanId': 'TODO(#1794) — per-loan backstop opt-in',
  'BorrowerSurplusClaimed.loanId': 'TODO(#1794) — borrower surplus claim',
  'ClaimRetryExecuted.loanId': 'TODO(#1794) — claim retry',
  'SanctionedProceedsLocked.loanId': 'TODO(#1794) — proceeds withheld from a flagged party',
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
  'AutoDailyDeducted.loanId': 'TODO(#1794) — NFT-rental daily deduction',
  'AutoExtendBorrowerCapsChanged.loanId': 'TODO(#1794) — borrower auto-extend caps',
  'AutoExtendLenderCapsChanged.loanId': 'TODO(#1794) — lender auto-extend caps',
  'AutoRefinanceCapsChanged.loanId': 'TODO(#1794) — auto-refinance caps',
  'AutoListOptOutCleared.loanId': 'TODO(#1794) — auto-list opt-out cleared',
  'LoanKeeperEnabled.loanId': 'TODO(#1794) — per-loan keeper authorization',
  'PrepaySaleListingSynced.loanId': 'TODO(#1794) — sanctions-sync breadcrumb on a loan-keyed listening',
  'SwapAdapterAttempted.loanId': 'TODO(#1794) — swap adapter attempt',
  'SwapAdapterSucceeded.loanId': 'TODO(#1794) — swap adapter success',
  'SwapAllAdaptersFailed.loanId': 'TODO(#1794) — every swap adapter failed',
  'VPFIDiscountApplied.loanId': 'TODO(#1794) — VPFI fee discount applied',
  'VPFIYieldFeeDiscountApplied.loanId': 'TODO(#1794) — VPFI yield-fee discount applied',

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
  'OfferCanceledDetails.offerId': 'companion payload to OfferCanceled, which is offer-scoped already',

  // TODO(#1794): real gaps on the offer side. NOTE these are NOT the same
  // question as `check-event-coverage.mjs`'s DELIBERATELY_NOT_HANDLED — that
  // list is about driving a typed `offers` row, this one is about being findable
  // on an offer's activity feed. An event can legitimately not mutate the row
  // and still belong on the timeline, so their reasons do not transfer.
  'OfferClosed.offerId':
    'TODO(#1794) — offer-lifecycle terminal, and it IS handled (chainIndexer.ts:1253 flips the row + stamps cancelled_at). Handled but unscoped is the sharpest shape of this bug: the projection is right while the audit trail cannot find the event.',
  'OfferCreatorFullTariffSet.offerId': 'TODO(#1794) — per-offer fee-tariff opt-in',
  'OfferKeeperEnabled.offerId': 'TODO(#1794) — per-offer keeper authorization',
  'OfferBackstopEligibilitySet.offerId': 'TODO(#1794) — per-offer backstop eligibility; no indexer reference at all today',
  'OfferSaleProceedsCredited.offerId': 'TODO(#1794) — proceeds credited to the borrower vault on a sale',
  'PostParallelSaleListing.offerId': 'TODO(#1794) — parallel-sale listing posted',
  'ParallelSaleLockReleased.offerId': 'TODO(#1794) — parallel-sale binding unwound',
  'PrepaySaleOfferSynced.offerId': 'TODO(#1794) — sanctions-sync breadcrumb on an offer-keyed listing',
};

// ── 1. Events whose compiled ABI carries loanId / offerId ───────────────
// Membership comes from the barrel's `DIAMOND_ABI` spread list, NOT from every
// JSON in the directory (Codex round-1 P2). The directory also holds STANDALONE
// contracts the barrel imports and re-exports but deliberately does NOT spread —
// `AggregatorAdapterImplementation`, `FlashLoanLiquidator`. Their events can
// never reach `pluckActivityRefs`, because the indexer's `EVENT_ABI` is derived
// from `DIAMOND_ABI_VIEM`, so enforcing them manufactures phantom backlog that
// would grow with every future standalone contract. Enforced set == decodable set.
/**
 * Reads an object literal the way JavaScript does: later definitions win, and a
 * spread (or a key/getter this parser cannot read) shadows everything defined
 * before it. Returns the fields that SURVIVE, so a caller never has to re-derive
 * the ordering rules.
 *
 * Shared by the case-return scan and the default clause (Codex round-26 P2). The
 * default had its own simpler reader that took the first matching property and
 * ignored what came after, so appending `...({ loanId: 999 })` to the all-null
 * fallback left the run green while attaching every unmapped and allowlisted
 * event to loan 999. Two readers of the same shape is one reader too many.
 */
const objectLiteralView = (e) => {
    const props = new Map();
    // Spread POSITION matters, not just presence (Codex round-19 P2). An
    // explicit property AFTER a spread overrides it — that is a language
    // guarantee — so `{ ...whatever, loanId: Number(args.loanId) }` is a
    // perfectly resolvable mapping, and marking the whole scope opaque
    // rejected a valid one. This is the first finding in the false-POSITIVE
    // direction, and it is worth separating from the rest: every other round
    // has been about the checker accepting too much, where the cost is a
    // silent hole. Here the cost is a correct mapping the author cannot get
    // past the gate, which is how a guardrail earns a reputation for being
    // wrong and starts getting worked around.
    //
    // So each field records WHERE it was last defined, a spread records where
    // it sat, and a field survives when its definition is the later of the two.
    let lastSpreadIdx = -1;
    const definedAt = new Map();
    let idx = -1;
    for (const p of e.properties) {
      idx += 1;
      if (ts.isSpreadAssignment(p)) {
        // A spread of an object literal carrying an ACCESSOR is not inert
        // (Codex round-27 P2). Spreading reads every own enumerable property, so
        // a getter in there RUNS during the spread — before any later field is
        // computed — and `get poisoned() { args.loanId = 0n; return true; }`
        // therefore corrupts the decoded arguments the next property reads,
        // while the mutation walk skips getter bodies and sees nothing.
        //
        // Consistent with how round 22 already treats a getter as a property
        // this parser cannot read: unreadable, so opaque. Here that means the
        // whole literal, because the side effect lands on values defined AFTER
        // the spread rather than on the spread's own keys.
        const src = unwrapAssertions(p.expression);
        if (
          ts.isObjectLiteralExpression(src) &&
          // A GETTER only (Codex round-30 P2). Spreading READS every own
          // enumerable property, so a getter runs and can mutate the decoded
          // arguments; a setter is never invoked by a read, and lumping the two
          // together rejected a harmless `...{ set helper(v) {} }` inside
          // `typecheck`. The setter still defines a key, handled below.
          src.properties.some((q) => ts.isGetAccessorDeclaration(q))
        ) {
          return { opaque: 'a spread of an object literal with a getter/setter, which runs during the spread and can mutate the decoded arguments before the later fields are computed' };
        }
        // An INLINE object literal spread has completely known keys, so it does
        // not shadow anything it does not itself define (Codex round-28 P2).
        // Treating every spread as opaque failed a perfectly ordinary return —
        // `{ loanId: …, ...{ actor: null }, offerId: … }` — and since this
        // script runs inside `typecheck`, that blocks the build on valid code.
        //
        // Read it RECURSIVELY rather than flattening its keys (Codex round-29
        // P2). A flat merge gave every nested property the OUTER position, so a
        // spread INSIDE the literal could not shadow a reference defined beside
        // it: `...{ loanId: Number(args.loanId), ...({ loanId: 999 }) }` kept the
        // accepted value while the runtime took 999. A nested literal is just
        // another object literal, so it gets the same reader.
        if (ts.isObjectLiteralExpression(src)) {
          const inner = objectLiteralView(src);
          if (inner.opaque) return inner;
          // Whatever SURVIVED inside lands here, at this position; if the nested
          // literal itself ended on an unresolvable key, it shadows from here.
          for (const [k, v] of inner.props) {
            props.set(k, v);
            definedAt.set(k, idx);
          }
          if (inner.spread) lastSpreadIdx = idx;
          continue;
        }
        lastSpreadIdx = idx;
        continue;
      }
      if (ts.isShorthandPropertyAssignment(p)) {
        props.set(p.name.text, { shorthand: true });
        definedAt.set(p.name.text, idx);
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
        if (key !== null) {
          props.set(key, { expr: p.initializer });
          definedAt.set(key, idx);
        } else {
          // An unresolvable key could BE this field, and it could sit after
          // any explicit definition — so it shadows like a spread does.
          lastSpreadIdx = idx;
        }
        continue;
      }
      // A GETTER, SETTER or METHOD is an explicit property this parser cannot
      // read (Codex round-22 P2). `get loanId() { return 999; }` defines the
      // field as surely as `loanId: 999` does, and falling through to the end
      // of the loop recorded nothing at all — so the field read as "never
      // returned here" and the case was skipped, with the ledger attaching
      // every such event to whatever the getter returns.
      //
      // Treated as shadowing rather than parsed: what a getter returns is a
      // function body, not an expression, and the honest answer for a shape
      // this checker cannot read is that it cannot read it.
      if (ts.isGetAccessorDeclaration(p)) {
        lastSpreadIdx = idx;
        continue;
      }
      // A SETTER defines a statically named key and is not run by a read, so it
      // behaves like a method here (Codex round-30 P2) — known, not opaque. It
      // still SHADOWS if its name is one of the reference fields, because the
      // value a later read would see is not an expression this parser can read.
      if (ts.isSetAccessorDeclaration(p)) {
        if (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) {
          props.set(p.name.text, { accessor: true });
          definedAt.set(p.name.text, idx);
        } else {
          lastSpreadIdx = idx;
        }
        continue;
      }
      // A METHOD is not in that class (Codex round-29 P2). Its name is static
      // and spreading copies a function-valued property without invoking it, so
      // it defines exactly one KNOWN key and shadows nothing else — where an
      // accessor runs. Treating the two alike erased an earlier `loanId` from
      // the view for a harmless `...{ helper() {} }`.
      if (ts.isMethodDeclaration(p)) {
        if (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) {
          props.set(p.name.text, { method: true });
          definedAt.set(p.name.text, idx);
        } else {
          lastSpreadIdx = idx;
        }
      }
    }
    // Drop anything the spread (or an unresolvable key) defines LAST.
    for (const [key, at] of definedAt) {
      if (at < lastSpreadIdx) props.delete(key);
    }
  return { props, spread: lastSpreadIdx >= 0 };
};

/**
 * Does this binding name — an identifier, or an object/array destructuring
 * pattern, nested to any depth — bind `name`?
 *
 * ONE matcher, used by every resolver in this file (Codex round-30 P2). There
 * were two, and only the elaborate one handled array patterns, so
 * `const [loanId] = [999]` was invisible to the SQL-bind resolver and the
 * argument resolved to the mapper's destructuring further out. Two
 * implementations of the same question is how that gap opened; keeping one is
 * the fix, not teaching the second about arrays.
 */
const declaresName = (bindingName, name) => {
  if (!bindingName) return false;
  if (ts.isIdentifier(bindingName)) return bindingName.text === name;
  if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
    return bindingName.elements.some(
      (el) => ts.isBindingElement(el) && declaresName(el.name, name),
    );
  }
  return false;
};

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
  //
  // The suffix is a WHOLE identifier tail, not one letter (Codex round-24 P2).
  // `loanIdPrimary` and `offerIdReplacement` are ordinary ABI names, and the
  // one-uppercase-or-digits form matched neither them nor the empty escape list,
  // so an event whose only reference was named that way sat outside coverage
  // with no mapping and no exemption — the same enumerated-range mistake round
  // 13 fixed, one character wider.
  //
  // The tail follows an optional NUMERIC leg as well (Codex round-25 P2). Round
  // 24 widened the uppercase branch to a whole tail but left the digits branch
  // as an alternative that ended at the last digit, so `loanId2Primary` and
  // `offerId2Replacement` — ordinary names combining both legs — matched
  // neither. Same enumerated-shape mistake a third time: the two legs are
  // independent and optional, not a choice between them.
  //
  // The tail must still START uppercase, which is the whole reason a PLURAL is
  // excluded: `loanIds` continues after `loanId` in lower case, so it is an
  // array rather than a single reference and must not be treated as one.
  loanId: /^[A-Za-z0-9_]*[Ll]oanId(?:[0-9]+)?(?:[A-Z][A-Za-z0-9_]*)?$/,
  offerId: /^[A-Za-z0-9_]*[Oo]fferId(?:[0-9]+)?(?:[A-Z][A-Za-z0-9_]*)?$/,
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
 * Could a decoded-argument key of this name carry a reference?
 *
 * Asked of the ABI's OWN names, not the two normalised column names (Codex
 * round-28 P2). An enrichment that overwrites `lenderOfferId` or `oldLoanId`
 * replaces a reference this checker derives and maps, and testing only
 * `loanId`/`offerId` missed every alias. Nested roots count too, because a
 * reference can live at `fields.refinanceTargetLoanId` — replacing the whole
 * `fields` object replaces the reference inside it.
 *
 * Deliberately over-broad: it decides only whether an enrichment key is allowed
 * to sit after a self-spread, where the safe answer is "assume it matters".
 */
// Derived from the ABI, not hardcoded (Codex round-29 P2). Nested references
// are found generically — any tuple input whose component is reference-shaped —
// so pinning the root set to `fields` meant an equally valid `details.loanId`
// would be derived and mapped while `{ ...args, details: other.args.details }`
// still read as self-preserving. Computed lazily because `aliasNames` is filled
// by the ABI scan below and this is only ever called after it.
const nestedRefRoots = () => {
  const roots = new Set();
  for (const perField of aliasNames.values()) {
    for (const paths of perField.values()) {
      for (const path of paths) {
        const dot = path.indexOf('.');
        if (dot > 0) roots.add(path.slice(0, dot));
      }
    }
  }
  return roots;
};
const couldBeReference = (key) =>
  nestedRefRoots().has(key) ||
  REF_FIELDS.some(
    (f) => REF_SHAPE[f].test(key) || (REF_EXTRA_ALIASES[f] ?? []).includes(key),
  );

/**
 * Names the accepted mapping shape depends on. A local binding OR a write to
 * either one makes `Number(args.x)` mean something this checker cannot resolve.
 */
const SHADOWABLE_NAMES = new Set(['args', 'Number']);

const unwrapAssertions = (t) => {
  while (
    ts.isParenthesizedExpression(t) ||
    ts.isAsExpression(t) ||
    ts.isNonNullExpression(t) ||
    ts.isSatisfiesExpression?.(t) ||
    ts.isTypeAssertionExpression?.(t)
  ) {
    t = t.expression;
  }
  return t;
};

/**
 * Is this node a WRITE to the bare identifier `wanted`? Any assignment operator,
 * the increment/decrement forms, and a destructuring-assignment target — the
 * same shapes `mutatesShadowable` recognises for `args`, asked of a plain name.
 */
const writesName = (n, wanted) => {
  if (!wanted) return false;
  const targets = (expr) => {
    if (!expr) return false;
    if (ts.isParenthesizedExpression(expr)) return targets(expr.expression);
    if (ts.isObjectLiteralExpression(expr)) {
      return expr.properties.some((p) => {
        if (ts.isPropertyAssignment(p)) return targets(p.initializer);
        if (ts.isShorthandPropertyAssignment(p)) return p.name.text === wanted;
        if (ts.isSpreadAssignment(p)) return targets(p.expression);
        return false;
      });
    }
    if (ts.isArrayLiteralExpression(expr)) {
      return expr.elements.some((e) =>
        ts.isSpreadElement(e) ? targets(e.expression) : targets(e),
      );
    }
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return targets(expr.left); // `[x = fallback]`: the default is not the target
    }
    // Assertions and parens are peeled — but NOT property access: `foo.eventName`
    // is a different binding, and treating it as this one would refuse ordinary
    // code. `unwrapAssertions` stops exactly there.
    const bare = unwrapAssertions(expr);
    return ts.isIdentifier(bare) && bare.text === wanted;
  };
  if (ts.isBinaryExpression(n) && ts.isAssignmentOperator?.(n.operatorToken.kind)) {
    return targets(n.left);
  }
  if (
    (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
    (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return targets(n.operand);
  }
  // `for (eventName of […])` writes the parameter on every iteration (Codex
  // round-22 P2). The initializer is a bare expression rather than a declaration
  // list, so neither the declaration scan nor the assignment scan sees it, and a
  // one-element loop before the switch pins the discriminant just as an
  // assignment does.
  if (
    (ts.isForOfStatement?.(n) || ts.isForInStatement?.(n)) &&
    n.initializer &&
    !ts.isVariableDeclarationList(n.initializer)
  ) {
    return targets(n.initializer);
  }
  return false;
};

/** Does a binding name — plain or destructured — bind `wanted`? */
const bindsName = (name, wanted) => {
  if (!name) return false;
  if (ts.isIdentifier(name)) return name.text === wanted;
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.some((el) => ts.isBindingElement(el) && bindsName(el.name, wanted));
  }
  return false;
};

/**
 * Is this declaration an ALIAS of a name the mapping shape relies on? (Codex
 * round-19 P2.) `const decoded = args; decoded.loanId = 0n;` rebinds the decoded
 * value exactly as a direct write does, and a mutation test rooted at `args`
 * never sees it. Following aliases properly is alias analysis; refusing the
 * declaration costs nothing real, because a mapper has no reason to alias the
 * argument bag it is handed.
 */

const aliasesShadowable = (n) => {
  // `const decoded = args;`
  if (ts.isVariableDeclaration(n) && n.initializer) {
    const t = unwrapAssertions(n.initializer);
    if (ts.isIdentifier(t) && SHADOWABLE_NAMES.has(t.text)) return n.name.getText();
  }
  // `let decoded: typeof args; decoded = args;` — an alias made by ASSIGNMENT
  // (Codex round-20 P2). Round 19 read only the declaration's initializer, so
  // splitting the same alias across a bare declaration and a following assignment
  // walked straight past it and `decoded.loanId = 0n` was invisible again — the
  // evasion round 19 closed, reopened by moving one token.
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const t = unwrapAssertions(n.right);
    if (ts.isIdentifier(t) && SHADOWABLE_NAMES.has(t.text)) return n.left.getText();
  }
  return null;
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
  // `delete args.loanId` (Codex round-21 P2). Not an assignment and not one of
  // the two unary operators, so every earlier round walked past it — and it is
  // the most direct mutation of all: the property is gone and `Number(undefined)`
  // is NaN, which the row stores in place of the id.
  if (ts.isDeleteExpression?.(n)) {
    const t = rootOf(n.expression);
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
/** '<Event>.<field>' -> path, where the only reference is an ARRAY of ids. */
const arrayOnlyRefs = new Map();
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
    /** field -> path, for PLURAL reference arrays (`uint256[] loanIds`). */
    const arrayRefs = new Map();
    /**
     * Could anything under here be a loanId/offerId reference?
     *
     * Both unsupported-shape reports below are about references this checker
     * cannot SEE. A tuple of amounts or addresses hides nothing from coverage,
     * so reporting it would be noise that trains the reader to ignore the
     * message — the live ABI has one such case (`PrepayListingUpdated.feeLegs`,
     * a `tuple[]` of recipient/startAmount/endAmount) and it is not a gap.
     */
    // PLURAL names count here too (Codex round-21 P2). `isAliasOf` deliberately
    // excludes `loanIds` so an array never looks like a single mappable id — but
    // this predicate is asking a different question: does the shape HIDE a
    // reference this checker then cannot see? A `tuple[] items` whose component
    // is `uint256[] loanIds` answered no, so the tuple-array branch declined to
    // report and the event sat outside coverage entirely. `collect` already
    // recognises the plural form; the two must agree or the exclusion leaks from
    // "not directly mappable" into "not there".
    const isPluralRef = (name) =>
      !!name && REF_FIELDS.some((f) => REF_SHAPE[f].test(`${name}`.replace(/s$/, '')));
    const hidesReference = (inputs) =>
      (inputs ?? []).some(
        (c) =>
          REF_FIELDS.some((f) => isAliasOf(f, c?.name)) ||
          (/\]$/.test(c?.type ?? '') && isPluralRef(c?.name)) ||
          (Array.isArray(c?.components) && hidesReference(c.components)),
      );
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
          if (Array.isArray(i?.components) && hidesReference(i.components)) {
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
        // A PLURAL reference array carries references this checker cannot map,
        // which is not the same as carrying none (Codex round-19 P2). The shape
        // regexes deliberately exclude `loanIds` so an array never looks like a
        // single mappable id — but excluding it from the derivation entirely let
        // an event whose ONLY loan reference is `uint256[] loanIds` sit outside
        // coverage with no mapping and no exemption. Reported, for the same
        // reason as the tuple array: one activity row has one `loan_id`, so
        // which element it should carry is a decision, not a lookup.
        if (/\]$/.test(i.type ?? '')) {
          for (const f of REF_FIELDS) {
            if (REF_SHAPE[f].test(`${i.name}`.replace(/s$/, ''))) arrayRefs.set(f, path);
          }
        }
        names.push(path);
        typeOf.set(path, i.type ?? '');
        if (Array.isArray(i.components)) {
          // An ARRAY of tuples is not reachable by a dotted path (Codex round-18
          // P2): viem decodes `args.items` as an array, so `args.items.loanId`
          // is `undefined` and `Number(undefined)` is `NaN` — a mapping that
          // looked valid to this checker and persisted garbage at runtime.
          // Reported as unsupported rather than descended, since validating an
          // indexed access is a different question from validating a path.
          if (/\]$/.test(i.type ?? '')) {
            if (hidesReference(i.components)) {
              abiConflicts.push({
                kind: 'tuple-array',
                event: item.name,
                message: `${item.name} — \`${path}\` is an ARRAY of tuples (${i.type}); its components (${i.components
                  .filter((c) => c?.name)
                  .map((c) => c.name)
                  .join(', ')}) are not reachable by a property path, so a reference inside cannot be mapped or seen by this check`,
              });
            }
          } else if (i.indexed) {
            // An INDEXED tuple is a HASH on the wire (Codex round-22 P2). The
            // topic carries `keccak(abi.encode(tuple))`, so viem hands the mapper
            // a hex string, not a component object — `args.fields.loanId` reads a
            // property off a string and `Number(undefined)` is NaN. The dotted
            // path this walk would derive is syntactically fine and semantically
            // impossible, which is the shape most worth refusing.
            if (hidesReference(i.components)) {
              abiConflicts.push({
                kind: 'indexed-tuple',
                event: item.name,
                message: `${item.name} — \`${path}\` is an INDEXED tuple, so the log carries only its hash and viem decodes it as a hex string; a reference inside (${i.components
                  .filter((c) => c?.name)
                  .map((c) => c.name)
                  .join(', ')}) cannot be read by any property path`,
              });
            }
          } else if (i.components.some((c) => !c?.name)) {
            // MIXED named and unnamed components (Codex round-22 P2). viem
            // decodes a tuple with any unnamed member as an ARRAY, so the whole
            // tuple loses its property access — `args.fields.loanId` is
            // `undefined` even though `loanId` is right there and named. Skipping
            // just the unnamed child, as this walk used to, recorded
            // `fields.loanId` as a valid path and accepted a mapping that
            // persists NaN.
            if (hidesReference(i.components)) {
              abiConflicts.push({
                kind: 'mixed-tuple',
                event: item.name,
                message: `${item.name} — \`${path}\` mixes named and unnamed components, so viem decodes the whole tuple as an ARRAY and no dotted path into it resolves; name every component, or map it positionally outside this checker`,
              });
            }
          } else {
            collect(i.components, path);
          }
        }
      }
    };
    // MIXED named and unnamed at the TOP LEVEL, same rule as inside a tuple
    // (Codex round-23 P2). viem decodes an argument list containing any unnamed
    // member as an ARRAY, so the whole bag loses property access and
    // `args.loanId` is `undefined` even though `loanId` is named — the accepted
    // mapping then stores NaN. Round 22 closed this for tuple components and
    // left the top level open, which is the same shape one nesting level out.
    if ((item.inputs ?? []).some((i) => !i?.name) && hidesReference(item.inputs)) {
      abiConflicts.push({
        kind: 'mixed-inputs',
        event: item.name,
        message: `${item.name} — the event mixes named and unnamed top-level inputs, so viem decodes the whole argument bag as an ARRAY and no \`args.<name>\` path resolves; name every input, or map it positionally outside this checker`,
      });
    }
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
    // A PLURAL reference array carries references this checker cannot map, which
    // is not the same as carrying none (Codex round-19 P2). The shape regexes
    // deliberately exclude `loanIds` so an array never looks like a single
    // mappable id — but excluding it from the derivation entirely let an event
    // whose ONLY loan reference is `uint256[] loanIds` sit outside coverage with
    // no mapping and no exemption.
    //
    // Round 19 reported it as an unsupported ABI shape and told the author to
    // "allowlist the event with a reason" — advice the script could not honour
    // (Codex round-20 P2). An unsupported-shape report is unconditional, so no
    // entry suppressed it; and because the event never entered `carries`, the
    // entry the message asked for reported itself STALE. The only exit from the
    // failure was the one the message told the reader not to take.
    //
    // So the array field enters `carries` like any other reference and runs
    // through the ordinary gap machinery: an allowlist entry resolves it, and
    // stops reporting stale the day the ABI drops the array. Only when the field
    // has no scalar reference on the same event — with one, the scalar is what a
    // mapping should read and the array is not a gap.
    for (const [field, path] of arrayRefs) {
      if (carries.get(item.name)?.has(field)) continue;
      if (!carries.has(item.name)) carries.set(item.name, new Set());
      carries.get(item.name).add(field);
      arrayOnlyRefs.set(`${item.name}.${field}`, path);
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

/**
 * Unwrap parens/assertions so `(eventName as string)` still resolves. Declared
 * here, above every use — a `const` arrow used earlier in the file is a
 * temporal-dead-zone crash, not a lint nit.
 */
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

/** The function that writes `activity_events` rows. */
const LEDGER_FN = 'recordActivityEvents';
/** The property the ledger reads the event name from on each decoded log. */
const DISCRIMINANT_PROP = 'eventName';
/** The decoded-argument bag on a log — the mapper's second parameter. */
const ARGS_PROP = 'args';

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
 * ...and the LEDGER must still call it (Codex round-20 P2).
 *
 * Everything above and below reads one function. That is only evidence about the
 * `activity_events` rows if that function is what fills them. Add a
 * `pluckActivityRefsV2` returning all-nulls, point `recordActivityEvents` at it,
 * and leave the original in place: every case this script reads is still there,
 * the tally is identical, and every row is written with NULL references — the
 * precise outcome the guardrail exists to prevent, reached by editing a file the
 * guardrail already parses.
 *
 * Checking the call is not proof the returned values reach the INSERT — that
 * needs dataflow this script does not do — but it is the one link the mapper's
 * own text cannot establish, and it costs a name lookup.
 */
{
  let ledgerNode = null;
  const findLedger = (node) => {
    if (isFunctionLike(node) && node.name?.text === LEDGER_FN) ledgerNode = node;
    if (!ledgerNode) ts.forEachChild(node, findLedger);
  };
  ts.forEachChild(sourceFile, findLedger);
  if (!ledgerNode) {
    console.error(
      `[check-activity-refs-coverage] could not locate ${LEDGER_FN}() in chainIndexer.ts —\n` +
        '  the function that writes activity_events rows. If it was renamed, update this\n' +
        '  script — do not delete the check.',
    );
    process.exit(1);
  }
  // ...and the SCAN must still feed it (Codex round-25 P2). Everything from here
  // down reads the ledger's own body. That is evidence about the rows only if
  // the ledger is invoked on the batch the scan decoded — and
  // `recordActivityEvents([], env, chainId, blockTimestamps)` typechecks, leaves
  // every check below satisfied, keeps the tally at its usual numbers, and
  // records nothing at all. Same shape as the round-20 finding one level up: a
  // fully verified writer, disconnected from its input.
  //
  // Shape, not identity: the first argument must be a bare identifier — some
  // binding built earlier — rather than a literal collection. Which binding it
  // is, and whether it holds every decoded log, is dataflow this script does not
  // do; refusing the literal closes the way the disconnection is actually
  // written.
  //
  // ...and the call must be one whose RESULT IS USED (Codex round-26 P2). A walk
  // that accepts any syntactic call accepts one that cannot execute:
  // `const activityEvents = 0` beside `if (false) await
  // recordActivityEvents(allLogs, …)` left this green at the usual tally while
  // the scan wrote no rows at all. Reachability in general is not decidable
  // here, but it does not have to be — the scan USES the ledger's return as its
  // `activityEvents` count, so anchoring on calls that initialise a binding
  // both ignores a discarded decoy and describes what the real call is for.
  // Requiring exactly one is the same argument the one-destructuring rule below
  // makes: with no second candidate there is nothing for a decoy to hide behind.
  {
    const insideLedger = (n) => {
      for (let p = n.parent; p; p = p.parent) if (p === ledgerNode) return true;
      return false;
    };
    // Is this call the initialiser of a variable declaration — i.e. is its
    // result kept? `await` and assertions sit between the two, so peel them.
    const resultIsBound = (call) => {
      let cur = call;
      for (let p = cur.parent; p; cur = p, p = p.parent) {
        if (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p) ||
            ts.isAsExpression(p) || ts.isNonNullExpression(p)) continue;
        if (ts.isVariableDeclaration(p) && p.initializer === cur) return true;
        // ...or ASSIGNED to a binding declared earlier (Codex round-29 P2).
        // `let activityEvents: number; activityEvents = await …` is the ordinary
        // equivalent — often the only way to write it when the declaration needs
        // an explicit type — and requiring declaration and initialisation to be
        // one statement rejected it inside `typecheck`. What matters is that the
        // result is KEPT, not the syntax that keeps it.
        return (
          ts.isBinaryExpression(p) &&
          p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          p.right === cur &&
          ts.isIdentifier(unwrapAssertions(p.left))
        );
      }
      return false;
    };
    const callSites = [];
    const findCalls = (n) => {
      // A self-recursive call is not the scan feeding the ledger, so it cannot
      // stand in for one.
      if (
        ts.isCallExpression(n) &&
        bareIdentifierOf(n.expression) === LEDGER_FN &&
        !insideLedger(n) &&
        resultIsBound(n)
      ) {
        callSites.push(n);
      }
      ts.forEachChild(n, findCalls);
    };
    ts.forEachChild(sourceFile, findCalls);
    const disconnected = callSites.filter((c) => {
      const first = c.arguments[0] && unwrapAssertions(c.arguments[0]);
      return !first || !ts.isIdentifier(first);
    });
    if (callSites.length > 1) {
      console.error(
        `[check-activity-refs-coverage] ${LEDGER_FN}() result is bound in ${callSites.length}\n` +
          '  places. This script cannot tell which one the scan actually runs, and a second\n' +
          '  one is how a decoy hides a disconnected live call. Keep one, or update this\n' +
          '  script — do not delete the check.',
      );
      process.exit(1);
    }
    if (callSites.length === 0 || disconnected.length) {
      console.error(
        `[check-activity-refs-coverage] ${LEDGER_FN}() is ${
          callSites.length === 0
            ? 'never called in a way that keeps its result'
            : 'called with a literal first argument'
        }.\n` +
          '  Every other check here reads that function\'s body, which says nothing about the\n' +
          '  rows unless the scan hands it the logs it decoded — passing `[]` writes no\n' +
          '  activity rows at all while leaving every count in this script identical, and a\n' +
          '  call whose result is discarded (an `if (false)` decoy) is not the scan running\n' +
          '  it. Bind the result and pass the decoded-log binding, or update this script —\n' +
          '  do not delete the check.',
      );
      process.exit(1);
    }
  }
  // The call must SUPPLY THE ROW's references, not merely appear (Codex round-21
  // P2), and it must be the ONLY such binding (Codex round-22 P2). Round 21
  // anchored on the destructuring that names the reference fields but stopped at
  // the first one it found, so an earlier decoy binding — `const { loanId } =
  // pluckActivityRefs(…)` above the real one — satisfied it while the row was
  // filled from a hand-rolled all-null object.
  //
  // Deciding WHICH binding reaches the INSERT is dataflow this script does not
  // do. Requiring there to be exactly one is the same guarantee for a fraction
  // of the machinery: a second binding of these names inside the ledger is
  // refused outright, so there is nothing for a decoy to hide behind and a
  // genuine refactor that needs two gets a loud message instead of a silent
  // pass.
  const bindings = [];
  const findBinding = (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      n.name &&
      ts.isObjectBindingPattern(n.name) &&
      n.name.elements.some((el) => {
        if (!ts.isBindingElement(el)) return false;
        // The PROPERTY taken, not the local alias: `const { loanId: x } = …`
        // reads the reference field just as `const { loanId } = …` does, and
        // keying on the alias let a renamed decoy binding slip past the
        // one-binding rule entirely.
        const key = el.propertyName ?? el.name;
        return (
          (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) &&
          REF_FIELDS.includes(key.text)
        );
      })
    ) {
      bindings.push(n);
      return;
    }
    ts.forEachChild(n, findBinding);
  };
  if (ledgerNode.body) findBinding(ledgerNode.body);
  if (bindings.length === 0) {
    console.error(
      `[check-activity-refs-coverage] ${LEDGER_FN}() no longer destructures\n` +
        `  ${REF_FIELDS.join(' / ')} from anything, so this script cannot tell where the row's\n` +
        '  references come from. If the ledger changed shape, update this script — do not\n' +
        '  delete the check.',
    );
    process.exit(1);
  }
  if (bindings.length > 1) {
    console.error(
      `[check-activity-refs-coverage] ${LEDGER_FN}() destructures\n` +
        `  ${REF_FIELDS.join(' / ')} in ${bindings.length} places. This script cannot tell which one\n` +
        '  reaches the activity_events insert, and a second binding is exactly how a\n' +
        '  decoy hides a row filled from somewhere else. Keep one, or update this\n' +
        '  script — do not delete the check.',
    );
    process.exit(1);
  }
  // The LOCAL name each reference was bound to, which is not always the field
  // name (Codex round-24 P2). The discovery above deliberately keys on the
  // PROPERTY taken, so `const { loanId: rowLoanId } = …` is a valid binding —
  // and then the SQL check below compared the bind argument against the hardcoded
  // `loanId`, rejecting a harmless refactor the rest of this script supports.
  // Carry the alias through instead.
  const localOf = new Map();
  for (const el of bindings[0].name.elements) {
    if (!ts.isBindingElement(el)) continue;
    const key = el.propertyName ?? el.name;
    if (
      (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) &&
      REF_FIELDS.includes(key.text) &&
      ts.isIdentifier(el.name)
    ) {
      localOf.set(key.text, el.name.text);
    }
  }
  // ...and nothing may WRITE those locals afterwards (Codex round-25 P2).
  // Everything downstream reasons about where the bind argument's identifier was
  // declared; it never asks whether the value still is what was declared. Change
  // the binding to `let` and add `loanId = 999`, and the destructuring is still
  // unique, still from the mapper, still lined up with `loan_id` — and every row
  // is filed under loan 999. One assignment defeats the entire chain, so refuse
  // any write to these names inside the ledger.
  //
  // Blunt on purpose: a legitimate reason to reassign a reference between the
  // mapper and the INSERT is hard to imagine, and if one appears the message
  // says so rather than the guarantee quietly weakening.
  {
    const writtenAnywhere = (root, name) => {
      let found = false;
      const walk = (n) => {
        if (found) return;
        if (writesName(n, name)) {
          found = true;
          return;
        }
        ts.forEachChild(n, walk);
      };
      if (root) walk(root);
      return found;
    };
    const rebound = [...localOf.values()].filter((local) =>
      writtenAnywhere(ledgerNode.body, local),
    );
    if (rebound.length) {
      console.error(
        `[check-activity-refs-coverage] ${LEDGER_FN}() writes to ${rebound.join(' / ')} after\n` +
          '  destructuring it from pluckActivityRefs. Every check below this point matches\n' +
          '  the bind argument by NAME, so a reassignment keeps all of them green while the\n' +
          '  rows carry whatever was assigned. Leave the mapper\'s values alone, or update\n' +
          '  this script — do not delete the check.',
      );
      process.exit(1);
    }
  }
  const init = bindings[0].initializer && unwrapAssertions(bindings[0].initializer);
  const boundFrom = init && ts.isCallExpression(init) ? bareIdentifierOf(init.expression) : null;
  // ...and it must be handed THIS log's event name and decoded arguments (Codex
  // round-22 P2). `pluckActivityRefs('LoanRepaid', {})` is the checked function,
  // called from the right place, binding the right names — and it dispatches
  // every log through one case with `Number(undefined)` for the id. Validating
  // the callee's spelling says nothing about what it was asked.
  //
  // Shape, not identity: each argument must be a plain read (an identifier or a
  // property path), not a literal or a constructed object. That is what
  // separates the live call from a pinned one, and it is checkable without
  // resolving bindings.
  if (init && ts.isCallExpression(init)) {
    // A plain read is not necessarily the EVENT NAME (Codex round-23 P2).
    // `pluckActivityRefs(log.transactionHash, args)` is a plain read, type-
    // correct, and misses every case — so the row takes the all-null fallback
    // while the tally is untouched. The first argument must name the event.
    //
    // ...and BOTH arguments must come from the CURRENT loop item (Codex rounds
    // 24 and 25 P2). Round 24 required a bare-identifier receiver, which
    // `logs[0].eventName` fails but `const firstLog = logs[0]` passes; and it
    // left the second argument as any plain read, which `logs[0].args` passes
    // outright. Either way every row after the first is dispatched under the
    // first log's name and reads the first log's ids — a per-row corruption
    // that leaves the tally identical.
    //
    // "Bare identifier" was always the wrong question. The right one is whether
    // the expression resolves to THE ITEM THIS ITERATION IS PROCESSING, so
    // anchor on the enclosing `for...of` and require both arguments to read the
    // loop's own binding.
    let loopVar = null;
    for (let p = bindings[0].parent; p; p = p.parent) {
      if (isFunctionLike(p)) break; // never cross out of the ledger
      if (
        ts.isForOfStatement(p) &&
        ts.isVariableDeclarationList(p.initializer) &&
        p.initializer.declarations.length === 1 &&
        ts.isIdentifier(p.initializer.declarations[0].name)
      ) {
        loopVar = { name: p.initializer.declarations[0].name.text, body: p.statement, node: p };
        break;
      }
    }
    if (!loopVar) {
      console.error(
        `[check-activity-refs-coverage] the pluckActivityRefs binding in ${LEDGER_FN}()\n` +
          '  is not inside a `for (const log of logs)` loop over a single binding, so this\n' +
          '  script cannot tell which log each row is built from — and "the current item"\n' +
          '  is the whole question rounds 24/25 turned on. If the ledger changed shape,\n' +
          '  update this script — do not delete the check.',
      );
      process.exit(1);
    }
    // Locals declared INSIDE the loop body that read a property off the loop
    // binding: `let args = log.args` maps args → 'args'; `const { eventName } =
    // log` maps eventName → 'eventName'. This is what lets the live ledger pass
    // — it reads `log.args` into `args` and then enriches it — while keeping the
    // receiver anchored to the loop item.
    //
    // Writes to these locals ARE checked, but not banned outright (Codex
    // round-26 P2). Round 25 left them unchecked on the grounds that the live
    // enrichment reassigns `args = { ...args, creator }` and a ban would reject
    // the code this guardrail was built around. That reasoning was right about
    // the enrichment and wrong about everything else: adding
    // `args = logs[0].args` on the next line passed, and every row after the
    // first then read the first log's ids — the exact corruption this round
    // exists to prevent, reached by one extra statement.
    //
    // The enrichment has a shape, so require it. A write is accepted only when
    // its right-hand side is an object literal that SPREADS THE SAME BINDING —
    // `{ ...args, creator }` — which preserves this log's arguments by
    // construction and cannot smuggle another log's in. Every other write
    // disqualifies the local.
    //
    // Resolution is LEXICAL, from the call site outward (Codex round-26 P2). A
    // map keyed by identifier text and filled from the whole loop body answers
    // for a name that is not the one the call uses: a sibling block containing
    // `const pinnedEventName = log.eventName` validated an OUTER
    // `pinnedEventName = logs[0].eventName` passed to the mapper, and every row
    // after the first dispatched under the first event. Names are not unique
    // across scopes, so the only sound question is which DECLARATION this
    // identifier refers to — walk out from the call through enclosing blocks and
    // take the nearest, stopping at the loop body so an outer binding is never
    // accepted.
    /**
     * The nearest declaration of `name` visible at `from`, within the loop —
     * or the sentinel `OPAQUE_BINDING` when the nearest binder is one this
     * script cannot read through.
     *
     * "A variable statement" is not what a binding is (Codex round-27 P2).
     * Ignoring every other binder made `catch (args)` invisible, so an
     * identifier bound to a caught value resolved to an outer
     * `let args = log.args` and the mapper was validated against a binding it
     * does not use. The fix is not a catch-clause special case: the resolver has
     * to know that OTHER binding forms exist and refuse the ones it cannot
     * follow, rather than looking past them to a declaration further out.
     */
    const OPAQUE_BINDING = Symbol('opaque binding');
    const bindsName = (node, name) => {
      // Catch clauses, function parameters and for-of/for-in initialisers all
      // bind. None is followable to a loop-item property, so each is opaque.
      if (ts.isCatchClause(node) && node.variableDeclaration) {
        return declaresName(node.variableDeclaration.name, name);
      }
      if (isFunctionLike(node)) {
        return (node.parameters ?? []).some((p) => declaresName(p.name, name));
      }
      if (
        (ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node)) &&
        node.initializer &&
        ts.isVariableDeclarationList(node.initializer)
      ) {
        return node.initializer.declarations.some((d) => declaresName(d.name, name));
      }
      return false;
    };
    const nearestDecl = (from, name) => {
      for (let scope = from; scope; scope = scope.parent) {
        // A binder ON THE WAY OUT shadows anything further out, even when this
        // script cannot say what it holds. Looking past it is the bug.
        if (bindsName(scope, name)) {
          // The loop's own binding is the one legitimate case — `log` itself.
          if (scope === loopVar.node && name === loopVar.name) return null;
          return OPAQUE_BINDING;
        }
        const stmts =
          ts.isBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)
            ? scope.statements
            : null;
        if (stmts) {
          for (const st of stmts) {
            if (!ts.isVariableStatement(st)) continue;
            for (const d of st.declarationList.declarations) {
              if (declaresName(d.name, name)) return d;
            }
          }
        }
        if (scope === loopVar.body) break;
      }
      return null;
    };
    /**
     * Every write to `name` that targets THIS binding, nested closures included.
     *
     * Resolved, not text-matched (Codex round-29 P2). Round 28 fixed exactly
     * this in `mutatedInPlace` and left the reassignment scan comparing
     * spelling, so an unrelated nested `{ let args = …; args = … }` invalidated
     * the real outer binding — a false positive that blocks `typecheck`. Third
     * site in this file where "same name" was standing in for "same binding".
     */
    const writesTo = (name, declOfInterest) => {
      const found = [];
      const walk = (n) => {
        if (writesName(n, name) && nearestDecl(n, name) === declOfInterest) found.push(n);
        ts.forEachChild(n, walk);
      };
      walk(loopVar.body);
      return found;
    };
    /**
     * Does a write PRESERVE the binding — `args = { ...args, creator }`?
     *
     * "Contains a self-spread" is not enough (Codex round-27 P2). Later
     * definitions win, so `args = { ...args, ...logs[0].args, creator }` spreads
     * self and then overwrites this log's reference fields with the first log's.
     * That is the SAME ordering rule {objectLiteralView} exists for, and not
     * applying it here was an inconsistency inside one file rather than a new
     * question — so ask it the same way: the self-spread must survive as the
     * last thing defining the reference fields.
     */
    const preservesSelf = (n, name) => {
      if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        return false;
      }
      const rhs = unwrapAssertions(n.right);
      if (!ts.isObjectLiteralExpression(rhs)) return false;
      let selfSpreadAt = -1;
      let idx = -1;
      let overriddenAfter = false;
      for (const p of rhs.properties) {
        idx += 1;
        if (ts.isSpreadAssignment(p)) {
          const src = unwrapAssertions(p.expression);
          if (ts.isIdentifier(src) && src.text === name) selfSpreadAt = idx;
          else if (selfSpreadAt >= 0) overriddenAfter = true; // another bag wins
          continue;
        }
        // An explicit key after the self-spread is fine UNLESS it could BE a
        // reference. The bag being spread here is the DECODED ABI ARGUMENTS, so
        // the names that matter are the ABI's own — `lenderOfferId`,
        // `oldLoanId`, the nested `fields` root — not the two normalised column
        // names (Codex round-28 P2). Checking only `loanId`/`offerId` let
        // `{ ...args, lenderOfferId: logs[0].args.lenderOfferId }` through, which
        // is a reference this checker itself derives and maps.
        //
        // `creator` — the live enrichment — is neither shape, so it stays legal.
        const key =
          ts.isPropertyAssignment(p) &&
          (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))
            ? p.name.text
            : ts.isShorthandPropertyAssignment(p)
              ? p.name.text
              : null;
        if (selfSpreadAt >= 0 && (key === null || couldBeReference(key))) {
          overriddenAfter = true; // a reference-shaped key, or one this parser cannot read
        }
      }
      return selfSpreadAt >= 0 && !overriddenAfter;
    };
    /**
     * Is the OBJECT behind `name` mutated in place — `decoded.loanId = …`?
     *
     * Following reassignment of the identifier and not mutation of what it
     * points at left `const decoded = args; decoded.loanId = logs[0].args.loanId`
     * fully accepted (Codex round-27 P2). `mutatesShadowable` already asks this
     * of `args` a few hundred lines up; the alias chain deserves the same
     * question, or renaming the binding is enough to escape the check.
     */
    const mutatedInPlace = (name, declOfInterest) => {
      let found = false;
      const rootOf = (e) => {
        let cur = unwrapAssertions(e);
        while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
          cur = unwrapAssertions(cur.expression);
        }
        return cur;
      };
      const walk = (n) => {
        if (found) return;
        const target =
          ts.isBinaryExpression(n) && ts.isAssignmentOperator?.(n.operatorToken.kind)
            ? n.left
            : (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
                (n.operator === ts.SyntaxKind.PlusPlusToken ||
                  n.operator === ts.SyntaxKind.MinusMinusToken)
              ? n.operand
              : ts.isDeleteExpression(n)
                ? n.expression
                : null;
        if (target) {
          const t = unwrapAssertions(target);
          // Only a PROPERTY write counts here; a plain reassignment is the
          // `writesTo` question, already asked separately.
          if (ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t)) {
            const root = rootOf(t);
            // ...and it must be THIS binding, not a shadowed namesake (Codex
            // round-28 P2). Comparing identifier text alone meant an unrelated
            // inner `const args = { harmless: 1 }; args.harmless = 2;` failed
            // the real mapper argument — and since this script runs inside
            // `typecheck`, that blocks the build on an ordinary nested refactor.
            // A false positive here costs more than the hole it was closing.
            if (ts.isIdentifier(root) && root.text === name &&
                nearestDecl(n, name) === declOfInterest) {
              found = true;
            }
          }
        }
        ts.forEachChild(n, walk);
      };
      walk(loopVar.body);
      return found;
    };
    /** Which loop-item property `name` resolves to here, or null. */
    const resolvesTo = (from, name, depth = 0) => {
      if (depth > 8) return null; // a rename chain this long is not real code
      // A write that does not demonstrably preserve the binding breaks the
      // chain: the declaration no longer proves what the value is. So does a
      // mutation of the object it points at, which leaves the binding intact
      // and the VALUE wrong.
      const decl = nearestDecl(from, name);
      if (writesTo(name, decl).some((w) => !preservesSelf(w, name))) return null;
      if (mutatedInPlace(name, decl)) return null;
      // A binder this script cannot read through shadows whatever is further
      // out, so the honest answer is "unknown", not the outer declaration.
      if (decl === OPAQUE_BINDING) return null;
      if (!decl || !decl.initializer) return null;
      const rhs = unwrapAssertions(decl.initializer);
      if (ts.isObjectBindingPattern(decl.name)) {
        if (!ts.isIdentifier(rhs) || rhs.text !== loopVar.name) return null;
        for (const el of decl.name.elements) {
          if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
          if (el.name.text !== name) continue;
          const key = el.propertyName ?? el.name;
          if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) return key.text;
        }
        return null;
      }
      if (ts.isPropertyAccessExpression(rhs)) {
        const recv = unwrapAssertions(rhs.expression);
        // ...and the INITIALISER's receiver is resolved too (Codex round-29 P2).
        // Round 28 fixed the direct-argument receiver and left this one matching
        // spelling, so a nested `const log = logs[0]` plus `const args = log.args`
        // resolved as if it were the loop item. Same defect, one hop further in.
        return ts.isIdentifier(recv) &&
          recv.text === loopVar.name &&
          nearestDecl(decl, recv.text) === null
          ? rhs.name.text
          : null;
      }
      // A rename of a loop-local is still the loop item's property; resolve it
      // from the DECLARATION's position so shadowing is respected at each hop.
      if (ts.isIdentifier(rhs)) return resolvesTo(decl, rhs.text, depth + 1);
      return null;
    };
    const readsLoopItem = (a, prop) => {
      const cur = unwrapAssertions(a);
      if (ts.isPropertyAccessExpression(cur)) {
        const recv = unwrapAssertions(cur.expression);
        // The receiver is RESOLVED, not text-matched (Codex round-28 P2). Round
        // 27 taught the identifier branch to resolve lexically and left this one
        // comparing spelling, so `catch (log)` shadowing the loop item made
        // `log.eventName` satisfy it while referring to the caught value.
        // `nearestDecl` returns null for the loop's own binding and
        // OPAQUE_BINDING for anything shadowing it.
        return (
          cur.name.text === prop &&
          ts.isIdentifier(recv) &&
          recv.text === loopVar.name &&
          nearestDecl(init, recv.text) === null
        );
      }
      if (ts.isIdentifier(cur)) return resolvesTo(init, cur.text) === prop;
      return false;
    };
    if (
      init.arguments.length !== 2 ||
      !readsLoopItem(init.arguments[0], DISCRIMINANT_PROP) ||
      !readsLoopItem(init.arguments[1], ARGS_PROP)
    ) {
      console.error(
        `[check-activity-refs-coverage] ${LEDGER_FN}() must call pluckActivityRefs with\n` +
          `  the current log's \`${DISCRIMINANT_PROP}\` and \`${ARGS_PROP}\` — read off \`${loopVar.name}\`, the\n` +
          '  binding the enclosing loop is on, or off a local declared inside that loop\n' +
          '  from it.\n' +
          '  A pinned event name, a constructed bag, or a read off a DIFFERENT log\n' +
          `  (\`${loopVar.name}s[0].${DISCRIMINANT_PROP}\`, a hoisted \`firstLog\`) dispatches every row\n` +
          '  through one case and stores that log\'s ids on every other row, while every\n' +
          '  count here stays identical. Fix the call, or update this script — do not\n' +
          '  delete the check.',
      );
      process.exit(1);
    }
  }
  // ...and the bound names must reach the MATCHING SQL COLUMNS (Codex round-23
  // P2). Uniqueness of the binding says where the values come from, not where
  // they go: swapping `loanId` and `offerId` in the `.bind(...)` list leaves one
  // accepted destructuring, typechecks, and files every reference under the
  // other reference's column, with the tally unmoved.
  //
  // Full dataflow is out of reach, but this particular question is not: the
  // INSERT names its columns in order and `.bind()` supplies them positionally,
  // so the column list and the bind list can simply be lined up. Read the column
  // names out of the SQL, find where `loan_id` / `offer_id` sit, and require the
  // bind argument at each of those positions to be the identifier destructured
  // for it.
  //
  // Take EVERY such INSERT, not the first (Codex round-26 P2). Stopping at the
  // first textual match let an unreachable decoy answer for the real one: an
  // `if (false)` insert naming the columns in the expected order, placed above a
  // live insert whose binds were swapped, left this green at the usual tally
  // while every reference persisted into the other reference's column. Which of
  // two inserts executes is not a question this script can answer, so it refuses
  // to be asked — one activity_events insert in the ledger, or a loud message.
  {
    const COLUMN_OF = { loanId: 'loan_id', offerId: 'offer_id' };
    /**
     * The declaration an identifier at `from` actually refers to, searching
     * outward to the ledger body — so a nearer binding that merely shares the
     * name is distinguishable from the mapper's own (Codex round-29 P2).
     *
     * Deliberately a local resolver: the question here is only "is this the
     * destructuring", which plain variable declarations answer. Any binder it
     * cannot read through returns a distinct sentinel rather than the outer
     * declaration, so an unreadable shadow fails closed.
     */
    const SHADOWED = Symbol('shadowed by an unreadable binder');
    const bindingOfIdentifier = (from, name) => {
      for (let scope = from; scope; scope = scope.parent) {
        if (
          (ts.isCatchClause(scope) && scope.variableDeclaration) ||
          isFunctionLike(scope)
        ) {
          return SHADOWED;
        }
        const stmts =
          ts.isBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)
            ? scope.statements
            : null;
        if (stmts) {
          for (const st of stmts) {
            if (!ts.isVariableStatement(st)) continue;
            for (const d of st.declarationList.declarations) {
              if (declaresName(d.name, name)) return d;
            }
          }
        }
        if (scope === ledgerNode.body) break;
      }
      return null;
    };
    const inserts = [];
    const findInsert = (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'bind'
      ) {
        const text = n.expression.expression.getText(sourceFile);
        if (/INSERT\s+(OR\s+\w+\s+)?INTO\s+activity_events/i.test(text)) {
          inserts.push({ sql: text, args: n.arguments });
        }
      }
      ts.forEachChild(n, findInsert);
    };
    if (ledgerNode.body) findInsert(ledgerNode.body);
    if (inserts.length > 1) {
      console.error(
        `[check-activity-refs-coverage] ${LEDGER_FN}() contains ${inserts.length} activity_events\n` +
          '  INSERTs. This script lines the column list up against the bind list positionally,\n' +
          '  which says nothing about the row if a second insert is the one that runs — and a\n' +
          '  decoy with the columns in the right order is exactly how a swapped live bind\n' +
          '  hides. Keep one, or update this script — do not delete the check.',
      );
      process.exit(1);
    }
    const insertSql = inserts[0]?.sql ?? null;
    const bindArgs = inserts[0]?.args ?? null;
    if (!bindArgs) {
      console.error(
        `[check-activity-refs-coverage] could not find the activity_events INSERT's\n` +
          `  \`.bind(...)\` inside ${LEDGER_FN}(). Without it this script cannot tell whether\n` +
          '  the mapped references reach their own columns. If the write changed shape,\n' +
          '  update this script — do not delete the check.',
      );
      process.exit(1);
    }
    const cols = (insertSql.match(/\(([^()]*?)\)\s*\n?\s*VALUES/is)?.[1] ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    for (const field of REF_FIELDS) {
      const at = cols.indexOf(COLUMN_OF[field]);
      if (at === -1) {
        console.error(
          `[check-activity-refs-coverage] the activity_events INSERT no longer names a\n` +
            `  \`${COLUMN_OF[field]}\` column, so this script cannot check that ${field} reaches it.\n` +
            '  Update this script — do not delete the check.',
        );
        process.exit(1);
      }
      const expected = localOf.get(field) ?? field;
      const arg = bindArgs[at] && unwrapAssertions(bindArgs[at]);
      // Matched by DECLARATION, not by spelling (Codex round-29 P2). A nearer
      // binding of the same name — `{ const loanId = 999; …bind(…, loanId, …) }`
      // — satisfied a text comparison while filing every row under 999. This is
      // the last of the four places in this file where "same name" stood in for
      // "same binding"; `bindingOfIdentifier` is the shared answer.
      const sameBinding =
        arg &&
        ts.isIdentifier(arg) &&
        arg.text === expected &&
        bindingOfIdentifier(arg, expected) === bindings[0];
      if (!sameBinding) {
        console.error(
          `[check-activity-refs-coverage] the activity_events INSERT binds\n` +
            `  \`${arg ? arg.getText(sourceFile) : '(nothing)'}\` into its \`${COLUMN_OF[field]}\` column, not the\n` +
            `  \`${expected}\` destructured from pluckActivityRefs.\n` +
            '  Every row would file that reference under the wrong column, or under a nearer\n' +
            '  binding that shares the name, while every count here stays identical. Fix the\n' +
            '  binding, or update this script — do not delete the check.',
        );
        process.exit(1);
      }
    }
  }

  if (boundFrom !== 'pluckActivityRefs') {
    console.error(
      `[check-activity-refs-coverage] ${LEDGER_FN}() takes its activity_events references\n` +
        `  from ${boundFrom ? `\`${boundFrom}()\`` : 'something that is not a function call'}, not from pluckActivityRefs().\n` +
        '  This script reads pluckActivityRefs to decide which events carry a reference, so\n' +
        '  a ledger filled from somewhere else would report full coverage while writing NULL\n' +
        '  loan_id / offer_id. Restore the call, or update this script — do not delete the\n' +
        '  check.',
    );
    process.exit(1);
  }
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
      // `EnumDeclaration` included (Codex round-18 P2): an enum binds its name in
      // the enclosing scope exactly as a class does, and the `args`/`Number`
      // walk further down already knew that. Two whitelists of the same thing
      // drifted apart, which is the argument for the shared `bindsName` below
      // rather than for a third list.
      (ts.isVariableDeclaration(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isClassDeclaration(n) ||
        ts.isEnumDeclaration(n) ||
        ts.isParameter(n)) &&
      bindsName(n.name, discriminantName)
    ) {
      shadowsDiscriminant = true;
      return;
    }
    // A WRITE shadows the parameter just as a declaration does (Codex round-21
    // P2). `eventName = 'LoanRepaid'` before the switch leaves the binding
    // intact — nothing is redeclared — and sends every decoded event through
    // one case, with the tally unmoved. Rounds 16-18 kept widening WHICH
    // declarations bind the name and never asked whether the name still holds
    // the argument it was handed.
    if (writesName(n, discriminantName)) {
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
/**
 * The switch must be a TOP-LEVEL statement of the mapper (Codex round-19 P2).
 *
 * Rounds 14 and 16 stopped a switch standing in for the live path when it was in
 * an uncalled helper, then when an unconditional exit preceded it. A descendant
 * search still admits the third variant: wrap the live switch in
 * `if (args.__dispatch === true)` and return the all-null object after it, and
 * every ordinary event takes the bypass while the tally is untouched. What the
 * check actually needs is that the switch DOMINATES the function's exit, and for
 * a mapper shaped like this one that is exactly "it is a statement of the body",
 * which is cheap and exact where a dominance analysis would be neither.
 *
 * A future mapper that legitimately nests it gets a loud refusal rather than a
 * silent pass — the same posture as every other shape this checker cannot read.
 */
const findSwitch = (node) => {
  if (switchNode) return;
  if (!ts.isSwitchStatement(node)) return;
  // A switch on something else does not disqualify the body — a future mapper
  // may dispatch on a sub-key first — but the one this check uses must be on the
  // event-name parameter, and the rejected one is named so the message is
  // actionable.
  if (discriminantName && bareIdentifierOf(node.expression) === discriminantName) {
    switchNode = node;
    return;
  }
  if (!sawOtherSwitch) sawOtherSwitch = node.expression.getText();
};
/**
 * ...and the switch must be REACHABLE (Codex round-16 P2).
 *
 * Round 14 stopped a switch in an uncalled helper from standing in for the live
 * path. The same substitution works one level up: a `return { …all null }` placed
 * immediately above the live switch leaves it syntactically present and never
 * executed, and every count stays identical. Statement order at the top level is
 * enough to see it. (Round 16 exempted conditional exits as "fine and common";
 * round 20 showed a conditional exit is the same bypass and removed the
 * exemption — see `canExit` below.)
 */
/**
 * CAN control leave the function at this statement? (Codex round-20 P2.)
 *
 * Rounds 17 and 18 asked whether a pre-switch statement leaves the function on
 * EVERY path, growing block / if-else / try-finally handling to answer it. That
 * question was the wrong one. A bypass does not have to be unconditional to be a
 * bypass: `if (args.__dispatch !== true) return { …all null };` above the switch
 * takes every ordinary event down the all-null path while a must-exit test sees a
 * one-armed `if` and waves it through — the exact evasion the previous two rounds
 * were closing, one `if` away from where they stopped.
 *
 * So the test is MAY-exit, not must-exit: any `return` or `throw` reachable from a
 * statement that precedes the switch (nested functions excluded — those are not on
 * this path until called) means the switch does not dominate the function's exit,
 * which is the whole property this scan exists to establish. That collapses the
 * three grown cases into one descendant walk.
 *
 * The mapper has no pre-switch statements at all, so this refuses nothing that
 * exists today. A future mapper that legitimately guards before dispatching gets a
 * loud refusal to update this script — the same posture as every other shape the
 * checker cannot read, and the opposite of a silent pass.
 */
const canExit = (node) => {
  if (isFunctionLike(node)) return false;
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
  let found = false;
  ts.forEachChild(node, (c) => {
    found = found || canExit(c);
  });
  return found;
};
// The switch is located FIRST, and only then is what precedes it examined. The
// two questions have different answers and different fixes, and scanning for
// early exits while still looking for the switch reports the wrong one: with the
// switch unrecognised — nested, or on the wrong discriminant — the scan runs past
// it and trips on the mapper's own trailing all-null `return`, replacing an
// actionable "switch is on `X`, not `eventName`" with a bypass report about a
// statement that is not a bypass.
let switchIndex = -1;
if (fnNode.body) {
  fnNode.body.statements.forEach((st, i) => {
    if (switchNode) return;
    findSwitch(st);
    if (switchNode) switchIndex = i;
  });
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
for (const st of fnNode.body.statements.slice(0, switchIndex)) {
  if (!canExit(st)) continue;
  console.error(
    '[check-activity-refs-coverage] pluckActivityRefs() can leave before its event\n' +
      '  switch, so the switch may never run and events would be stored with all\n' +
      '  references NULL — while this check reads the cases and reports them mapped.\n' +
      '  CONDITIONAL early exits are refused too: a guard that returns the all-null\n' +
      '  object bypasses the switch for whichever events match it, and the tally cannot\n' +
      '  see the difference. Remove the early exit, or update this script — do not\n' +
      '  delete the check.',
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
  // A `try` completes abruptly when the relevant branches do (Codex round-30 P2).
  // `try { return …; } finally {}` is an ordinary refactor and reads as
  // "falls through" to a helper that only knew blocks and `if`s, which then
  // merged the case with its neighbour and rejected both mappings inside
  // `typecheck`. The rules are the language's: a `finally` that itself exits
  // decides the whole statement; otherwise the try block must exit AND, if a
  // catch exists, the catch must too.
  if (ts.isTryStatement(stmt)) {
    if (stmt.finallyBlock && alwaysExits(stmt.finallyBlock)) return true;
    if (!alwaysExits(stmt.tryBlock)) return false;
    return !stmt.catchClause || alwaysExits(stmt.catchClause.block);
  }
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
  // A `try` completes abruptly when the relevant branches do (Codex round-30 P2).
  // `try { return …; } finally {}` is an ordinary refactor and reads as
  // "falls through" to a helper that only knew blocks and `if`s, which then
  // merged the case with its neighbour and rejected both mappings inside
  // `typecheck`. The rules are the language's: a `finally` that itself exits
  // decides the whole statement; otherwise the try block must exit AND, if a
  // catch exists, the catch must too.
  if (ts.isTryStatement(stmt)) {
    if (stmt.finallyBlock && alwaysReturns(stmt.finallyBlock)) return true;
    if (!alwaysReturns(stmt.tryBlock)) return false;
    return !stmt.catchClause || alwaysReturns(stmt.catchClause.block);
  }
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
  //
  // Bracket access with a STATIC string literal — `args['loanId']` — is the same
  // read as `args.loanId` and is accepted alongside it (Codex round-20 P2). It is
  // not an evasion but ordinary TypeScript: an ABI field whose name is not a valid
  // identifier (or one a linter's dot-notation rule exempts) can only be read this
  // way, and rejecting it made the checker demand a mapping it would then refuse.
  // A COMPUTED index (`args[key]`) stays rejected — the field it reads is not
  // knowable statically, so it cannot establish coverage of a named reference.
  const parts = [];
  let cur = unwrap(expr.arguments[0]);
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) {
      parts.unshift(cur.name.text);
      cur = unwrap(cur.expression);
      continue;
    }
    if (ts.isElementAccessExpression(cur)) {
      const idx = unwrap(cur.argumentExpression);
      if (!idx || !ts.isStringLiteralLike(idx)) return null;
      parts.unshift(idx.text);
      cur = unwrap(cur.expression);
      continue;
    }
    break;
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
    const outerAlias = aliasesShadowable(n);
    if (outerAlias) {
      outerShadow = `${outerAlias} (an alias of args/Number)`;
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
      // The all-null fallback is by design — but it is an ASSUMPTION until read
      // (Codex round-22 P2). Every event without an explicit case lands here,
      // including all 66 allowlisted ones, whose exemptions all say "this event
      // files no reference". A default returning `loanId: 999` attaches every one
      // of them to loan 999 with the tally unmoved, which is the widest possible
      // version of the bug this checker exists to catch — and it was the one
      // clause never looked at.
      const defaultReturns = [];
      for (const st of clause.statements) collectReturns(st, defaultReturns);
      // ZERO returns validates nothing (Codex round-23 P2). A default body of
      // `throw new Error('unmapped event')` reads as a reasonable instinct and
      // leaves this loop with nothing to iterate, so the whole check passed
      // vacuously — while at runtime the first allowlisted event aborts activity
      // recording entirely. An empty result from a validator is not a pass.
      if (defaultReturns.length === 0) {
        structural.push(
          'the default clause returns nothing this checker can find — every event without a case, and every allowlisted one, is filed from here, so it must return the all-null object rather than throw or fall through',
        );
      }
      // ONE valid return is not enough either (Codex round-24 P2). A default of
      // `if ('loanId' in args) throw …; return { …nulls };` leaves this list
      // non-empty and every reference-carrying allowlisted event still takes the
      // throw, aborting the whole activity write. Round 23 required the list to
      // be non-empty; the question is whether ANY path out of the default is not
      // that return.
      {
        const abrupt = [];
        const findAbrupt = (n) => {
          if (isFunctionLike(n)) return;
          if (ts.isThrowStatement(n)) abrupt.push('a throw');
          if (ts.isBreakStatement(n) || ts.isContinueStatement(n)) abrupt.push('a break/continue');
          ts.forEachChild(n, findAbrupt);
        };
        for (const st of clause.statements) findAbrupt(st);
        if (abrupt.length) {
          structural.push(
            `the default clause contains ${abrupt[0]} — every event without a case, and every allowlisted one, is filed from here, so it must reach the all-null return on every path`,
          );
        }
      }
      for (const r of defaultReturns) {
        // Same unwrapping as a case return (Codex round-29 P2) — a `satisfies`
        // or `as` around the fallback is ordinary and must stay readable.
        const e = r.expression && unwrapAssertions(r.expression);
        if (!e || !ts.isObjectLiteralExpression(e)) {
          structural.push(
            'the default clause returns something this checker cannot read as an object literal — every unmapped and allowlisted event is filed from here',
          );
          continue;
        }
        // Read with the SAME rules as a case return (Codex round-26 P2). Taking
        // the first matching property ignored what came after it, so appending
        // `...({ loanId: 999 } as {})` to the all-null fallback left this green
        // while attaching every unmapped and allowlisted event to loan 999 —
        // the widest version of the bug, through the one clause that had its own
        // weaker reader.
        const view = objectLiteralView(e);
        for (const field of REF_FIELDS) {
          const prop = view.props.get(field);
          if (!prop || prop.shorthand || !prop.expr || !isNullLiteral(prop.expr)) {
            structural.push(
              `the default clause does not return a null ${field} — every event without a case, and every allowlisted one, would be filed under whatever it returns instead${
                view.spread && !prop ? ' (a spread after it decides the value here)' : ''
              }`,
            );
          }
        }
      }
      // ...and what matters beyond that is anything that fell INTO it.
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
      // Unwrapped first (Codex round-29 P2): `return ({ … } satisfies ActivityRefs)`
      // and the `as` form are ordinary TypeScript, and testing the RAW node made
      // both opaque — rejecting a mapping that is perfectly readable underneath.
      const e = r.expression && unwrapAssertions(r.expression);
      if (!e || !ts.isObjectLiteralExpression(e)) return { opaque: 'not an object literal' };
      return objectLiteralView(e);
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
        if (aliasesShadowable(n)) found = found || 'aliases';
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
        // "Never returned here" and "returned by something unreadable" are
        // different answers, and only the first may be skipped (Codex round-21
        // P2). A return shaped `{ actor, ...{ loanId: 999 }, offerId: … }` names
        // no explicit `loanId`, so this `continue` ran before opacity was even
        // considered and every row for the event was filed under loan 999 with
        // the tally unmoved. Round 19 taught the scope builder that an explicit
        // property AFTER a spread survives; it left the case where there is no
        // explicit property at all.
        if (named.length === 0) {
          // `spread` (a `...x` this builder could not resolve) as well as
          // `opaque` (a whole return it could not read) — the round-19 builder
          // records the two separately, and it is the spread that carries this
          // case.
          const unreadable = scopes.filter((sc) => sc.opaque || sc.spread);
          if (unreadable.length === 0) continue; // genuinely never returned here
          suspectMappings.push({
            event: label,
            field,
            why: 'only a spread or unresolved computed key could define it, so what the row stores cannot be read here',
            expr: unreadable[0].opaque ?? 'a spread with no explicit definition after it',
          });
          continue;
        }

        // Deliberately unmapped on every path that names it, with nothing opaque.
        const allNull = named.every((s) => isNullLiteral(s.props.get(field).expr));
        // `props` now holds only definitions the spread does NOT override, so a
        // scope with a spread is still resolvable for a field defined after it.
        const anyOpaque = scopes.some((s) => s.opaque || !s.props?.has(field));
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
// ── 2b. EVERY allowlist entry is field-scoped ──────────────────────────
// Codex round-1 P2 required this of dual-carrying events; Codex round-20 P2
// showed the event-wide form is unsound for single-carrying ones too, so it is
// now the only accepted key shape.
//
// An event-wide key says "this EVENT is exempt" and therefore follows the event
// through an ABI revision. Rename `LoanSold`'s input `loanId` → `offerId` and the
// entry — whose stated reason was written about the loan reference — silently
// exempts the offer reference instead, with nothing reporting stale: the event
// still exists, still carries a reference, still is not mapped. The exemption
// outlives the thing it was granted for, which is exactly what the dead-entry
// discipline exists to prevent.
//
// `<Event>.<field>` cannot drift that way. When the field it names goes, the
// dead-entry check below reports it and a human re-states the reason against
// whatever the event carries now.
const wrongShape = [];
for (const key of Object.keys(DELIBERATELY_NOT_SCOPED)) {
  const dot = key.indexOf('.');
  const field = dot === -1 ? null : key.slice(dot + 1);
  if (!field || !REF_FIELDS.includes(field)) wrongShape.push(key);
}
if (wrongShape.length) {
  console.error(
    '\n✖ activity-refs coverage: allowlist entries must be keyed\n' +
      `  '<Event>.<field>' with field one of ${REF_FIELDS.join(' / ')}. An event-wide entry\n` +
      '  follows the event through an ABI rename and silently exempts whatever reference\n' +
      '  the event carries next, while its stated reason still describes the old one.\n' +
      '  Re-key these against the field each was actually granted for:\n',
  );
  for (const k of wrongShape) {
    const has = carries.get(k);
    console.error(`    ${k}${has ? ` (carries ${[...has].join(', ')})` : ''}`);
  }
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
    if (Object.hasOwn(DELIBERATELY_NOT_SCOPED, `${event}.${field}`)) {
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
  // Every key is field-scoped since round 20, so this fires for every rename.
  if (!has.has(field)) {
    dead.push(`${key} — the event no longer carries ${field}; remove this entry`);
    continue;
  }
  if (mapped.get(event)?.has(field)) {
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
    for (const { event, field } of gaps) {
      const arrayPath = arrayOnlyRefs.get(`${event}.${field}`);
      console.error(
        arrayPath
          ? `    ${event}.${field} — its only ${field} is \`${arrayPath}\`, an ARRAY of ids; one activity\n` +
              `      row carries one id, so which element it should be is a decision, not a lookup.\n` +
              `      Allowlist '${event}.${field}' with a reason saying which, or reshape the event.`
          : `    ${event}.${field}`,
      );
    }
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
