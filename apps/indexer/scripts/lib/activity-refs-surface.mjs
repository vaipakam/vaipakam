/**
 * The activity-refs SURFACE — which compiled events carry a loanId/offerId
 * reference, under which ABI input names, and which pairs are deliberately
 * not scoped (each with a reason).
 *
 * ONE derivation, shared by the two enforcement halves (round-69 redesign):
 *
 *   - `scripts/check-activity-refs-coverage.mjs` — the data-integrity gate:
 *     barrel/ABI structure, allowlist hygiene. Pure data; runs in `typecheck`.
 *   - `test/activityRefsCoverage.test.ts` — the behavioral gate: EXECUTES the
 *     real `pluckActivityRefs` over this surface with synthesized args and
 *     asserts every non-allowlisted pair actually resolves. Runs in `vitest`.
 *
 * The split replaced ~5,000 lines of TypeScript-AST inference that tried to
 * prove statically what the mapper and the ledger do. That design could not
 * converge: for any finite set of recognized syntax shapes there is another
 * JavaScript construct that defeats it, and 40+ review rounds kept finding
 * them, one shape at a time. Executing the real code answers the same
 * questions by observation — a getter runs, an alias resolves, a spread
 * spreads — so there is no shape catalogue left to evade.
 *
 * Everything in here is DECIDABLE: reading JSON ABIs, resolving the barrel's
 * spread list, and matching input-name shapes. No TypeScript parsing.
 *
 * Fatal structural problems (an unresolvable barrel, an unreadable member, an
 * allowlist entry with no reason) THROW with the full report text — the
 * checker prints and exits 1, the test suite fails with the same message.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const ABI_DIR = join(REPO_ROOT, 'packages', 'contracts', 'src', 'abis');

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
export const DELIBERATELY_NOT_SCOPED = {
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


export const REF_FIELDS = ['loanId', 'offerId'];

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
export const REF_SHAPE = {
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
export const REF_EXTRA_ALIASES = {
  loanId: [],
  offerId: [],
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * For a MAPPED event/field with MORE THAN ONE candidate alias, the alias the
 * mapping is REQUIRED to read (Codex round-72 P2). Accepting any candidate
 * proves only that some alias reached the column; which one is a per-event
 * policy decision with its own rationale, and silently switching to the other
 * candidate (e.g. `OfferMatched` → borrowerOfferId) passes the any-alias test
 * while the intended history view loses its rows. Keyed '<Event>.<field>' →
 * the ABI input path the mapping must read. Only mapped multi-alias pairs
 * belong here — the coverage suite fails a mapped multi-alias pair with no
 * entry, and fails an entry whose pair is no longer carried, no longer
 * multi-alias, or no longer mapped.
 */
export const INTENDED_REFERENCE_ALIAS = {
  // #600 — a matcher-driven fill calls acceptOfferInternal(borrowerOfferId),
  // so the companion OfferAccepted already attributes the loan to the
  // BORROWER offer; this event is the LENDER offer's only link to its matched
  // child, and the row is deliberately indexed under it.
  'OfferMatched.offerId': 'lenderOfferId',
  // Leg A is the canonical loanId for the activity row (the dashboard's
  // loan-timeline query keys on this column); legs B and the optional C stay
  // in args_json for clients that need the full multi-leg payload.
  'InternalMatchExecuted.loanId': 'loanIdA',
};

/** Does this ABI input name populate `field`? */
export const isAliasOf = (field, name) =>
  typeof name === 'string' &&
  (REF_SHAPE[field].test(name) || REF_EXTRA_ALIASES[field].includes(name));


/**
 * Derive the surface. Returns:
 *   carries        eventName -> Set<field>                      (loanId/offerId)
 *   aliasNames     eventName -> Map<field, Set<ABI input path>> (what can populate it)
 *   eventInputs    eventName -> signature string                (overload detection)
 *   argShapes      eventName -> Map<signature, [{path, type}]>  (for args synthesis;
 *                  one layout per DISTINCT signature, so every overload is present)
 *   arrayOnlyRefs  '<Event>.<field>' -> path                    (array-only references)
 *   abiConflicts   [{kind, event, message}]                     (ABI-side problems)
 *
 * Throws on structural problems that make the derivation itself untrustworthy.
 */
export function deriveActivityRefsSurface() {
  /**
   * The barrel, with comments stripped (Codex round-4 P2): a member disabled by
   * commenting it out — `// ...OfferMatchFacetABI`, the natural way to remove
   * one — must not read as live. Line comments are cut only where `//` is not
   * part of `://`, so a URL inside a string survives.
   */
  const barrelSrc = readFileSync(join(ABI_DIR, 'index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  /**
   * `import FooABI from './Foo.json'` → identifier -> filename. Either quote
   * style: a member whose import this cannot read becomes an unresolved
   * spread, which is a hard failure rather than a silent omission.
   */
  const importedFile = new Map();
  for (const m of barrelSrc.matchAll(
    /import\s+([A-Za-z0-9_]+)\s+from\s+['"]\.\/([^'"]+\.json)['"]/g,
  )) {
    importedFile.set(m[1], m[2]);
  }

  const diamondBlock = barrelSrc.match(/export const DIAMOND_ABI\s*=\s*\[([\s\S]*?)\n\]/);
  if (!diamondBlock) {
    throw new Error(
      '[activity-refs surface] could not locate the DIAMOND_ABI array in the abis barrel.\n' +
        'If it was restructured, update this derivation — do not delete the check.',
    );
  }
  /**
   * Every spread must resolve to a file (Codex round-3 P2) — losing ONE facet
   * silently drops every reference-bearing event in it out of coverage. And
   * the array may contain NOTHING BUT spreads (Codex round-15 P2): a direct
   * element is decoded by EVENT_ABI at runtime while this derivation cannot
   * see it, so removing every spread must leave only separators behind.
   */
  const memberFiles = [];
  const unresolvedMembers = [];
  for (const m of diamondBlock[1].matchAll(/\.\.\.([A-Za-z0-9_]+)/g)) {
    const file = importedFile.get(m[1]);
    if (file) memberFiles.push(file);
    else unresolvedMembers.push(m[1]);
  }
  const abiResidue = diamondBlock[1].replace(/\.\.\.[A-Za-z0-9_]+/g, '').trim();
  if (/[^\s,]/.test(abiResidue)) {
    throw new Error(
      '[activity-refs surface] DIAMOND_ABI contains entries that are not spreads of an\n' +
        '  imported ABI file, so this derivation cannot tell what events they carry while\n' +
        '  EVENT_ABI still decodes them:\n' +
        abiResidue
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => /[^\s,]/.test(l))
          .map((l) => `    ${l.length > 160 ? `${l.slice(0, 157)}…` : l}`)
          .join('\n') +
        '\n  Move the entry into an ABI JSON and spread it, or teach this derivation to read\n' +
        '  it — do not let an event into the decoded set that coverage cannot see.',
    );
  }
  if (unresolvedMembers.length) {
    throw new Error(
      `[activity-refs surface] ${unresolvedMembers.length} DIAMOND_ABI member(s) could not be\n` +
        '  resolved to an ABI file, so their events would silently leave coverage:\n' +
        unresolvedMembers.map((id) => `    ...${id}`).join('\n') +
        "\n  Each must be a `import X from './X.json'` this derivation can follow.",
    );
  }
  if (memberFiles.length === 0) {
    throw new Error(
      '[activity-refs surface] resolved zero DIAMOND_ABI members — refusing to pass vacuously.',
    );
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
  /** eventName -> [{path, type}] — every dotted leaf path with its ABI type. */
  const argShapes = new Map();
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
      // Kept SEPARATE from `typeOf` (Codex round-54 P2) — that map is read by the
      // numeric-shape checks below, which ask what a field decodes to, not where
      // it decodes from. Only the overload signature wants the layout.
      const indexedOf = new Map();
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
          indexedOf.set(path, i.indexed === true);
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
      // ...and by INDEXED LAYOUT (Codex round-54 P2). Name and type alone call two
      // definitions identical when they disagree only on where a field lives, and
      // that disagreement is exactly what breaks decoding: `indexed` moves a value
      // out of the data blob into a topic, so the two carry the SAME canonical
      // topic-0 (`LoanSettled(uint256)`) while laying the log out differently. The
      // runtime `EVENT_ABI` dedupes them, keeps whichever it saw first, and every
      // log emitted under the other layout fails to decode and is dropped — with
      // no mapping error, because the mapper is never reached.
      //
      // A dropped log is invisible to every count in this script, which is the
      // property that makes it worth refusing rather than tolerating.
      // ORDERED, not sorted (Codex round-56 P2). Sorting made the signature a bag
      // and erased argument POSITION — so swapping two same-typed indexed inputs
      // (`SwapAdapterAttempted`'s `loanId` and `adapterIdx`, both indexed uint256)
      // compared equal. Those definitions share a topic signature but assign
      // different meanings to topics 1 and 2, so whichever layout `EVENT_ABI`
      // keeps decodes the other facet's logs with the fields transposed — a
      // reference read from the wrong topic, silently, with no decode error.
      //
      // Order is part of the ABI. Comparing a sorted bag was comparing something
      // weaker than the thing that has to match.
      // ...and the `anonymous` flag (Codex round-59 P2): an anonymous event has
      // no topic-0, so two definitions differing only in that flag have
      // different wire layouts while their input lists compare identical —
      // whichever one EVENT_ABI keeps, the other form's logs fail to decode and
      // are dropped.
      const signature =
        (item.anonymous === true ? 'anonymous|' : '') +
        names
          .map((n) => `${n}:${typeOf.get(n) ?? '?'}${indexedOf.get(n) ? ':indexed' : ''}`)
          .join(',');
      const priorSig = eventInputs.get(item.name);
      if (priorSig !== undefined && priorSig !== signature) {
        abiConflicts.push({
          kind: 'overload',
          event: item.name,
          message: `${item.name} — two ABI definitions that disagree on their argument bag or on which fields are \`indexed\` (${priorSig} vs ${signature}); a name-keyed mapper cannot be correct for both, and an indexed-only difference additionally makes one of the two layouts undecodable at runtime`,
        });
      }
      eventInputs.set(item.name, signature);

      // Leaf argument shapes, for callers that SYNTHESIZE a decoded-args bag
      // and EXECUTE the real mapper against it (the round-69 redesign): every
      // dotted path with its ABI type. Tuple parents are recorded by `collect`
      // too but carry type 'tuple'; synthesis skips them — the leaves create
      // the nesting. Keyed per SIGNATURE, not per name (Codex round-71 P2):
      // a name-keyed map kept only the last-parsed overload's layout, so an
      // overloaded event's OTHER layout was never synthesized and a mapping
      // reading a field unique to it went unexecuted. The same event repeated
      // across member ABI files with the same signature dedupes here.
      let layouts = argShapes.get(item.name);
      if (!layouts) {
        layouts = new Map();
        argShapes.set(item.name, layouts);
      }
      layouts.set(
        signature,
        names.map((n) => ({ path: n, type: typeOf.get(n) ?? '' })),
      );
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

  // Every allowlist entry must state a reason (Codex round-12 P2) and be keyed
  // '<Event>.<field>' (rounds 1 + 20): an event-wide key follows the event
  // through an ABI rename and silently exempts whatever reference it carries
  // next, while its stated reason still describes the old one.
  {
    const blank = Object.entries(DELIBERATELY_NOT_SCOPED)
      .filter(([, reason]) => typeof reason !== 'string' || reason.trim() === '')
      .map(([key]) => key);
    if (blank.length) {
      throw new Error(
        '[activity-refs surface] allowlist entries with no stated reason:\n' +
          blank.map((k) => `    ${k}`).join('\n') +
          '\n  An exemption without a reason is an undocumented gap wearing the word\n' +
          '  "deliberately". Give it a reason, or a TODO(#1794) marker if it is a gap.',
      );
    }
    const wrongShape = Object.keys(DELIBERATELY_NOT_SCOPED).filter((key) => {
      const dot = key.indexOf('.');
      const field = dot === -1 ? null : key.slice(dot + 1);
      return !field || !REF_FIELDS.includes(field);
    });
    if (wrongShape.length) {
      throw new Error(
        '[activity-refs surface] allowlist entries must be keyed\n' +
          `  '<Event>.<field>' with field one of ${REF_FIELDS.join(' / ')}:\n` +
          wrongShape.map((k) => `    ${k}`).join('\n'),
      );
    }
  }

  return { carries, aliasNames, eventInputs, argShapes, arrayOnlyRefs, abiConflicts };
}
