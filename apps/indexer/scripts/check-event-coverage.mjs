#!/usr/bin/env node
/**
 * Event-coverage guardrail.
 *
 * The indexer's `loans` / `offers` D1 tables are a projection of
 * on-chain state. For that projection to stay consistent, EVERY
 * contract event tagged `@custom:event-category state-change/loan-mutation`
 * or `state-change/offer-mutation` must either:
 *   (a) have a handler in `apps/indexer/src/chainIndexer.ts` — i.e. a
 *       `log.eventName === 'Foo'` branch in the dispatch — or
 *   (b) be in the explicit `DELIBERATELY_NOT_HANDLED` allowlist below,
 *       with a one-line reason.
 *
 * This script fails (exit 1) if any `state-change/{loan,offer}-mutation`
 * event is neither handled nor allowlisted. It's the enforcement
 * mechanism behind "the indexer is a projection — keep it complete":
 * the alternative (hand-maintained event lists + hand-written handlers)
 * silently drifts — see the May-2026 incident where the indexer's
 * `EVENT_ABI` had wrong arg counts on `LoanRepaid` / `LoanDefaulted`
 * (→ wrong topic0 → never decoded → every loan stuck `active`).
 *
 * Other `state-change/*` categories (vault / nft / treasury / claim /
 * reward) are NOT enforced here — the indexer schema doesn't model
 * those entities. They're still DECODED (the EVENT_ABI is derived from
 * the full compiled Diamond ABI) and recorded into `activity_events`
 * for the audit feed; they just don't drive a typed table.
 *
 * Run: `node apps/indexer/scripts/check-event-coverage.mjs`
 *      (or `pnpm --filter @vaipakam/indexer check-event-coverage`)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const CONTRACTS_SRC = join(REPO_ROOT, 'contracts', 'src');
const CHAIN_INDEXER = join(REPO_ROOT, 'apps', 'indexer', 'src', 'chainIndexer.ts');

/** State-change events the indexer deliberately does NOT reflect in a
 *  typed table — keep each with a one-line reason. Adding an entry here
 *  is a conscious decision; removing the corresponding contract event
 *  later just makes the allowlist entry dead (harmless). */
const DELIBERATELY_NOT_HANDLED = {
  PartialCollateralWithdrawn:
    'TEMPORARY — the handler needs the `newCollateralAmount` field added to the event in commit bd0e4aa, which is not yet on-chain. When the next contracts redeploy lands (+ ABI re-export + indexer redeploy), add a `log.eventName === "PartialCollateralWithdrawn"` branch (UPDATE loans SET collateral_amount = newCollateralAmount) and REMOVE this entry — the deadAllowlist check will flag it if you forget the removal',
  LoanFallbackPending:
    'transient status — the indexer keeps loans.status=active through the fallback episode; the eventual terminal event still applies',
  LoanCuredFromFallback:
    'transient — pairs with LoanFallbackPending; D1 status was never moved off active',
  LoanSold:
    'original loan stays Active with a new lender (covered by the position-NFT Transfer handler); the sale spins up an internal temp loan that transitions Active→Repaid on-chain but emits no status event — contract-side follow-up',
  LoanSaleCompleted: 'see LoanSold',
  LoanSaleOfferLinked:
    'intermediate "sale offer linked to live loan" marker — no loans/offers row change',
  LoanKeeperEnabled: 'per-loan keeper authorization — not modelled in the indexer schema',
  OfferKeeperEnabled: 'per-offer keeper authorization — not modelled',
  OfferCreatedDetails:
    'companion to OfferCreated — the offer row is still built via a getOfferDetails read-back; switching the offer side to consume this companion event (the loan side already consumes LoanInitiatedDetails) is a follow-up',
  OfferCanceledDetails: 'companion to OfferCanceled — extra fields not needed beyond the status flip',
  OffsetOfferCreated:
    'internal offset offer for preclose-option-3 — not surfaced in the public /offers list',
  AutoDailyDeducted: 'NFT-rental daily-fee deduction — surfaced via activity_events, no loans row field for it',
  HFLiquidationTriggered:
    'liquidation-attempt marker — the actual status change to Defaulted arrives via LoanLiquidated / LoanDefaulted, which ARE handled',
  LoanPartiallyLiquidated:
    'partial-liquidation companion event — surfaced via activity_events but the loans row keeps its Active status with reduced principal/collateral (read via live RPC getLoanDetails). Schema-side indexing is a follow-up.',
  LiquidationDiscounted:
    'discount-path companion event (flash-loan path, FlashLoanLiquidationPath.md) — surfaced via activity_events; the loan-status flip to Defaulted arrives via LoanDefaulted which IS handled.',
  AutoListOptOutCleared:
    'T-086 Round-7 (#355) — borrower-side opt-out clear is a UI-facing action signal, not a loans/offers row mutation. The opt-out flag is exposed as a live read via the production getter `NFTPrepayListingFacet.getPrepayListingAutoListOptedOut(uint256)` (Codex round-13 P2 #3 follow-up — added so the indexer / UI can render the live state without optimistic-retry against the auto-list reverts). Round-12 follow-up dropped the AutoListPosted / AutoListRotated events in favor of re-emitting the existing PrepayListingPosted / PrepayListingUpdated (those ARE handled), so this is the only auto-list signal that does not fold into an existing handler.',
  PostParallelSaleListing:
    'T-086 Round-8 (#358) §19.5 — UI-facing breadcrumb so the dapp can publish the order JSON to OpenSea + render the "this offer has a live OpenSea listing" banner. Not a loans/offers row mutation — the offer row stays Open (the §19.7e ConsumedBySale terminal flip only fires on actual sale fill). Indexer follow-up: surface the parallel-sale order hash in /offers/{id} via a fresh `getOffer` read-back, sourcing the row mutation from the eventual OfferConsumedBySale / OfferCanceled event instead.',
  ParallelSaleLockReleased:
    'T-086 Round-8 (#358) §19.7f — non-destructive unwind of the parallel-sale binding (offer stays Open). Mirrors the AutoListOptOutCleared rationale: UI-facing signal, no loans/offers row mutation.',
  OfferConsumedBySale:
    'T-086 Round-8 (#358) §19.7 — the executor calls into the diamond at sale-fill time; this companion event records the terminal flip + the executor that drove it. The terminal state itself is read via `s.offerConsumedBySale` (a `getOfferState` view returns OfferState.ConsumedBySale once set); the indexer surfaces it via a getOfferState read-back like the existing Cancelled path. Schema-side `offers.status` enum widening to include ConsumedBySale is a follow-up.',
  OfferSaleProceedsCredited:
    'T-086 Round-8 (#358) §19.7 — companion event recording the proceeds amount credited to the borrower\'s vault protocol-tracked balance. UI-facing breadcrumb so the borrower\'s "withdrawable balance" pane can refresh; no loans/offers row field for it directly (the proceeds land in `vaultProtocolTrackedBalance` which the standard `vaultWithdrawERC20` pulls from). Schema-side activity_events surfacing is a follow-up.',
};

/** Recursively collect every `.sol` file under a directory. */
function walkSol(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkSol(p));
    else if (entry.endsWith('.sol')) out.push(p);
  }
  return out;
}

// ── 1. Collect `state-change/{loan,offer}-mutation` events ─────────────
// The annotation `/// @custom:event-category state-change/X` sits on the
// line(s) immediately before the `event Foo(...)` declaration. Match the
// annotation, then the nearest following `event <Name>(`. The non-greedy
// `[\s\S]*?` between them tolerates additional natspec lines but stops at
// the first `event`.
const ENFORCED_CATEGORIES = new Set([
  'state-change/loan-mutation',
  'state-change/offer-mutation',
]);
const stateChangeEvents = new Map(); // name -> { file, category }
const ANNOT_RE =
  /@custom:event-category\s+(state-change\/[a-z-]+)[\s\S]*?\n\s*event\s+([A-Za-z0-9_]+)\s*\(/g;
for (const file of walkSol(CONTRACTS_SRC)) {
  const src = readFileSync(file, 'utf8');
  let m;
  while ((m = ANNOT_RE.exec(src)) !== null) {
    const [, category, name] = m;
    if (!ENFORCED_CATEGORIES.has(category)) continue;
    // First declaration wins (same event re-declared across facets is
    // fine — identical signature). Keep the first file we saw it in.
    if (!stateChangeEvents.has(name)) {
      stateChangeEvents.set(name, { file: relative(REPO_ROOT, file), category });
    }
  }
}

// ── 2. Collect handled event names from chainIndexer.ts ────────────────
const indexerSrc = readFileSync(CHAIN_INDEXER, 'utf8');
const handled = new Set();
for (const m of indexerSrc.matchAll(/log\.eventName === '([A-Za-z0-9_]+)'/g)) {
  handled.add(m[1]);
}

// ── 3. Diff ────────────────────────────────────────────────────────────
const missing = [];
const deadAllowlist = [];
for (const [name, info] of stateChangeEvents) {
  if (handled.has(name)) continue;
  if (name in DELIBERATELY_NOT_HANDLED) continue;
  missing.push({ name, ...info });
}
// Flag allowlist entries that no longer correspond to a real contract
// event (or that have since been handled) — keeps the allowlist honest.
for (const name of Object.keys(DELIBERATELY_NOT_HANDLED)) {
  if (!stateChangeEvents.has(name)) {
    deadAllowlist.push(`${name} (no such state-change/{loan,offer}-mutation event)`);
  } else if (handled.has(name)) {
    deadAllowlist.push(`${name} (now handled in chainIndexer.ts — remove from allowlist)`);
  }
}

// ── 4. Report ──────────────────────────────────────────────────────────
let failed = false;
if (missing.length) {
  failed = true;
  console.error('✗ state-change/{loan,offer}-mutation events with no chainIndexer.ts handler:\n');
  for (const m of missing) console.error(`    ${m.name}   [${m.category}]   ${m.file}`);
  console.error(
    '\n  Add a `log.eventName === \'<Name>\'` branch in apps/indexer/src/chainIndexer.ts,\n' +
      '  or add the event to DELIBERATELY_NOT_HANDLED in this script with a one-line reason.\n',
  );
}
if (deadAllowlist.length) {
  // Stale allowlist entries are a warning, not a hard failure — they
  // don't break correctness, but cleaning them up keeps signal high.
  console.warn('⚠ DELIBERATELY_NOT_HANDLED has stale entries:\n');
  for (const e of deadAllowlist) console.warn(`    ${e}`);
  console.warn('');
}
if (!failed) {
  console.log(
    `✓ event-coverage OK — ${stateChangeEvents.size} enforced state-change events ` +
      `(${[...stateChangeEvents].filter(([n]) => handled.has(n)).length} handled, ` +
      `${[...stateChangeEvents].filter(([n]) => n in DELIBERATELY_NOT_HANDLED).length} allowlisted).`,
  );
}
process.exit(failed ? 1 : 0);
