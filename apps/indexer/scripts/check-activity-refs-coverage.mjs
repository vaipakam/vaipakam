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

/**
 * Does this NODE introduce a binding for `name` — a catch clause, function
 * parameters, or a for/for-of/for-in initialiser?
 *
 * Hoisted beside {declaresName} and shared by every resolver (Codex round-31
 * P2). Round 30 unified the name MATCHER and left this half duplicated, so the
 * SQL-bind resolver still carried its own shorter list — it knew about catch
 * clauses and functions but not loop initialisers, and
 * `for (const loanId of [999])` around the INSERT resolved outward to the
 * mapper's destructuring. Removing the second copy is the same fix as last
 * round, finished.
 *
 * None of these is followable to a value this script can read, so each is
 * treated as opaque by callers rather than looked past.
 */
const bindsNameLexically = (node, name) => {
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

/**
 * The statically known member name of a property OR element access — `f.call`
 * and `f['call']` alike — or null when it cannot be resolved.
 *
 * ONE reader for every member lookup in this file (Codex round-37 P2). The
 * dotted-only assumption has now been fixed three times in three places —
 * `objectLiteralView`'s keys (round 12), the enrichment key reader (round 34),
 * the `Object.assign` mutator list (round 35) — and round 36's `.call` /
 * `.apply` matcher was written with it a fourth time in the same review. A
 * shared reader is what stops there being a fifth.
 */
const memberNameOf = (node) => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const arg = unwrapAssertions(node.argumentExpression);
    if (ts.isStringLiteralLike(arg)) return arg.text;
  }
  return null;
};

/**
 * Why a statement might not run on its enclosing function's own path, or null
 * when nothing between it and `stopAt` can skip it.
 *
 * ONE walk for both reachability questions (Codex round-37 P2). It was written
 * for the `activity_events` INSERT, and the very next round found the same hole
 * one level up: binding the LEDGER CALL's result does not prove the scan makes
 * it, because `if (false) { const dead = await recordActivityEvents(…) }` binds
 * a result too. Same question, same answer, so the same code.
 *
 * Blocks and ordinary loops are fine — the ledger's own `for (const log of
 * logs)` is one, and so is a nested loop over a real collection. What is
 * refused is anything that can decide NOT to reach the statement, INCLUDING a
 * loop that provably never iterates.
 *
 * Loops used to be waved through as a class (Codex round-44 P2): a body runs
 * zero times when the thing it walks is empty, so `for (const _never of [] as
 * number[])` around the INSERT is `if (false)` wearing a different hat, and
 * this walk exists to refuse `if (false)`.
 *
 * The rule here is NARROWER than "refuse loops whose execution cannot be
 * proved", and deliberately so — that version cannot be proved for a nested
 * loop over any real collection either, and it broke the round-31 case for a
 * for-of binder shadowing at the INSERT: the generic loop message subsumed a
 * check with a precise diagnosis, which is the round-38 mistake repeated. So
 * what is refused is an EMPTY LITERAL iterable and a constant-false condition —
 * the shapes nothing writes by accident — and an ordinary loop still passes.
 */
const guardedReason = (node, stopAt) => {
  for (let cur = node; cur && cur !== stopAt; cur = cur.parent) {
    const p = cur.parent;
    if (!p) break;
    if (isFunctionLike(p)) return 'inside a nested function, which nothing here calls';
    // A statement is unreachable if an EARLIER SIBLING exits unconditionally
    // (Codex round-47 P2). This walk only ever looked at ancestors — at what
    // encloses the statement — so an unconditional `throw` placed immediately
    // above the ledger call left every ancestor innocent and the call dead.
    // Guarding and preceding-exit are two different ways to not run, and only
    // the first had a case here.
    if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isCaseClause(p) || ts.isDefaultClause(p)) {
      const stmts = p.statements;
      const idx = stmts.indexOf(cur);
      for (let i = 0; i < idx; i += 1) {
        const s = stmts[i];
        if (ts.isThrowStatement(s)) return 'after an unconditional `throw`, so it is never reached';
        if (ts.isReturnStatement(s)) return 'after an unconditional `return`, so it is never reached';
        if (ts.isBreakStatement(s) || ts.isContinueStatement(s)) {
          return 'after an unconditional loop exit, so it is never reached';
        }
      }
    }
    if (
      (ts.isForOfStatement(p) || ts.isForInStatement(p)) &&
      cur === p.statement &&
      (() => {
        const it = unwrapAssertions(p.expression);
        return ts.isArrayLiteralExpression(it) && it.elements.length === 0;
      })()
    ) {
      return 'inside a loop over an empty literal, so its body never runs at all';
    }
    // NOT do-while (Codex round-45 P2, a regression round 44 introduced). A
    // `do { … } while (false)` body runs exactly once — the condition is tested
    // AFTER it — so grouping it with the other constant-false loops reported
    // that a guaranteed statement never runs. `do { } while (false)` is a real
    // idiom for a breakable block, and this would have failed it.
    if (
      (ts.isWhileStatement(p) || ts.isForStatement(p)) &&
      cur === p.statement &&
      p.expression &&
      unwrapAssertions(p.expression).kind === ts.SyntaxKind.FalseKeyword
    ) {
      return 'inside a loop whose condition is constantly false, so its body never runs';
    }
    if (ts.isConditionalExpression(p) && cur !== p.condition) {
      return 'inside a conditional expression, so it runs only on one branch';
    }
    if (
      ts.isBinaryExpression(p) &&
      (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        p.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) &&
      cur === p.right
    ) {
      return 'behind a short-circuit operator, so it runs only when the left side allows it';
    }
    if (ts.isIfStatement(p) && cur !== p.expression) {
      return 'inside an `if` branch, so it runs only on some rows';
    }
    // A switch clause is an `if` by another name (Codex round-37 P2):
    // `switch (x) { case -1: { …statement… } }` runs only when the discriminant
    // matches, and the round-36 list named every OTHER way to guard one.
    if (ts.isCaseClause(p) || ts.isDefaultClause(p)) {
      return 'inside a switch clause, so it runs only when that case matches';
    }
    // A CATCH body runs only when the try block throws (Codex round-38 P2).
    // `try { /* nothing that throws */ } catch { …call… }` is the same dead
    // placement as `if (false)`, and the round-37 list — written for the ways
    // an author guards a statement deliberately — did not have it. The try
    // block and the finally block are NOT conditional and stay accepted.
    if (ts.isCatchClause(p)) {
      return 'inside a catch block, so it runs only if the try block throws';
    }
  }
  return null;
};

/** A binder this script cannot follow to a value. It shadows; it is not read. */
const OPAQUE_BINDING = Symbol('opaque binding');

/**
 * The nearest binding of `name` at `from`, searching outward and stopping after
 * `stopAt`.
 *
 * Hoisted to module scope so BOTH resolvers share it (Codex round-33 P2). The
 * SQL-bind resolver had this and the ledger's reassignment scan did not, which
 * left the latter comparing identifier spelling — so an unrelated nested
 * `let loanId` failed the mapper's real destructuring and blocked `typecheck`.
 * Same defect as rounds 27-29 in three other places; keeping one resolver is
 * what stops it recurring in a fourth.
 *
 * @returns the `VariableDeclaration`, `OPAQUE_BINDING` for a binder this script
 *          cannot follow, or null when nothing up to `stopAt` binds the name.
 */
/**
 * THE scope walk. Every binding resolver in this file is this function with a
 * different sentinel and stop node.
 *
 * There were three copies, and the review record is the argument for there
 * being one (Codex rounds 43, 44, 45). The rule that a FUNCTION or CLASS
 * declaration binds its hoisted name in the enclosing block had to be added to
 * each of them in three consecutive rounds — module-level in 43, the loop-item
 * twin in 44, the SQL-bind resolver in 45 — because each copy was written for
 * its own question and learned nothing from the others. That is not three
 * findings; it is one missing abstraction found three times. A fourth copy would
 * have needed it in round 46.
 *
 * @param shadowSentinel returned for a binder whose value this script cannot
 *        follow — the caller's own "something nearer binds this" marker.
 * @param notAShadow optional: a binder the CALLER considers legitimate rather
 *        than shadowing (the batch loop's own item, for its resolver), resolving
 *        to null instead of the sentinel.
 * @returns a `VariableDeclaration`, `shadowSentinel`, or null when nothing up to
 *          `stopAt` binds the name.
 */
const resolveNameInScopes = (from, name, { stopAt, shadowSentinel, notAShadow }) => {
  for (let scope = from; scope; scope = scope.parent) {
    // A binder ON THE WAY OUT shadows anything further out, even when this
    // script cannot say what it holds. Looking past it is the bug.
    if (bindsNameLexically(scope, name)) {
      if (notAShadow && notAShadow(scope, name)) return null;
      return shadowSentinel;
    }
    const stmts =
      ts.isBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)
        ? scope.statements
        : null;
    if (stmts) {
      for (const st of stmts) {
        // Hoisting: a function or class declaration binds its name in the
        // enclosing block, so it shadows there even though its body does not.
        if (
          (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) &&
          st.name &&
          declaresName(st.name, name)
        ) {
          return shadowSentinel;
        }
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
          if (declaresName(d.name, name)) return d;
        }
      }
    }
    if (scope === stopAt) break;
  }
  return null;
};

const nearestDeclIn = (from, name, stopAt) =>
  resolveNameInScopes(from, name, { stopAt, shadowSentinel: OPAQUE_BINDING });


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

/**
 * Is this node a type-level wrapper that changes nothing at runtime?
 *
 * The value-side twin of {unwrapAssertions}, which walks DOWN through these;
 * callers walking UP a parent chain need the same set (Codex round-42 P2).
 * `resultIsBound` had its own hand-written list and it was missing `satisfies`,
 * so `const x = (await recordActivityEvents(…)) satisfies number` read as a
 * discarded result and blocked `typecheck`. Fifth place in this file where a
 * local copy of a shared rule fell behind it.
 */
const isTransparentWrapper = (n) =>
  ts.isParenthesizedExpression(n) ||
  ts.isAsExpression(n) ||
  ts.isNonNullExpression(n) ||
  Boolean(ts.isSatisfiesExpression?.(n)) ||
  Boolean(ts.isTypeAssertionExpression?.(n));

/**
 * The body of a function this expression IMMEDIATELY INVOKES, or null.
 *
 * For the MUTATION question, which is not the same as the throw question the
 * escape analysis asks (Codex round-44 P2). There, a non-awaited `async` IIFE is
 * skipped because its throw becomes a rejected promise that never reaches the
 * frame. Here it must NOT be skipped: an async body still runs synchronously up
 * to its first `await`, so `(async () => { args.loanId = 999 })()` mutates
 * before anything else happens. A GENERATOR is the real exemption — calling one
 * returns an iterator and runs no body at all.
 */
const invokedFunctionBodyOf = (expr) => {
  const e = unwrapForInvocation(expr);
  if (!e || !ts.isCallExpression(e)) return null;
  let callee = unwrapForInvocation(e.expression);
  // ...through `.call` / `.apply` too (Codex round-45 P2). Round 44 accepted
  // only a function in callee position, so `(() => { … }).call(null)` ran
  // synchronously before the body and was invisible. The escape analysis has
  // matched both forms since round 36; this helper, written for the same
  // question, was matching one.
  if (callee && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) {
    const via = memberNameOf(callee);
    if (via === 'call' || via === 'apply') callee = unwrapForInvocation(callee.expression);
    else return null;
  }
  if (!callee || !isFunctionLike(callee) || !callee.body) return null;
  if (callee.asteriskToken) return null;
  // An ASYNC body runs only to its first `await` (Codex round-48 P2). Round 47
  // fed the whole body to the case-mutation scan, which then failed the build on
  // `void (async () => { await x; args.loanId = 999n })()` — a mutation in a
  // continuation that cannot run before the mapper has synchronously copied its
  // references out. The synchronous prefix is genuinely synchronous and still
  // counts; what follows the suspension does not.
  //
  // Reported as a CUTOFF POSITION rather than a synthesised block: a node built
  // by `ts.factory` carries no source positions, and several scans here prune by
  // `getStart`, so handing them a synthetic body would break the very checks
  // this is meant to feed.
  return callee.body;
};

/**
 * Source position after which an invoked function's body no longer runs
 * synchronously, or `Infinity` when all of it does.
 *
 * Companion to {invokedFunctionBodyOf} — see the async reasoning there.
 */
const syncCutoffOf = (expr, sourceFile) => {
  const e = unwrapForInvocation(expr);
  if (!e || !ts.isCallExpression(e)) return Infinity;
  let callee = unwrapForInvocation(e.expression);
  if (callee && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) {
    const via = memberNameOf(callee);
    if (via === 'call' || via === 'apply') callee = unwrapForInvocation(callee.expression);
    else return Infinity;
  }
  if (!callee || !isFunctionLike(callee) || !callee.body || !ts.isBlock(callee.body)) {
    return Infinity;
  }
  const isAsync = (callee.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
  if (!isAsync) return Infinity;
  for (const st of callee.body.statements) {
    let awaitAt = null;
    const seek = (m) => {
      if (awaitAt !== null) return;
      if (ts.isAwaitExpression(m)) { awaitAt = m.getStart(sourceFile); return; }
      if (isFunctionLike(m)) return; // a nested function's awaits are its own
      ts.forEachChild(m, seek);
    };
    seek(st);
    // Everything up to the first `await` runs; the continuation after it does not.
    if (awaitAt !== null) return awaitAt;
  }
  return Infinity;
};

/** `unwrapAssertions`, usable before it is defined below. */
const unwrapForInvocation = (t) => {
  let cur = t;
  while (cur && isTransparentWrapper(cur)) cur = cur.expression;
  return cur;
};

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
/**
 * For a built-in call that WRITES THROUGH its first argument, the root of that
 * argument. Otherwise null.
 *
 * Extracted rather than written a second time (Codex round-46 P2). The ledger's
 * `mutatedInPlace` has recognised these since round 34 — and had the bracket
 * form added in 35 — while `mutatesShadowable`, asking the same question about
 * the mapper, still knew only the syntactic forms. So `Object.assign(args, {
 * loanId: 999 })` in the mapper body overwrote the decoded bag and every
 * accepted `Number(args.loanId)` then read 999.
 *
 * Recognised by CALLEE, not by "any call receiving the bag": the mapper and the
 * ledger both legitimately pass it to other functions, so a blanket rule would
 * reject live code. The list is the built-ins that write through argument zero.
 */
const mutatingCallTarget = (n) => {
  if (!ts.isCallExpression(n) || n.arguments.length === 0) return null;
  const callee = unwrapAssertions(n.expression);
  const memberName = memberNameOf(callee);
  if (memberName === null) return null;
  const host = unwrapAssertions(callee.expression);
  const mutators =
    ts.isIdentifier(host) && host.text === 'Object'
      ? ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf']
      : ts.isIdentifier(host) && host.text === 'Reflect'
        ? ['set', 'defineProperty', 'deleteProperty', 'setPrototypeOf']
        : [];
  if (!mutators.includes(memberName)) return null;
  let dest = unwrapAssertions(n.arguments[0]);
  while (ts.isPropertyAccessExpression(dest) || ts.isElementAccessExpression(dest)) {
    dest = unwrapAssertions(dest.expression);
  }
  return dest;
};

const mutatesShadowable = (n) => {
  const mutTarget = mutatingCallTarget(n);
  if (mutTarget && ts.isIdentifier(mutTarget) && SHADOWABLE_NAMES.has(mutTarget.text)) {
    return true;
  }
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
  // An UNREADABLE member is reported, never skipped (Codex round-40 P2). This
  // `continue` recreated per-member exactly the vacuity the surrounding
  // validation exists to prevent: a BOM-prefixed JSON carrying a new
  // `uint256 loanId` event makes `JSON.parse` throw, the file drops out
  // silently, and the run stays green at the usual tally while that event
  // never had to be mapped or exempted. TypeScript imports the same file
  // happily, so nothing else notices either.
  //
  // The same argument as round 23's empty-default and round 26's decoy insert:
  // an empty result from a validator is not a pass.
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(ABI_DIR, file), 'utf8'));
  } catch (e) {
    abiConflicts.push({
      kind: 'unreadable-member',
      event: file,
      message:
        `${file} — could not be read as JSON (${e.message}), so this script cannot ` +
        'tell whether it carries reference-bearing events. An unreadable member is ' +
        'not an empty one: fix the file, or remove it from the barrel.',
    });
    continue;
  }
  const items = Array.isArray(parsed) ? parsed : parsed.abi;
  if (!Array.isArray(items)) {
    abiConflicts.push({
      kind: 'unreadable-member',
      event: file,
      message:
        `${file} — parsed, but neither an ABI array nor an object with an \`abi\` array, ` +
        'so its events are invisible to this check. Fix the shape, or remove it from ' +
        'the barrel.',
    });
    continue;
  }
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
            if (!REF_SHAPE[f].test(`${i.name}`.replace(/s$/, ''))) continue;
            // ...and its ELEMENTS must be ids (Codex round-32 P2). A
            // `bytes32[] loanIds` cannot populate the numeric `loan_id` column
            // any more than a scalar `bytes32 loanId` can, and that one is an
            // unconditional conflict — so routing it to the allowlistable array
            // path let a field exemption make it disappear. The array path is
            // for arrays of IDS; the wrong element type is the same defect as
            // the scalar, reported the same way.
            if (!/^u?int(\d+)?\[\d*\]$/.test(i.type ?? '')) {
              abiConflicts.push({
                kind: 'nonNumericReference',
                event: item.name,
                message: `${item.name}.${path} — named like a ${f} reference array but typed '${i.type}', whose elements cannot be read as ids`,
              });
              continue;
            }
            arrayRefs.set(f, path);
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
    // Compared by NAME AND TYPE (Codex round-32 P2). A name-only comparison
    // called two overloads identical when they reuse the names and change the
    // types — `SyntheticOverload(uint256 loanId)` beside
    // `SyntheticOverload(uint256[] loanId)` — so a scalar `Number(args.loanId)`
    // mapping read as covering both while the second hands the mapper an array.
    // What makes a name-keyed mapper safe is that the bag is the SAME bag, and
    // the names alone do not establish that.
    const signature = names
      .map((n) => `${n}:${typeOf.get(n) ?? '?'}`)
      .sort()
      .join(',');
    const priorSig = eventInputs.get(item.name);
    if (priorSig !== undefined && priorSig !== signature) {
      abiConflicts.push({
        kind: 'overload',
        event: item.name,
        message: `${item.name} — two ABI signatures with different arguments (${priorSig} vs ${signature}); a name-keyed mapper cannot be correct for both`,
      });
    }
    eventInputs.set(item.name, signature);
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
      // An ARRAY is classified before this, not as a broken scalar (Codex
      // round-31 P2). A reference-shaped collection name — `uint256[]
      // loanIdList` — matches the shape rules, so it landed here as
      // "typed 'uint256[]', which Number(args…) cannot read", AND was picked up
      // by the array logic as an array-only reference. The array path is
      // allowlistable; this one is not, so the documented exemption could never
      // make `typecheck` pass. Two reports for one input, one of them a dead end.
      //
      // The array report is the RIGHT one: which element a single `loan_id`
      // should carry is a decision, not a lookup. This conflict is for a scalar
      // that cannot decode, which an array is not.
      // ...and only a NUMERIC-element array is exempt (Codex round-32 P2).
      // Round 31 excluded every type ending in `]`, which swept in `bytes32[]`
      // — elements that cannot populate the numeric `loan_id` column any more
      // than a scalar `bytes32` can, and that one is correctly an unconditional
      // conflict. The array path is the right home for arrays of IDS; an array
      // of the wrong element type is the same defect as the scalar, not a
      // different one.
      const numericArray = (t) => /^u?int(\d+)?\[\d*\]$/.test(t ?? '');
      const nonNumeric = aliases.filter(
        (a) => !numeric.includes(a) && !numericArray(typeOf.get(a)),
      );
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
    //
    // ...and the call must be AWAITED (Codex round-45 P2). `await` was skipped
    // as an optional wrapper, so `recordActivityEvents(…) as unknown as number`
    // satisfied this: the scan keeps a PROMISE, advances its cursor, and returns
    // a count that is really a pending thenable, with the ledger's completion
    // and its failures alike unobserved. The INSERT execution check learned this
    // one round earlier; the same question about the call one level up had not.
    const resultIsBound = (call) => {
      let cur = call;
      let awaited = false;
      for (let p = cur.parent; p; cur = p, p = p.parent) {
        if (ts.isAwaitExpression(p) && p.expression === cur) {
          awaited = true;
          continue;
        }
        if (isTransparentWrapper(p)) continue;
        if (!awaited) return false;
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
    /** A nearer FUNCTION declaration of the ledger name shadows the real one. */
    const shadowsLedgerName = (node) => {
      for (let cur = node; cur; cur = cur.parent) {
        if (ts.isSourceFile(cur)) break;
        let hit = false;
        ts.forEachChild(cur, (c) => {
          if (hit) return;
          if (
            (ts.isFunctionDeclaration(c) || ts.isClassDeclaration(c)) &&
            c.name?.text === LEDGER_FN &&
            c !== ledgerNode
          ) {
            hit = true;
          }
        });
        if (hit) return true;
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
        // ...and the name must RESOLVE to the function this script inspected
        // (Codex round-42 P2). Matching the spelling accepted a caller-local
        // `async function recordActivityEvents() { return 0; }`, which shadows
        // the real writer at the call site and leaves it never invoked — every
        // check below reads a body nothing runs. `nearestDeclIn` returns null
        // when nothing nearer binds the name, which is the module-level
        // declaration being reachable.
        nearestDeclIn(n, LEDGER_FN, sourceFile) === null &&
        !shadowsLedgerName(n) &&
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
    // ...and so must EVERY other argument (Codex round-38 P2). This check has
    // only ever looked at the logs argument, on the reasoning that the logs are
    // what the coverage claim is about. The rest of the call is what the rows
    // are FILED UNDER: `recordActivityEvents(allLogs, env, 999, blockTimestamps)`
    // typechecks, satisfies every check here, and writes every row under chain
    // 999 — where the chain-scoped history queries will never find them. The
    // tally is identical either way, which is this script's whole failure mode.
    //
    // Round 38 required a bare IDENTIFIER, on the reasoning that "the
    // demonstrated hole is a pinned value, which an identifier cannot be".
    // That reasoning was wrong (Codex round-39 P2): `const wrongChainId = 999`
    // is an identifier and a pinned value, one hop apart, and the rows land
    // under chain 999 exactly as before. Syntax was never the property worth
    // checking — being pinned is — so the argument is FOLLOWED to what it
    // holds.
    //
    // Still not resolved to a NAMED binding: saying which local is "the chain
    // id" would hard-code the ledger's parameter order into this script, and
    // it is not needed. A constant is refused however many renames it hides
    // behind; anything this walk cannot follow to a constant is accepted,
    // because a real binding is exactly the thing it cannot prove constant.
    //
    // Scoped to the arguments AFTER the logs: argument 1 already has a check
    // with a better message (an empty literal batch is a distinct mistake with
    // a distinct explanation), and subsuming it into a generic one would lose
    // that.
    /** Is `name` written anywhere in the file, resolving to THIS declaration? */
    const reassignedAfterDeclaration = (name, decl) => {
      let hit = false;
      const walk = (n) => {
        if (hit) return;
        if (writesName(n, name) && nearestDeclIn(n, name, sourceFile) === decl) {
          hit = true;
          return;
        }
        ts.forEachChild(n, walk);
      };
      walk(sourceFile);
      return hit;
    };
    const isPinned = (node, from, depth = 0) => {
      if (depth > 8) return false; // a rename chain this long is not real code
      const e = unwrapAssertions(node);
      if (
        ts.isNumericLiteral(e) ||
        ts.isStringLiteralLike(e) ||
        e.kind === ts.SyntaxKind.TrueKeyword ||
        e.kind === ts.SyntaxKind.FalseKeyword ||
        e.kind === ts.SyntaxKind.NullKeyword ||
        ts.isArrayLiteralExpression(e) ||
        ts.isObjectLiteralExpression(e)
      ) {
        return true;
      }
      if (ts.isPrefixUnaryExpression(e)) return isPinned(e.operand, from, depth + 1);
      if (ts.isIdentifier(e)) {
        const decl = nearestDeclIn(from, e.text, sourceFile);
        if (!decl || decl === OPAQUE_BINDING) return false;
        // A later WRITE decides the value, not the initializer (Codex round-40
        // P2). Following only the declaration made
        // `let forwardedChainId = chainId; forwardedChainId = 999;` read as the
        // honest binding it starts out as, while every row lands under 999.
        //
        // Any write to the binding is refused, not just a pinned one: this walk
        // establishes what a value IS, and a name that is reassigned at all has
        // no single answer for it to find. That is fail-closed in the direction
        // that costs a message rather than a silent hole — and the arguments
        // this applies to are forwarded context, which nothing has reason to
        // reassign between the scan and the call.
        if (reassignedAfterDeclaration(e.text, decl)) return true;
        if (!decl.initializer) return false;
        return isPinned(decl.initializer, decl, depth + 1);
      }
      return false;
    };
    const pinnedArg = callSites.length === 1
      ? callSites[0].arguments.findIndex((a, i) => i > 0 && isPinned(a, callSites[0]))
      : -1;
    // The LOGS argument is followed too (Codex round-43 P2). The check above
    // deliberately starts at argument 1 so the batch keeps its own message —
    // but "keeps its own message" was implemented as "is tested for being a
    // literal", and `const noLogs: DecodedLog[] = []` is an identifier holding
    // exactly the empty batch that test exists to refuse. One binding was the
    // whole distance between the hole and the check.
    //
    // `isPinned` is NOT the test to reuse here, and the reason is the point.
    // The live batch is `const allLogs: DecodedLog[] = []` — an array literal,
    // which `isPinned` calls pinned, and correctly so for the forwarded context
    // it was written for. A batch is different in kind: it is DECLARED empty
    // and FILLED, so its initializer says nothing about what it holds at the
    // call. What separates it from the decoy is not its initializer but
    // whether anything ever puts logs in it.
    // Only mutators that can ADD an element count (Codex round-44 P2). Round 43
    // took "mutates the array" as the property, and three of the names it
    // listed cannot lengthen an empty one: `fill` and `copyWithin` write over
    // existing slots and leave the length alone, so `noLogs.copyWithin(0, 0)`
    // read as a filled batch while the ledger received nothing. `splice`
    // belongs only in its insertion form — `splice(i, n)` removes, and
    // `splice()` does nothing at all.
    // ONE reachability test for both batch scans (Codex round-48 P2). Round 47
    // added alias-following to `everFilledShallow` and left it accepting an
    // insertion by position alone, so `if (false) stillNoLogs.push(...)` in the
    // aliased binding read as filling. `everFilled` has asked this since round
    // 46; the twin written to follow aliases into it had not. Same defect shape
    // as the resolvers in rounds 27-29 and 33: the rule was right in one place
    // and kept arriving late in its sibling.
    const reachableHere = (n) => {
      let fn = n.parent;
      while (fn && !isFunctionLike(fn)) fn = fn.parent;
      return guardedReason(n, fn?.body ?? sourceFile) === null;
    };
    const BATCH_ADDERS = ['push', 'unshift'];
    /**
     * Does this call add the WHOLE decoded collection, rather than some of it?
     *
     * "Any insertion" was too weak (Codex round-49 P2): `someLogs.push(allLogs[0])`
     * is an insertion, passes every other check, and makes a multi-log scan
     * record one activity row and then advance the cursor past the rest. That is
     * a plausible real bug, not only a decoy — an off-by-one in the fill loop
     * has exactly this shape.
     *
     * Two accepted forms, matching how a complete batch is actually built:
     * a SPREAD of another collection, or a per-item push INSIDE A LOOP — which
     * is what the live decode loop does, one decoded log at a time.
     */
    const addsWholeCollection = (call) => {
      if ((call.arguments ?? []).some((a) => ts.isSpreadElement(a))) return true;
      for (let cur = call; cur && cur !== sourceFile; cur = cur.parent) {
        const p = cur.parent;
        if (!p) break;
        if (isFunctionLike(p)) break; // a loop outside the helper is not its loop
        if (
          ts.isForOfStatement(p) || ts.isForInStatement(p) ||
          ts.isForStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)
        ) {
          return true;
        }
      }
      return false;
    };
    const insertsInto = (call, name) => {
      const member = memberNameOf(call.expression);
      if (BATCH_ADDERS.includes(member)) {
        return call.arguments.length > 0 && addsWholeCollection(call);
      }
      // splice(start, deleteCount, ...items) — an insertion needs the items.
      if (member === 'splice') return call.arguments.length > 2 && addsWholeCollection(call);
      return false;
    };
    /**
     * Does anything add to — or reassign — the binding `name` declared at `decl`,
     * BEFORE `beforePos` and on a path that actually runs?
     *
     * Ordering and reachability are both required (Codex round-45 P2). Round 44
     * walked the whole file and asked only "does an insertion exist anywhere",
     * so `noLogs.push(...allLogs)` placed AFTER the awaited ledger call counted
     * as filling the batch the ledger had already been handed empty. A write
     * that happens later, or inside a branch that may not run, is not evidence
     * about what the call received.
     */
    /**
     * Insertion-only twin of {everFilled}, for following an aliased assignment.
     *
     * Deliberately does NOT consider reassignments, which is what keeps it from
     * recursing back into the caller: the question it answers is the narrow one
     * — "does anything ever put an element into this binding" — which is enough
     * to tell a live accumulator from a decoy that is only ever declared empty.
     */
    const everFilledShallow = (name, decl, beforePos) => {
      let hit = false;
      const walk = (n) => {
        if (hit) return;
        if (n.getStart(sourceFile) >= beforePos) return;
        if (ts.isCallExpression(n) && insertsInto(n, name)) {
          const recv = unwrapAssertions(n.expression.expression);
          if (
            ts.isIdentifier(recv) &&
            recv.text === name &&
            nearestDeclIn(n, name, sourceFile) === decl &&
            reachableHere(n)
          ) {
            hit = true;
            return;
          }
        }
        ts.forEachChild(n, walk);
      };
      walk(sourceFile);
      return hit;
    };
    const everFilled = (name, decl, beforePos) => {
      let hit = false;
      // ...and the addition must be REACHABLE (Codex round-46 P2). Round 45
      // added ordering and stopped there, so `if (false) noLogs.push(…allLogs)`
      // placed above the call counted: earlier in the file, never executed. The
      // same walk that decides whether the INSERT runs answers this, stopped at
      // the enclosing function rather than at the ledger.
      const reachable = reachableHere;
      const walk = (n) => {
        if (hit) return;
        if (n.getStart(sourceFile) >= beforePos) return;
        const receiver =
          ts.isCallExpression(n) && insertsInto(n, name)
            ? unwrapAssertions(n.expression.expression)
            : null;
        if (
          receiver &&
          ts.isIdentifier(receiver) &&
          receiver.text === name &&
          nearestDeclIn(n, name, sourceFile) === decl &&
          reachable(n)
        ) {
          hit = true;
          return;
        }
        // A REASSIGNMENT counts only if what it assigns is not itself empty
        // (Codex round-46 P2). Treating every write as evidence accepted
        // `noLogs = []`, which is the very state the check exists to refuse —
        // the write was taken as proof of filling while it did the opposite.
        if (writesName(n, name) && nearestDeclIn(n, name, sourceFile) === decl && reachable(n)) {
          const assigned =
            ts.isBinaryExpression(n) &&
            n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(unwrapAssertions(n.left)) &&
            unwrapAssertions(n.left).text === name
              ? unwrapAssertions(n.right)
              : null;
          // ...and the assigned VALUE is followed, not just its syntax (Codex
          // round-47 P2). Round 46 tested the immediate right-hand side only,
          // so `noLogs = stillNoLogs` — another binding declared `[]` and never
          // filled — read as evidence of filling. Being empty survives a
          // rename, exactly as being pinned did for the context arguments two
          // rounds earlier; this is the same lesson in the adjacent check.
          const assignsEmpty = (() => {
            const seenNames = new Set();
            const isEmptyValue = (node, from, depth = 0) => {
              if (!node || depth > 8) return false;
              const e = unwrapAssertions(node);
              if (ts.isArrayLiteralExpression(e)) return e.elements.length === 0;
              if (ts.isIdentifier(e)) {
                if (seenNames.has(e.text)) return false; // cyclic alias chain
                seenNames.add(e.text);
                const d = nearestDeclIn(from, e.text, sourceFile);
                if (!d || d === OPAQUE_BINDING) return false;
                // A binding something else fills is not an empty value.
                if (everFilledShallow(e.text, d, from.getStart(sourceFile))) return false;
                return isEmptyValue(d.initializer, d, depth + 1);
              }
              return false;
            };
            return assigned ? isEmptyValue(assigned, n) : false;
          })();
          if (!assignsEmpty) {
            hit = true;
            return;
          }
        }
        ts.forEachChild(n, walk);
      };
      walk(sourceFile);
      return hit;
    };
    const pinnedBatch = (() => {
      if (callSites.length !== 1 || !callSites[0].arguments[0]) return false;
      const arg = unwrapAssertions(callSites[0].arguments[0]);
      if (!ts.isIdentifier(arg)) return false; // the literal case has its own check
      const decl = nearestDeclIn(callSites[0], arg.text, sourceFile);
      // Nothing nearer binds it, or the binder is one this script cannot read:
      // a real binding is exactly what it cannot prove empty, so accept.
      if (!decl || decl === OPAQUE_BINDING || !decl.initializer) return false;
      const declInit = unwrapAssertions(decl.initializer);
      if (!ts.isArrayLiteralExpression(declInit)) return false;
      return !everFilled(arg.text, decl, callSites[0].getStart(sourceFile));
    })();
    if (pinnedArg >= 0) {
      console.error(
        `[check-activity-refs-coverage] ${LEDGER_FN}() is called with a pinned value in\n` +
          `  argument ${pinnedArg + 1} (\`${callSites[0].arguments[pinnedArg].getText(sourceFile)}\`).\n` +
          '  Only the LOGS argument used to be checked, but the other arguments decide what\n' +
          '  every row is filed under — a fixed chain id stores the whole batch under a\n' +
          '  chain nobody queries, while every count in this script stays identical. A local\n' +
          '  holding a constant is the same thing one rename along, so the value is followed\n' +
          '  rather than its spelling checked. Pass the scan\'s own bindings, or update this\n' +
          '  script — do not delete the check.',
      );
      process.exit(1);
    }
    // Binding the result does not prove the scan MAKES the call (Codex round-37
    // P2). `resultIsBound` was added so a fire-and-forget decoy could not stand
    // in for the live invocation, and it checks the shape of the call site, not
    // its position — so `let activityEvents = 0; if (false) { const dead = await
    // recordActivityEvents(allLogs, …); }` satisfies it while the scan records
    // nothing. Same question the INSERT's reachability check asks one level
    // down, so it is the same walk, stopped at the call's own function.
    const unreachableCall = callSites.length === 1
      ? (() => {
          let fn = callSites[0].parent;
          while (fn && !isFunctionLike(fn)) fn = fn.parent;
          return guardedReason(callSites[0], fn?.body ?? sourceFile);
        })()
      : null;
    if (unreachableCall) {
      console.error(
        `[check-activity-refs-coverage] the only call to ${LEDGER_FN}() sits\n` +
          `  ${unreachableCall}.\n` +
          '  Every check below reads that function\'s body, which is evidence about the rows\n' +
          '  only if the scan actually runs it — and a call that never executes leaves every\n' +
          '  count in this script identical while no activity row is written. Put the call on\n' +
          '  the scan\'s own path, or update this script — do not delete the check.',
      );
      process.exit(1);
    }
    if (callSites.length > 1) {
      console.error(
        `[check-activity-refs-coverage] ${LEDGER_FN}() result is bound in ${callSites.length}\n` +
          '  places. This script cannot tell which one the scan actually runs, and a second\n' +
          '  one is how a decoy hides a disconnected live call. Keep one, or update this\n' +
          '  script — do not delete the check.',
      );
      process.exit(1);
    }
    // The kept result must actually be USED (Codex round-46 P2, narrowed —
    // see the PR thread). Binding it satisfied every check while
    // `const ignoredActivityEvents = await recordActivityEvents(…)` sat beside
    // `const activityEvents = 0`: the rows are written, but the count the scan
    // reports is a constant zero, and the Durable Object only emits
    // `activity.appended` on a positive count — so clients keep stale activity.
    //
    // Deliberately NOT "resolve the binding through to the scan result's
    // `activityEvents` property", which is what was suggested. That would
    // encode the scan's return shape into this script, the same boundary #1811
    // exists to question for the context arguments, and it makes every
    // legitimate rename of that field a checker change. "Declared and never
    // read" is name-agnostic, closes the demonstrated hole, and is true of no
    // reasonable live code.
    const unusedResult = (() => {
      if (callSites.length !== 1) return null;
      let cur = callSites[0];
      let bound = null;
      for (let p = cur.parent; p; cur = p, p = p.parent) {
        if (ts.isAwaitExpression(p) || isTransparentWrapper(p)) continue;
        if (ts.isVariableDeclaration(p) && p.initializer === cur && ts.isIdentifier(p.name)) {
          bound = p.name;
        } else if (
          ts.isBinaryExpression(p) &&
          p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          p.right === cur &&
          ts.isIdentifier(unwrapAssertions(p.left))
        ) {
          // An assignment target gets the SAME read check (Codex round-47 P2).
          // Round 46 waved it through on the reasoning that assigning to an
          // existing binding implies that binding is read elsewhere. It does
          // not: `let ignoredActivityEvents: number;` declared and then only
          // assigned is dangling in exactly the way the initializer form is,
          // and it slipped past the check written for it one round earlier.
          bound = unwrapAssertions(p.left);
        }
        break;
      }
      if (!bound) return null;
      // A READ, not merely an occurrence. The binding's own declaration name and
      // any assignment TARGET are writes — counting them made every assignment
      // form self-justifying, which is how the round-46 check would have been
      // satisfied by the very shape round 47 demonstrated.
      let reads = 0;
      const isWriteOccurrence = (n) => {
        const p = n.parent;
        if (!p) return false;
        if (ts.isVariableDeclaration(p) && p.name === n) return true;
        if (ts.isParameter(p) && p.name === n) return true;
        if (
          ts.isBinaryExpression(p) &&
          p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          unwrapAssertions(p.left) === n
        ) {
          return true;
        }
        return false;
      };
      // ...and only reads that can happen AFTER the result lands (Codex
      // round-48 P2). Counting the whole file let a read of the binding's
      // PREVIOUS value stand in for a read of the ledger's: initialise it to
      // zero, read that, then assign the awaited result and never touch it
      // again, and the check was satisfied by a read of a value the ledger had
      // nothing to do with. The question is whether the RESULT is consumed, so
      // the window starts where the result arrives.
      const resultAt = bound.getStart(sourceFile);
      const countReads = (n) => {
        if (
          ts.isIdentifier(n) &&
          n.text === bound.text &&
          n !== bound &&
          !isWriteOccurrence(n) &&
          n.getStart(sourceFile) > resultAt
        ) {
          reads += 1;
        }
        ts.forEachChild(n, countReads);
      };
      countReads(sourceFile);
      return reads === 0 ? bound.text : null;
    })();
    if (unusedResult) {
      console.error(
        `[check-activity-refs-coverage] ${LEDGER_FN}()'s result is bound to\n` +
          `  \`${unusedResult}\` and never read again.\n` +
          '  The rows may well be written, but the COUNT the scan reports is what decides\n' +
          '  whether an `activity.appended` notification goes out — a dangling binding beside\n' +
          '  a hard-coded zero leaves every client holding stale activity while every count in\n' +
          '  this script stays identical. Use the result, or update this script — do not\n' +
          '  delete the check.',
      );
      process.exit(1);
    }
    if (callSites.length === 0 || disconnected.length || pinnedBatch) {
      console.error(
        `[check-activity-refs-coverage] ${LEDGER_FN}() is ${
          callSites.length === 0
            ? 'never called in a way that keeps its result'
            : disconnected.length
              ? 'called with a literal first argument'
              : 'called with a first argument that resolves to a fixed batch'
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
    // A NESTED function's destructuring is not this binding (Codex round-51
    // P2). The walk descended into every local helper and callback, so an
    // ordinary `const { loanId } = value` inside one counted as a second source
    // for the SQL references and failed the build with "destructures … in 2
    // places". It cannot be the binding `.bind()` reads — that one is in the
    // ledger's own scope — and blocking an internal refactor is the expensive
    // direction to be wrong in. Same function-boundary rule the per-case and
    // outer shadow scans have carried since rounds 11 and 40.
    if (n !== ledgerNode.body && isFunctionLike(n)) return;
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
    // Resolved to the mapper's destructuring, not text-matched (Codex round-33
    // P2). This scan compared spelling, so an unrelated nested
    // `{ let loanId = 1; loanId = 2; }` anywhere in the ledger failed the real
    // binding and blocked `typecheck` on code that never touched it. Fourth site
    // in this file where "same name" stood in for "same binding" — rounds 27, 28
    // and 29 fixed the other three and this one was not looked at.
    //
    // `declaresName` walks destructuring patterns, so the mapper's own
    // `const { loanId } = pluckActivityRefs(…)` resolves to the declaration this
    // check is protecting; anything nearer shadows it and is somebody else's.
    const writtenAnywhere = (root, name) => {
      let found = false;
      const walk = (n) => {
        if (found) return;
        // Only a write that resolves to the MAPPER's destructuring counts. A
        // write resolving anywhere else — a nested `let loanId`, a catch
        // parameter, a loop variable — is about a different value and does not
        // touch what goes into SQL. `nearestDeclIn` returns OPAQUE_BINDING for
        // the binders it cannot follow, which are equally not this one.
        if (writesName(n, name) && nearestDeclIn(n, name, root) === bindings[0]) {
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
  // ...and that name must RESOLVE to the mapper this script inspected (Codex
  // round-43 P2). Recording the callee's SPELLING validated the module-level
  // `pluckActivityRefs` while the ledger invoked a same-named local — one
  // returning `{ actor: null, loanId: 999, offerId: null }` — so every check
  // below read a body nothing runs and the rows filed under loan 999. The
  // ledger's own call site has resolved its callee since round 42; this one,
  // asking the same question about the function it hands the work to, had not.
  //
  // `nearestDeclIn` returning null is the module-level declaration being the
  // nearest binder, which is the honest case.
  const mapperShadowed =
    boundFrom === 'pluckActivityRefs' && nearestDeclIn(init, boundFrom, sourceFile) !== null;
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
    // {nearestDeclIn}, with the one thing that resolver cannot know: the
    // enclosing loop's OWN binding is not a shadow here — it is the log this
    // whole scan is about — so it resolves to null rather than OPAQUE_BINDING.
    // The shared walk, plus the ONE thing it cannot know: the enclosing loop's
    // own binding is not a shadow here — it is the log this whole scan is about
    // — so it resolves to null rather than to the sentinel.
    const nearestDecl = (from, name) =>
      resolveNameInScopes(from, name, {
        stopAt: loopVar.body,
        shadowSentinel: OPAQUE_BINDING,
        notAShadow: (scope, n) => scope === loopVar.node && n === loopVar.name,
      });
    /**
     * Every write to `name` that targets THIS binding, nested closures included.
     *
     * Resolved, not text-matched (Codex round-29 P2). Round 28 fixed exactly
     * this in `mutatedInPlace` and left the reassignment scan comparing
     * spelling, so an unrelated nested `{ let args = …; args = … }` invalidated
     * the real outer binding — a false positive that blocks `typecheck`. Third
     * site in this file where "same name" was standing in for "same binding".
     */
    const writesTo = (name, declOfInterest, beforePos = Infinity) => {
      const found = [];
      const walk = (n) => {
        if (n.getStart(sourceFile) >= beforePos) return;
        if (writesName(n, name) && nearestDecl(n, name) === declOfInterest) found.push(n);
        ts.forEachChild(n, walk);
      };
      walk(loopVar.body);
      return found;
    };
    /** {writesTo} over an arbitrary subtree, with no positional cutoff. */
    const writesIn = (root, name, declOfInterest) => {
      const found = [];
      const walk = (n) => {
        if (writesName(n, name) && nearestDecl(n, name) === declOfInterest) found.push(n);
        ts.forEachChild(n, walk);
      };
      if (root) walk(root);
      return found;
    };
    /**
     * Bodies of functions INVOKED before `beforePos` in the loop body.
     *
     * A hoisted declaration can sit textually after the call that runs it, so a
     * positional cutoff alone prunes code that executes first (Codex round-48
     * P2). Resolving the callee is what makes the cutoff mean "before in
     * EXECUTION" rather than "before in the file".
     */
    const bodiesInvokedBefore = (beforePos) => {
      /** The nearest hoisted `function name(...)` visible from `at`. */
      const hoistedFn = (at, wanted) => {
        for (let scope = at; scope; scope = scope.parent) {
          const stmts =
            ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isCaseClause(scope) ||
            ts.isDefaultClause(scope)
              ? scope.statements
              : null;
          if (stmts) {
            for (const st of stmts) {
              if (ts.isFunctionDeclaration(st) && st.name?.text === wanted && st.body) return st;
            }
          }
        }
        return null;
      };
      const bodies = [];
      const seenDecls = new Set();
      const walk = (n) => {
        if (n.getStart(sourceFile) < beforePos && ts.isCallExpression(n)) {
          const callee = unwrapAssertions(n.expression);
          if (ts.isIdentifier(callee)) {
            const fn = hoistedFn(n, callee.text);
            if (fn && !seenDecls.has(fn)) {
              seenDecls.add(fn);
              bodies.push(fn.body);
            }
          }
        }
        ts.forEachChild(n, walk);
      };
      walk(loopVar.body);
      return bodies;
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
          if (ts.isIdentifier(src) && src.text === name) {
            selfSpreadAt = idx;
            continue;
          }
          // An INLINE object literal has completely known keys, so it overrides
          // only what it actually defines (Codex round-33 P2). This check called
          // every non-self spread an opaque overwrite, so writing the live
          // enrichment as `args = { ...args, ...{ creator } }` — same meaning,
          // one refactor away — was rejected and blocked `typecheck`.
          // `objectLiteralView` already answers this question for return values,
          // including the getter case that really is unreadable; asking it here
          // too is the same fix rounds 26 and 29 made for the other readers.
          if (ts.isObjectLiteralExpression(src)) {
            // A GETTER-bearing literal is dangerous WHEREVER it sits (Codex
            // round-34 P2), and it is a SIDE-EFFECT question, not a key
            // question. Spreading reads every own enumerable property, so a
            // getter runs at that point and its body can reach the decoded
            // arguments — through a helper, where no write scan in this file
            // can see it. One placed BEFORE `...args` therefore corrupts the
            // very bag the self-spread then copies, and the reference fields
            // pass the ordering check holding another log's values.
            //
            // Asked of the literal directly rather than through
            // `objectLiteralView`: that reader answers "which keys survive",
            // and a getter it sees at TOP level is merely a key it cannot read,
            // so it reports shadowing rather than opacity. Only its own spread
            // branch treats a getter as a side effect — which is this same
            // question, one level down.
            const runsAGetter = (lit) =>
              lit.properties.some(
                (q) =>
                  ts.isGetAccessorDeclaration(q) ||
                  (ts.isSpreadAssignment(q) &&
                    ts.isObjectLiteralExpression(unwrapAssertions(q.expression)) &&
                    runsAGetter(unwrapAssertions(q.expression))),
              );
            if (runsAGetter(src)) {
              overriddenAfter = true;
              continue;
            }
            const inner = objectLiteralView(src);
            if (inner.opaque) {
              overriddenAfter = true;
              continue;
            }
            if (selfSpreadAt >= 0) {
              if (inner.spread) overriddenAfter = true;
              else if ([...inner.props.keys()].some((k) => couldBeReference(k))) {
                overriddenAfter = true;
              }
            }
            continue;
          }
          if (selfSpreadAt >= 0) overriddenAfter = true; // another bag wins
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
        //
        // A COMPUTED key wrapping a static string is resolvable and must be
        // read (Codex round-34 P2). `objectLiteralView` has handled `['loanId']`
        // since round 12; this reader did not, so writing the live enrichment as
        // `args = { ...args, ['creator']: creator }` — valid TypeScript,
        // reference-preserving — was treated as a key this parser cannot read
        // and rejected inside `typecheck`. Same syntax, same answer, in both
        // readers.
        const nameOf = (nm) => {
          if (ts.isIdentifier(nm) || ts.isStringLiteralLike(nm)) return nm.text;
          if (ts.isComputedPropertyName(nm) && ts.isStringLiteralLike(nm.expression)) {
            return nm.expression.text;
          }
          return null;
        };
        const key = ts.isPropertyAssignment(p)
          ? nameOf(p.name)
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
    const mutatedInPlace = (name, declOfInterest, beforePos = Infinity, root = null) => {
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
        if (n.getStart(sourceFile) >= beforePos) return;
        // A mutating CALL is a mutation too (Codex round-34 P2). This scan knew
        // only the syntactic forms — assignment, ++/--, `delete` — so
        // `Object.assign(args, { loanId: logs[0]!.args.loanId })` overwrote the
        // decoded bag in a shape it had no case for, and every later row could
        // carry the first log's id.
        //
        // Recognised by callee, not by "any call receiving the alias": the
        // ledger legitimately passes the bag to `serializeArgs` and to
        // `pluckActivityRefs` itself, so a blanket rule would reject the live
        // code. The list is the built-ins that write through their first
        // argument.
        if (ts.isCallExpression(n) && n.arguments.length > 0) {
          const callee = unwrapAssertions(n.expression);
          // `Object['assign']` is the same call as `Object.assign` (Codex
          // round-35 P2). Round 34 matched only the dotted form, so the bracket
          // form — identical semantics, statically resolvable — walked past.
          // Member reads are resolved the same way everywhere else in this file
          // (`objectLiteralView` since round 12, the enrichment key reader since
          // round 34); this was the last member read still assuming dot syntax.
          const memberName = memberNameOf(callee);
          if (memberName !== null) {
            const host = unwrapAssertions(callee.expression);
            const mutators = ts.isIdentifier(host) && host.text === 'Object'
              ? ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf']
              : ts.isIdentifier(host) && host.text === 'Reflect'
                ? ['set', 'defineProperty', 'deleteProperty', 'setPrototypeOf']
                : [];
            if (mutators.includes(memberName)) {
              const dest = rootOf(n.arguments[0]);
              if (
                ts.isIdentifier(dest) &&
                dest.text === name &&
                nearestDecl(n, name) === declOfInterest
              ) {
                found = true;
                return;
              }
            }
          }
        }
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
      walk(root ?? loopVar.body);
      return found;
    };
    /**
     * Every loop-local name that points at the SAME object the mapper is handed
     * (Codex round-33 P2).
     *
     * `mutatedInPlace` asked its question of ONE name — whichever identifier the
     * call itself uses. `const decoded = args; decoded.loanId = logs[0]!.args.loanId`
     * mutates the very object the mapper then reads, under a second name, so the
     * scan looked at `args`, found nothing, and every row carried the first log's
     * id. Round 27 closed this for an alias chain that FEEDS the call; an alias
     * that only mutates is the mirror image and was still open.
     *
     * It also covers the `log.args` call shape, where `resolvesTo` — and with it
     * the whole mutation question — was never reached at all.
     *
     * Aliases are followed to a fixed point and resolved by declaration, so an
     * unrelated namesake in a nested block is not mistaken for one.
     *
     * @returns Map of name -> the declaration binding it.
     */
    const aliasesOfArg = (argExpr) => {
      const isArgObject = (e) => {
        const cur = unwrapAssertions(e);
        if (!ts.isPropertyAccessExpression(cur)) return false;
        const recv = unwrapAssertions(cur.expression);
        return (
          cur.name.text === ARGS_PROP &&
          ts.isIdentifier(recv) &&
          recv.text === loopVar.name &&
          nearestDecl(cur, recv.text) === null
        );
      };
      // Keyed by DECLARATION, not by spelling (Codex round-34 P2). A name-keyed
      // map records the first declaration and skips every later one, so two
      // sibling scopes reusing an alias name — `{ const decoded = args; }` then
      // `{ const decoded = args; decoded.loanId = …; }` — left the mutating one
      // unexamined. Names are not identities anywhere else in this file either;
      // this map was the last place still assuming they were.
      const known = new Map(); // declaration node (or the seed key) -> name
      const SEED = Symbol('the argument expression itself');
      const seed = unwrapAssertions(argExpr);
      if (ts.isIdentifier(seed)) known.set(nearestDecl(init, seed.text) ?? SEED, seed.text);
      // Resolves through the map's VALUES, so an alias of an alias is followed
      // whichever declaration each hop resolves to.
      const aliasesKnown = (idNode, at) => {
        const decl = nearestDecl(at, idNode.text) ?? SEED;
        return known.has(decl) && known.get(decl) === idNode.text;
      };
      let grew = true;
      while (grew) {
        grew = false;
        const visit = (n) => {
          if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && !known.has(n)) {
            const rhs = unwrapAssertions(n.initializer);
            if (isArgObject(rhs) || (ts.isIdentifier(rhs) && aliasesKnown(rhs, n))) {
              known.set(n, n.name.text);
              grew = true;
            }
          }
          ts.forEachChild(n, visit);
        };
        visit(loopVar.body);
      }
      // Back to (name, declaration) pairs for the mutation scan, which resolves
      // each candidate write against the declaration it is given.
      return [...known].map(([decl, nm]) => [nm, decl === SEED ? null : decl]);
    };
    /** Which loop-item property `name` resolves to here, or null. */
    const resolvesTo = (from, name, depth = 0) => {
      if (depth > 8) return null; // a rename chain this long is not real code
      // A write that does not demonstrably preserve the binding breaks the
      // chain: the declaration no longer proves what the value is. So does a
      // mutation of the object it points at, which leaves the binding intact
      // and the VALUE wrong.
      // Bounded at `from` (Codex round-47 P2). This function answers "what does
      // this name resolve to HERE", so only writes that can run before `here`
      // bear on the answer — and scanning the whole loop body meant ordinary
      // cleanup after the awaited INSERT, which cannot change a value the mapper
      // already copied out, broke the resolution and failed the build. The
      // question was always positional; the scan was not.
      //
      // ...but source position is not execution order for a HOISTED FUNCTION
      // (Codex round-48 P2). `mutateArgs()` called just before the mapper, with
      // `function mutateArgs() { args.loanId = 999n }` declared after the
      // INSERT, runs first and is pruned by a positional cutoff. Round 47's
      // bound traded a false positive for this false negative, so the cutoff now
      // carries the bodies of functions actually invoked before it.
      const at = from.getStart(sourceFile);
      const decl = nearestDecl(from, name);
      const hoistedBodies = bodiesInvokedBefore(at);
      const writes = writesTo(name, decl, at);
      for (const body of hoistedBodies) writes.push(...writesIn(body, name, decl));
      if (writes.some((w) => !preservesSelf(w, name))) return null;
      if (mutatedInPlace(name, decl, at)) return null;
      if (hoistedBodies.some((b) => mutatedInPlace(name, decl, Infinity, b))) return null;
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
    // ...and nothing in the loop may mutate the object behind that argument,
    // under ANY of its names (Codex round-33 P2).
    // Bounded to writes that can run BEFORE the mapper call (Codex round-47 P2).
    // This check's own message says "before handing them to pluckActivityRefs",
    // and the scan did not enforce it — so ordinary cleanup after the awaited
    // INSERT, which cannot affect values the mapper already copied out, failed
    // the build. The intent was right and the implementation was unbounded.
    const mutatedAlias = [...aliasesOfArg(init.arguments[1])].find(([n, d]) =>
      mutatedInPlace(n, d, init.getStart(sourceFile)),
    );
    if (mutatedAlias) {
      console.error(
        `[check-activity-refs-coverage] ${LEDGER_FN}() mutates the decoded arguments in\n` +
          `  place through \`${mutatedAlias[0]}\` before handing them to pluckActivityRefs.\n` +
          '  The mapper reads whatever the object holds at call time, so a write like\n' +
          `  \`${mutatedAlias[0]}.loanId = logs[0].args.loanId\` files every row under the first log's\n` +
          '  id while every count here stays identical — and renaming the binding is\n' +
          '  enough to slip past a check that watches only the name in the call. Leave\n' +
          '  the decoded arguments alone, or update this script — do not delete the\n' +
          '  check.',
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
    // The shared walk with this resolver's own sentinel (Codex round-45 P2).
    // This was the THIRD hand-written copy, and it still lacked the hoisting
    // rule the other two had each been taught in the two previous rounds — so a
    // nested `class loanId {}` beside the INSERT resolved as the value
    // destructured from the mapper. Delegating is what retires that family.
    const bindingOfIdentifier = (from, name) =>
      resolveNameInScopes(from, name, {
        stopAt: ledgerNode.body,
        shadowSentinel: SHADOWED,
      });
    /**
     * Why this INSERT might not run on the ledger's own path (Codex round-36
     * P2), or null when nothing between it and the ledger body can skip it.
     *
     * The walk that finds the INSERT is an unrestricted descendant scan, so it
     * happily accepted one that cannot execute: `const result = false
     * ? await env.DB.prepare(…).bind(…).run() : { meta: { changes: 0 } }`
     * typechecks, matches every positional check here, and writes no rows at
     * all. "There is exactly one INSERT and its binds line up" says nothing if
     * the INSERT is dead — round 26 already learned this for a SECOND, decoy
     * insert and the single-insert case was left open.
     *
     * Blocks and loops are fine (the ledger's own `for (const log of logs)` is
     * one). What is refused is anything that can decide NOT to reach it:
     * a nested function, a conditional expression, a short-circuit operand, or
     * an `if` branch.
     */
    const unreachableReason = (node) => guardedReason(node, ledgerNode.body);
    const inserts = [];
    /**
     * The SQL `prepare` was handed, but only when it is a STATIC expression
     * (Codex round-43 P2).
     *
     * `getText()` returns the SOURCE of whatever was passed, so a conditional
     * `cond ? <correct column order> : <loan_id/offer_id swapped>` carries BOTH
     * arms — and every column-order regex below matches whichever arm appears
     * first in the file, never the one the runtime selects. The regexes read a
     * string; a dynamic expression is not one, and refusing it is the honest
     * outcome rather than validating an arm at random.
     *
     * @returns the SQL text, `null` for a dynamic expression, `undefined` when
     *          no `prepare(...)` call was found at all.
     */
    /**
     * Is this `prepare(...)` call made on a D1 binding?
     *
     * The SQL and executor checks accepted ANY object exposing `prepare` /
     * `bind` / `run` (Codex round-49 P2), so a local stub whose `run()` resolves
     * `{ meta: { changes: 1 } }` satisfied every one of them while writing
     * nothing and letting the scan advance its cursor. Requiring the receiver to
     * be a `.DB` property — the Workers D1 binding convention this ledger uses —
     * is cheap and ties the checks to the real database.
     */
    //
    // ...and the object carrying `.DB` must be one the ledger was HANDED
    // (Codex round-50 P2). Checking only that the receiver ends in `.DB` left
    // `fake.DB.prepare(...)` passing — a local wrapper whose `run()` can report
    // changes without persisting. The host is resolved to a parameter of the
    // ledger, which is where a real binding can only come from. Which
    // parameter is not named, so reordering or renaming the signature is not a
    // false failure; what is refused is a locally constructed stand-in.
    const ledgerParamNames = new Set(
      (ledgerNode.parameters ?? [])
        .map((prm) => prm.name)
        .filter((nm) => nm && ts.isIdentifier(nm))
        .map((nm) => nm.text),
    );
    const preparedOnD1 = (call) => {
      const recv = unwrapAssertions(call.expression);
      if (!ts.isPropertyAccessExpression(recv) && !ts.isElementAccessExpression(recv)) return false;
      const host = unwrapAssertions(recv.expression);
      if (memberNameOf(host) !== 'DB') return false;
      const carrier = unwrapAssertions(host.expression);
      return ts.isIdentifier(carrier) && ledgerParamNames.has(carrier.text);
    };
    let nonD1Prepare = null;
    const staticSqlOf = (receiver) => {
      let found;
      const seek = (n) => {
        if (found !== undefined) return;
        if (ts.isCallExpression(n) && memberNameOf(n.expression) === 'prepare') {
          if (!preparedOnD1(n)) nonD1Prepare = n.getText(sourceFile).slice(0, 80);
          const only = n.arguments.length === 1 ? unwrapAssertions(n.arguments[0]) : null;
          // `isStringLiteralLike` is exactly the right line: it covers a string
          // literal and a no-substitution template, and excludes a template
          // WITH substitutions — whose interpolations this script cannot read.
          found = only && ts.isStringLiteralLike(only) ? only.text : null;
          return;
        }
        ts.forEachChild(n, seek);
      };
      seek(receiver);
      return found;
    };
    /**
     * SQL with its COMMENTS removed (Codex round-46 P2).
     *
     * Every check here reads the statement as text, and SQLite ignores
     * `-- line` and `/* block *\/` spans — so a block-commented copy of the
     * expected INSERT followed by a ten-placeholder `SELECT` satisfied the
     * column-order regexes and the bind-count check while inserting no row.
     * Requiring a static expression (round 44) closed the "which arm runs"
     * question and left the "is this text even executed" one open.
     */
    const stripSqlComments = (text) =>
      text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
    let dynamicSql = null;
    const findInsert = (n) => {
      if (ts.isCallExpression(n) && memberNameOf(n.expression) === 'bind') {
        const receiver = n.expression.expression;
        const raw = receiver.getText(sourceFile);
        if (/INSERT\s+(OR\s+\w+\s+)?INTO\s+activity_events/i.test(stripSqlComments(raw))) {
          const sql = staticSqlOf(receiver);
          if (typeof sql !== 'string') dynamicSql = raw;
          inserts.push({
            sql: stripSqlComments(typeof sql === 'string' ? sql : raw),
            args: n.arguments,
            node: n,
          });
        }
      }
      ts.forEachChild(n, findInsert);
    };
    if (ledgerNode.body) findInsert(ledgerNode.body);
    // `.bind(...)` PREPARES; it does not execute (Codex round-42 P2). D1's
    // `bind` returns another prepared statement, so a bound statement that is
    // never `.run()` writes no row — and every check here, which reads the SQL
    // and the bind list off that statement, was satisfied by it. Requiring the
    // matched bind to flow into an awaited execution is the difference between
    // "this statement is correct" and "this statement happens".
    const EXECUTORS = ['run', 'all', 'first', 'raw'];
    // The executor must be INVOKED, not merely reached (Codex round-43 P2).
    // Requiring only that the member sit under some call accepted
    // `console.log(env.DB.prepare(…).bind(…).run)` — the property is read, the
    // enclosing call is `console.log`, and no row is written. The member has to
    // BE the callee, which is `p.parent.expression === p`.
    //
    // ...and the member is read the same way everywhere else in this script
    // (Codex round-43 P2). A `PropertyAccessExpression`-only test rejected the
    // equivalent `statement['run']()`, blocking the indexer typecheck on code
    // that executes exactly as the dotted form does. `memberNameOf` already
    // reads both, and returns null for anything that is not a member access —
    // which is also the guard that makes `p.expression` safe to compare.
    //
    // ...and that call must be AWAITED (Codex round-44 P2). Requiring the
    // executor to be the callee still accepted `void …bind(…).run()`: D1 is
    // handed the statement, but the ledger returns without observing whether it
    // completed or failed, and a Worker cancelled mid-flight loses the pending
    // write. "The statement was executed" and "the scan waited for the row" are
    // different claims, and this script's whole subject is the second one.
    const executedFrom = (bindCall) => {
      for (let cur = bindCall, p = cur.parent; p; cur = p, p = p.parent) {
        if (isTransparentWrapper(p)) continue;
        const member = memberNameOf(p);
        if (
          member !== null &&
          p.expression === cur &&
          EXECUTORS.includes(member) &&
          p.parent &&
          ts.isCallExpression(p.parent) &&
          p.parent.expression === p
        ) {
          // Walk out past wrappers to the first node that decides the call's
          // completion. An `await` anywhere above it — directly, or through
          // parentheses / assertions — is what makes the row observed.
          for (let q = p.parent.parent, child = p.parent; q; child = q, q = q.parent) {
            if (isTransparentWrapper(q)) continue;
            return ts.isAwaitExpression(q) && q.expression === child;
          }
          return false;
        }
        return false;
      }
      return false;
    };
    // A SWALLOWED failure is not a write (Codex round-48 P2). Requiring an
    // awaited execution settled that the statement is handed to D1 and waited
    // for; it said nothing about what happens when D1 rejects. Wrapped in
    // `try { … } catch {}` the ledger returns normally on any failure, the scan
    // advances `indexer_cursor`, and the missing activity row is skipped
    // permanently — the one failure here that cannot be repaired by a re-run.
    const swallowedInsert = inserts.length === 1 && (() => {
      for (let cur = inserts[0].node; cur && cur !== ledgerNode.body; cur = cur.parent) {
        const p = cur.parent;
        if (!p) break;
        if (ts.isTryStatement(p) && p.tryBlock === cur && p.catchClause) {
          // EVERY completing path must exit, not "a throw exists somewhere"
          // (Codex round-49 P2). One `throw` anywhere marked the whole handler
          // as rethrowing, so `catch (e) { if (false) throw e; }` passed while
          // swallowing every real failure. What matters is whether the handler
          // can COMPLETE — if it can, the ledger returns normally and the
          // cursor advances past the lost row.
          // PROPAGATES, which is not the same as exits (Codex round-50 P2).
          // My round-49 fix counted `return` alongside `throw` under the phrase
          // "every completing path exits" — but `catch { return 0; }` exits the
          // FUNCTION while resolving it normally, so the caller advances the
          // cursor exactly as it would on success. What has to be true is that
          // the failure reaches the caller, and only a throw does that.
          /** Can this block finish by `return` / `break` / `continue`? */
          const completesAbruptly = (node) => {
            let hit = false;
            const seek = (m) => {
              if (hit) return;
              if (
                ts.isReturnStatement(m) ||
                ts.isBreakStatement(m) ||
                ts.isContinueStatement(m)
              ) {
                hit = true;
                return;
              }
              if (isFunctionLike(m)) return; // a nested function's return is its own
              ts.forEachChild(m, seek);
            };
            if (node) seek(node);
            return hit;
          };
          const alwaysThrows = (node) => {
            if (!node) return false;
            if (ts.isThrowStatement(node)) return true;
            if (ts.isBlock(node)) {
              const last = node.statements[node.statements.length - 1];
              return alwaysThrows(last);
            }
            if (ts.isIfStatement(node)) {
              return (
                Boolean(node.elseStatement) &&
                alwaysThrows(node.thenStatement) &&
                alwaysThrows(node.elseStatement)
              );
            }
            if (ts.isTryStatement(node)) {
              // A `finally` that completes abruptly OVERRIDES a pending throw
              // (Codex round-51 P2) — `try { throw e } finally { return 0 }`
              // resolves normally, so the failure never reaches the caller and
              // the cursor advances. This branch ignored the finally block
              // entirely, which made the most obscure swallow the easiest one.
              if (node.finallyBlock && completesAbruptly(node.finallyBlock)) return false;
              // Propagates only if the try body does AND its own handler does.
              return (
                alwaysThrows(node.tryBlock) &&
                (!node.catchClause || alwaysThrows(node.catchClause.block))
              );
            }
            return false;
          };
          if (!alwaysThrows(p.catchClause.block)) return true;
        }
      }
      return false;
    })();
    if (swallowedInsert) {
      console.error(
        `[check-activity-refs-coverage] the activity_events INSERT in ${LEDGER_FN}() sits in a\n` +
          '  `try` whose `catch` does not rethrow.\n' +
          '  Awaiting the statement proves the scan waits for D1; it does not prove the row\n' +
          '  survived. A swallowed failure lets the ledger return normally, the scan advance\n' +
          '  `indexer_cursor` past those blocks, and the activity row be skipped for good —\n' +
          '  the one failure mode here a re-run cannot repair, and invisible to every count\n' +
          '  in this script. Rethrow, or update this script — do not delete the check.',
      );
      process.exit(1);
    }
    if (nonD1Prepare) {
      console.error(
        `[check-activity-refs-coverage] the activity_events statement in ${LEDGER_FN}() is\n` +
          `  prepared on something that is not a D1 binding:\n    ${nonD1Prepare}\n` +
          '  Every check here reads a statement built by `prepare` / `bind` / `run`, and any\n' +
          '  object exposing those names satisfies them — a stub whose `run()` resolves a\n' +
          '  plausible result passes while writing no row, and the scan then advances its\n' +
          '  cursor. Prepare on the D1 binding, or update this script — do not delete the\n' +
          '  check.',
      );
      process.exit(1);
    }
    if (dynamicSql) {
      console.error(
        `[check-activity-refs-coverage] the activity_events statement in ${LEDGER_FN}() is\n` +
          '  built from a dynamic SQL expression:\n' +
          `    ${dynamicSql.replace(/\s+/g, ' ').slice(0, 160)}\n` +
          '  Every column-order check below reads the SQL as source text, so an expression\n' +
          '  carrying more than one candidate statement is validated on whichever appears\n' +
          '  first in the file — while the runtime picks the other. A conditional whose\n' +
          '  losing arm has the right column order therefore passes every check here and\n' +
          '  files each reference in the wrong column. Pass one static string, or update\n' +
          '  this script — do not delete the check.',
      );
      process.exit(1);
    }
    if (inserts.length === 1 && !executedFrom(inserts[0].node)) {
      console.error(
        `[check-activity-refs-coverage] the activity_events statement in ${LEDGER_FN}() is\n` +
          '  bound but never executed.\n' +
          '  `.bind(...)` returns another PREPARED statement — it writes nothing until one\n' +
          `  of ${EXECUTORS.map((e) => '`.' + e + '()`').join(' / ')} runs it. Every check here reads the SQL\n` +
          '  and the bind list off that statement, so a prepared-and-dropped INSERT passes\n' +
          '  all of them while no activity row exists. Execute the statement, or update\n' +
          '  this script — do not delete the check.',
      );
      process.exit(1);
    }
    const skippable = inserts.length === 1 && unreachableReason(inserts[0].node);
    if (skippable) {
      console.error(
        `[check-activity-refs-coverage] the activity_events INSERT in ${LEDGER_FN}() sits\n` +
          `  ${skippable}.\n` +
          '  Everything this script checks about that write — the column order, the bind\n' +
          '  positions, the mapper it draws from — is worth nothing if the write does not\n' +
          '  run, and a skipped INSERT looks identical to a healthy one from here: the\n' +
          '  tally does not move and no row is written. Put the INSERT on the loop body\'s\n' +
          '  own path, or update this script — do not delete the check.',
      );
      process.exit(1);
    }
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
    // A column's index is its bind index ONLY when every column is filled by
    // one bare `?` (Codex round-36 P2). The alignment below indexes `bindArgs`
    // by the column's position in the list, which silently stops meaning
    // anything the moment a VALUES entry is a literal or an expression:
    // `VALUES (1, ?, ?, …, ? + ?)` shifts every placeholder by one, so SQLite
    // receives `eventName` in `loan_id` while this script reports the binds
    // correct. Rather than parse SQL expressions, require the simple shape the
    // alignment assumes and say so when it is gone.
    const valuesList = insertSql.match(/VALUES\s*\(([^()]*)\)/is)?.[1] ?? null;
    const placeholders = valuesList === null
      ? null
      : valuesList.split(',').map((v) => v.trim()).filter(Boolean);
    // A SPREAD in `.bind(...)` breaks the same correspondence from the other
    // side (Codex round-37 P2). Round 36 pinned the SQL half — one bare `?` per
    // column — and left the argument half assuming one AST node per runtime
    // value. `...([chainId, Number(log.blockNumber)] as const)` is one AST
    // argument carrying two, so every index after it points at the wrong value
    // and the alignment reports the binds correct while `loan_id` receives
    // whatever landed there. Both halves have to hold for a positional check to
    // mean anything.
    const spreadBind = bindArgs.find((a) => ts.isSpreadElement(a));
    if (spreadBind || bindArgs.length !== cols.length) {
      console.error(
        `[check-activity-refs-coverage] the activity_events INSERT's \`.bind(...)\` ${
          spreadBind ? 'contains a spread argument' : `passes ${bindArgs.length} arguments for ${cols.length} columns`
        }.\n` +
          '  This script finds `loan_id` / `offer_id` by their position in the column list\n' +
          '  and reads the bind argument at that same index, which only lines up while each\n' +
          '  column has exactly one argument of its own — a spread carries an unknown number\n' +
          '  of runtime values, shifting everything after it while every count here stays\n' +
          '  identical. Pass one argument per column, or update this script — do not delete\n' +
          '  the check.',
      );
      process.exit(1);
    }
    if (
      placeholders === null ||
      placeholders.length !== cols.length ||
      placeholders.some((v) => v !== '?')
    ) {
      console.error(
        '[check-activity-refs-coverage] the activity_events INSERT\'s VALUES list is no\n' +
          '  longer one bare `?` per named column.\n' +
          '  This script finds `loan_id` / `offer_id` by their position in the COLUMN list\n' +
          '  and reads `.bind(...)` at that same index, which is only the same position\n' +
          '  while every column is filled by its own placeholder — one literal or\n' +
          '  expression in VALUES shifts the rest and files each reference under a\n' +
          '  neighbouring column, with every count here unchanged. Keep the one-to-one\n' +
          '  shape, or update this script — do not delete the check.',
      );
      process.exit(1);
    }
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

  if (mapperShadowed) {
    console.error(
      `[check-activity-refs-coverage] ${LEDGER_FN}() calls a LOCAL binding named\n` +
        '  pluckActivityRefs, not the module-level mapper this script reads.\n' +
        '  Coverage here is decided entirely by the mapper\'s body, so a same-named local\n' +
        '  returning fixed references keeps every count identical while the rows carry\n' +
        '  whatever it returns. Call the module-level mapper, or update this script — do\n' +
        '  not delete the check.',
    );
    process.exit(1);
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
/**
 * ONE abrupt-completion analysis, shared by every place that asks it (Codex
 * round-33 P2).
 *
 * There used to be three separate traversals of this question — the pre-switch
 * bypass scan, the case-clause scan, and the default clause's — and for four
 * rounds running a rule landed on one and not its siblings: loop-owned breaks
 * (round 14, re-found in 32), caught throws (round 31, re-found in 32 and again
 * in 33), labeled breaks. Each fix was correct and each left the same evasion
 * live one traversal over. Three copies of one rule set is not a rule set.
 *
 * The question is: starting from these statements, can control complete ABRUPTLY
 * in a way that leaves the region? The answers come straight from the language:
 *
 * - a `throw` escapes unless an enclosing `try` inside the region catches it;
 * - a bare `break` binds to the nearest enclosing loop or switch, a bare
 *   `continue` to the nearest enclosing loop — inside the region, it does not
 *   leave; with none inside, it does;
 * - a labeled `break`/`continue` binds to its label, so it escapes exactly when
 *   that label is declared outside the region;
 * - nested functions are not on this path at all until called.
 *
 * `countReturns` adds `return` to the list, which is what the pre-switch scan
 * needs and the two clause scans must not have — inside a clause a `return` is
 * the successful outcome, not an escape.
 *
 * @returns a short phrase naming the first escape found, or null.
 */
const findEscape = (nodes, { countReturns = false } = {}) => {
  let hit = null;
  const walk = (n, st) => {
    if (hit) return;
    // An IMMEDIATELY INVOKED function IS on this path (Codex round-34 P2).
    // "Nested functions are not on this path until called" is the right rule and
    // the wrong test — `(() => { throw new Error('bypass'); })();` before the
    // switch is called right there, so every dispatch threw and activity
    // recording aborted while the scan skipped the body as unreachable.
    //
    // Its `throw` escapes into the caller, so it counts; its `return` and its
    // `break`/`continue` belong to the callee and cannot, so the body is walked
    // with returns off and breaks owned.
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      let callee = unwrapAssertions(n.expression);
      // `.call(…)` / `.apply(…)` invoke just as directly (Codex round-36 P2).
      // Round 34 matched only a function node in callee position, so
      // `(() => { throw e }).call(null)` presented as a property access and the
      // body was skipped as an ordinary nested function. `.bind(…)` is
      // deliberately NOT here — it returns a function without running it.
      //
      // Both syntaxes (Codex round-37 P2): `f['call'](…)` is the same
      // invocation as `f.call(…)`, and matching only the dotted form is the
      // same gap round 35 fixed for `Object['assign']`. Read through the shared
      // resolver so the two cannot drift apart again.
      const invokerName = memberNameOf(callee);
      if (
        (invokerName === 'call' || invokerName === 'apply') &&
        isFunctionLike(unwrapAssertions(callee.expression))
      ) {
        callee = unwrapAssertions(callee.expression);
      }
      if (isFunctionLike(callee) && callee.body) {
        // ...but only when its throws leave SYNCHRONOUSLY (Codex round-35 P2).
        // An async function's throw becomes a rejected promise, so
        // `void (async () => { throw e })().catch(() => {})` reaches the switch
        // perfectly well — rejecting it blocked `typecheck` on a valid
        // refactor. A generator's body does not run at the call at all; the
        // call returns an iterator. Both are skipped like any other nested
        // function. An AWAITED async call is the exception that proves the
        // rule: there the rejection does propagate into this frame.
        const isAsync = (callee.modifiers ?? []).some(
          (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
        );
        const isGenerator = Boolean(callee.asteriskToken);
        const awaited = n.parent && ts.isAwaitExpression(n.parent);
        if (isGenerator || (isAsync && !awaited)) {
          (n.arguments ?? []).forEach((a) => walk(a, st));
          return;
        }
        walk(callee.body, { ...st, breakable: true, loop: true, iife: true });
        (n.arguments ?? []).forEach((a) => walk(a, st));
        return;
      }
    }
    if (isFunctionLike(n)) return;
    if (ts.isReturnStatement(n)) {
      if (st.iife) return;
      if (countReturns) hit = 'a return';
      return;
    }
    if (ts.isThrowStatement(n)) {
      if (!st.caught) hit = 'a throw';
      return;
    }
    if (ts.isBreakStatement(n) || ts.isContinueStatement(n)) {
      const escapes = n.label
        ? !st.labels.has(n.label.text)
        : !(ts.isBreakStatement(n) ? st.breakable : st.loop);
      if (escapes) hit = 'a break/continue';
      return;
    }
    if (ts.isLabeledStatement(n)) {
      const labels = new Set(st.labels);
      labels.add(n.label.text);
      walk(n.statement, { ...st, labels });
      return;
    }
    if (
      ts.isForStatement(n) ||
      ts.isForOfStatement(n) ||
      ts.isForInStatement(n) ||
      ts.isWhileStatement(n) ||
      ts.isDoStatement(n)
    ) {
      ts.forEachChild(n, (c) => walk(c, { ...st, breakable: true, loop: true }));
      return;
    }
    // A switch owns `break` but NOT `continue` — the distinction the three old
    // copies all lumped together.
    if (ts.isSwitchStatement(n)) {
      ts.forEachChild(n, (c) => walk(c, { ...st, breakable: true }));
      return;
    }
    if (ts.isTryStatement(n)) {
      // Throws in the try block are handled when this try has a catch; a nested
      // try without one still propagates outward, so the flag is carried rather
      // than reset. The catch's and finally's own throws are not caught here.
      walk(n.tryBlock, { ...st, caught: st.caught || Boolean(n.catchClause) });
      if (n.catchClause) walk(n.catchClause.block, st);
      if (n.finallyBlock) walk(n.finallyBlock, st);
      return;
    }
    ts.forEachChild(n, (c) => walk(c, st));
  };
  for (const n of nodes) {
    walk(n, { caught: false, breakable: false, loop: false, labels: new Set() });
  }
  return hit;
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
  // A throw the pre-switch code CATCHES itself is not a bypass (Codex round-33
  // P2). `try { if (…) throw e; } catch {}` above the switch always proceeds to
  // it, and rejecting it blocked `typecheck` on an ordinary defensive guard.
  // The case scan had learned this two rounds earlier; this traversal had not,
  // which is what `findEscape` exists to stop happening again.
  if (!findEscape([st], { countReturns: true })) continue;
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
const readsArgPath = (rawExpr) => {
  // The OUTSIDE is unwrapped too (Codex round-45 P2). Round 10 taught this
  // function to unwrap at every step INSIDE the call, and left its own entry
  // condition testing the raw node — so wrapping the conversion itself,
  // `(Number(args.offerId as bigint))`, was rejected as not-a-call and the
  // mapping reported as missing. Runtime-identical to the accepted form, and it
  // failed the indexer typecheck.
  const expr = rawExpr ? unwrapForInvocation(rawExpr) : rawExpr;
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
// Unwrapped before the test (Codex round-46 P2). Testing the raw node made
// `loanId: (null)` — runtime-identical to `loanId: null` — read as a non-null
// mapping and reported as suspect, blocking the indexer typecheck on a value
// that is still stored as NULL. Same shape as round 45's `readsArgPath` fix: the
// unwrapping existed, and the classifier at the door did not use it.
const isNullLiteral = (expr) =>
  Boolean(expr) && unwrapAssertions(expr).kind === ts.SyntaxKind.NullKeyword;

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
    // A NESTED function's bindings shadow nothing out here (Codex round-40 P2).
    // This walk descends into every child, so an ordinary local helper
    // containing `const Number = () => 7` was reported as shadowing "for EVERY
    // case" — a false positive that blocks `typecheck` on code that leaves
    // every mapping untouched. The per-case scan has stopped at function
    // boundaries since round 11; this one, written for the same question one
    // level out, never learned it.
    //
    // ...but a function DECLARATION's own name binds in the ENCLOSING scope and
    // is hoisted, so it shadows out here even though its body does not (Codex
    // round-41 P2). Returning before the declaration check below meant
    // `function Number(_v: unknown) { return 999; }` inside the mapper was
    // waved through, and every mapped reference becomes 999. The boundary stop
    // was right; placing it above the check that inspects the boundary's own
    // name was not. A function EXPRESSION or arrow is genuinely invisible here,
    // since its name — where it has one — binds only inside itself.
    if (isFunctionLike(n)) {
      if (ts.isFunctionDeclaration(n) && n.name && bindsShadowable(n.name)) {
        outerShadow = n.name.text;
      }
      return;
    }
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
  // The mapper's OWN PARAMETERS shadow too (Codex round-42 P2). This walk
  // started at the body, so an optional parameter
  // `Number: (v: unknown) => number = () => 999` left every existing call site
  // valid, typechecked, and turned every mapped reference into 999. A parameter
  // is the one binding form that is neither inside the body nor outside the
  // function.
  //
  // From the THIRD parameter on: the mapper is defined to take the event name
  // and the decoded arguments, so its own `args` is the very binding every
  // mapping relies on — flagging it would refuse the live code. Anything BEYOND
  // those two is an addition, and an addition binding `args` or `Number` is a
  // shadow however innocuous its default looks.
  //
  // A parameter's DEFAULT is code too (Codex round-43 P2). Round 42 inspected
  // only the binding NAME, so an added parameter with a harmless name and a
  // side-effecting default — `_sideEffect = (args.loanId = 999)` — was waved
  // through while running before the body on every existing two-argument call,
  // turning every direct mapping into 999. An initializer gets the same walk
  // the body gets, which already refuses a declaration, an alias, or a write.
  for (const param of (fnNode.parameters ?? []).slice(2)) {
    if (bindsShadowable(param.name)) {
      outerShadow = ts.isIdentifier(param.name)
        ? param.name.text
        : 'args/Number (a destructured parameter)';
      break;
    }
    if (param.initializer) {
      walkOuter(param.initializer);
      // ...and INTO a function the default immediately invokes (Codex round-44
      // P2). `walkOuter` stops at every function-like node, which is right for
      // an ordinary helper — nothing here calls it — and wrong for
      // `(() => { args.loanId = 999 })()`, which runs before the body on every
      // existing call. The escape analysis has understood invoked IIFEs since
      // round 34; this walk, added one round ago for the same question, had not.
      // RECURSIVELY (Codex round-46 P2). Round 45 handed only the outer
      // initializer to `invokedFunctionBodyOf`, and `walkOuter` stops at every
      // nested function without asking whether it is immediately invoked — so
      // `(() => { (() => { args.loanId = 999; })(); })()` hid one level down.
      // Each descent is into a body that provably runs, so there is no depth at
      // which it stops being a real mutation; the bound is only against a
      // pathological nest.
      if (!outerShadow) {
        const seen = new Set();
        const descend = (node, depth) => {
          if (outerShadow || depth > 8 || !node || seen.has(node)) return;
          seen.add(node);
          const invoked = invokedFunctionBodyOf(node);
          if (!invoked) return;
          walkOuter(invoked);
          if (outerShadow) return;
          // Statement bodies hold their invoked calls one level in.
          const inner = [];
          const collect = (m) => {
            if (ts.isCallExpression(m)) inner.push(m);
            if (!isFunctionLike(m) || m === invoked) ts.forEachChild(m, collect);
          };
          ts.forEachChild(invoked, collect);
          for (const c of inner) descend(c, depth + 1);
        };
        descend(param.initializer, 0);
      }
      if (outerShadow) {
        outerShadow = `${outerShadow} (in a parameter default)`;
        break;
      }
    }
  }
  if (!outerShadow && fnNode.body) ts.forEachChild(fnNode.body, walkOuter);
  if (outerShadow) {
    structural.push(
      `pluckActivityRefs declares '${outerShadow}' in its own body, shadowing what the accepted mapping shape relies on for EVERY case — this checker cannot tell the two apart`,
    );
  }
  // MODULE scope shadows the mapper too (Codex round-44 P2). Every check above
  // searches the mapper's parameters and body, on the reasoning that a shadow
  // has to be somewhere the mapper can see — which is true, and the module is
  // one of those places. A file-level `const Number = …` returning 999 is
  // visible to every case, typechecks when given `NumberConstructor`'s shape,
  // and turns every mapped reference into 999.
  //
  // `Number` and `args` are GLOBALS or parameters in the honest file, so nothing
  // binds them at module scope and the resolver returns null. A non-null answer
  // means something does.
  //
  // A DEDICATED module-scope lookup, deliberately not `nearestDeclIn`. That
  // resolver walks `scope.parent` and only reads statements out of a `Block` /
  // case clause, so it never sees module scope at all — and the ledger-call
  // check DEPENDS on that: it reads `nearestDeclIn(…, LEDGER_FN, …) === null` as
  // "the module-level writer is what this name reaches". Teaching the shared
  // resolver about module scope would make the module-level `recordActivityEvents`
  // resolve to a binding and fail the live file. So the module question gets its
  // own answer rather than a widened resolver.
  //
  // The mapper's own `args` parameter is not module scope, so it is out of range
  // here by construction — which is the boundary the `.slice(2)` loop above has
  // to draw by hand.
  const moduleBindsName = (name) => {
    for (const st of sourceFile.statements) {
      if (
        (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) &&
        st.name &&
        declaresName(st.name, name)
      ) {
        return true;
      }
      // An IMPORT binds at module scope too (Codex round-45 P2). Importing a
      // callable AS `Number` — typed `NumberConstructor`-compatibly and always
      // returning 999 — passed while every accepted conversion used it. A
      // declaration is not the only way a module-scope name arrives, and an
      // import is the one form that carries no initializer to inspect.
      if (ts.isImportDeclaration(st) && st.importClause) {
        const { name: defaultName, namedBindings } = st.importClause;
        if (defaultName && declaresName(defaultName, name)) return true;
        if (namedBindings) {
          if (ts.isNamespaceImport(namedBindings) && declaresName(namedBindings.name, name)) {
            return true;
          }
          if (ts.isNamedImports(namedBindings)) {
            // The LOCAL name is what shadows — `{ evil as Number }` binds Number.
            for (const el of namedBindings.elements) {
              if (declaresName(el.name, name)) return true;
            }
          }
        }
      }
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (declaresName(d.name, name)) return true;
      }
    }
    return false;
  };
  //
  // `Number` ONLY, not `args` (Codex round-46 P2 — my error one round earlier).
  // Shadowing has a direction, and I had it backwards: the mapper's own `args`
  // PARAMETER shadows any module-scope binding of that name, so a harmless
  // top-level `const args = …` cannot affect a single mapper read — and listing
  // it here rejected every case on live code. `Number` is different precisely
  // because the mapper does NOT bind it: its reads reach outward, so a
  // module-scope binding is what they find.
  for (const shadowable of ['Number']) {
    if (moduleBindsName(shadowable)) {
      structural.push(
        `'${shadowable}' is bound outside pluckActivityRefs, shadowing the global the accepted mapping shape relies on for EVERY case — this checker cannot tell the two apart`,
      );
    }
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
        const escape = findEscape(clause.statements);
        if (escape) {
          structural.push(
            `the default clause contains ${escape} — every event without a case, and every allowlisted one, is filed from here, so it must reach the all-null return on every path`,
          );
        } else if (!alwaysReturns(clause.statements[clause.statements.length - 1])) {
          // Collected returns are not a MUST-return proof (Codex round-33 P2).
          // The scan above rules out the abrupt ways to leave; it says nothing
          // about ordinary fall-through. `default: for (…) { if (c) return
          // nullRefs; break; }` has a valid return, no escaping abrupt exit —
          // the break belongs to the loop — and still drops out of the switch
          // for every iteration that does not take the `if`, landing on the
          // mapper's trailing return, which a hostile edit can make
          // `{ loanId: 999 }`. Both questions have to be asked: nothing may
          // leave abruptly, AND control must reach a return.
          structural.push(
            'control can fall out of the default clause without returning — every event without a case, and every allowlisted one, is filed from here, so it must return the all-null object on every path rather than drop through to whatever follows the switch',
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
    // Every rule this scan used to carry by hand — loop-owned breaks (round 14),
    // labeled breaks (round 12), caught throws (round 31), loops nested inside a
    // try (round 32) — now lives in `findEscape`, which the pre-switch scan and
    // the default clause read too (Codex round-33 P2). The rules were correct
    // here and kept arriving late in the siblings.
    const groupStatements = pendingStatements;
    const escapesWithoutReturning =
      !alwaysReturns(last) || Boolean(findEscape(groupStatements));

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
      let syncLimit = Infinity;
      const walk = (n) => {
        if (found) return;
        if (n.getStart(sourceFile) >= syncLimit) return;
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
        // ...unless the function is IMMEDIATELY INVOKED (Codex round-47 P2).
        // Stopping at every function-like node is right for a helper nothing
        // calls, and wrong for `(() => { args.loanId = 999n; })()` sitting in a
        // case body: it runs before the return, and the accepted
        // `Number(args.loanId)` then reads 999. The parameter-default walk
        // learned this in rounds 44 and 46; this scan, asking the same question
        // about the same names, had not.
        const invokedHere = invokedFunctionBodyOf(n);
        if (invokedHere) {
          // Only the SYNCHRONOUS prefix of an async IIFE (Codex round-48 P2) —
          // its continuation cannot run before the mapper copies out. The limit
          // is scoped to this descent and restored after, so it constrains the
          // invoked body without affecting the surrounding case scan.
          const previousLimit = syncLimit;
          syncLimit = Math.min(syncLimit, syncCutoffOf(n, sourceFile));
          walk(invokedHere);
          syncLimit = previousLimit;
          if (found) return;
        }
        // A CLASS body is not an inert boundary (Codex round-48 P2). Evaluating
        // a class declaration runs its static blocks and static field
        // initializers immediately, so `class H { static { args.loanId = 999n } }`
        // executes before the case's return while this scan skipped the whole
        // declaration as "a function-like thing nothing calls". Only the static
        // parts run at declaration; methods genuinely do not.
        if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
          for (const member of n.members ?? []) {
            const isStatic = (member.modifiers ?? []).some(
              (m) => m.kind === ts.SyntaxKind.StaticKeyword,
            );
            if (ts.isClassStaticBlockDeclaration?.(member)) {
              walk(member.body);
            } else if (isStatic && ts.isPropertyDeclaration(member) && member.initializer) {
              walk(member.initializer);
            }
            if (found) return;
          }
          return; // the rest of the class body does not run at declaration
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
