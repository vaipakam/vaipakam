#!/usr/bin/env node
/**
 * Sanctions frozen-claimant REGISTER-COVERAGE guardrail (#1132, S10 central
 * enforcement — the KEYSTONE of docs/DesignsAndPlans/S10CentralEnforcement.md).
 *
 * S10 requires: value returning to a sanctioned position holder must be
 * FAIL-CLOSED. The mechanism is a per-loan frozen-claimant marker recorded at
 * every close-out that creates a DEFERRED payout (a `{lender,borrower,
 * borrowerSurplus}Claims[…]` row, or a non-terminal `heldForLender[…] +=`
 * credit), keyed to the CURRENT position-NFT holder. If a close-out writes such
 * a row but forgets the marker, a flagged holder can withdraw fail-open during
 * an oracle outage — exactly the whack-a-mole class the #1122 review kept
 * finding on a different path every round.
 *
 * This script makes the invariant STRUCTURAL. It scans every production Solidity
 * file (every `.sol` under `contracts/src`, libraries included) and FAILS (exit 1) if any
 * function writes a deferred claim / held credit WITHOUT a SIDE-MATCHED register
 * co-located in the SAME function — unless that write is recognizably a
 * zero/claimed artifact row, or the function is in the reasoned allowlist below.
 *
 * A register is any of (design §2 Keystone):
 *   - the both-holder host   `terminalize` / `terminalizeFromAny`
 *     (on EncumbranceMutateFacet) or `recordSanctionsFrozenClaimantBoth`
 *   - a lender-lane register  `freezeLenderProceeds`, `parkLenderPayoffAndFreeze`,
 *     `freezeOrPayActiveLender{Resident,FromPayer,FromVault}`, or a
 *     `recordFrozenClaimant*` / `recordSanctionsFrozenClaimant` /
 *     `_recordFrozenClaimant` call whose side arg is `true`
 *   - a borrower-lane register `freezeOrPayBorrowerSurplus` or such a call whose
 *     side arg is `false`
 *
 * Side-match rule:
 *   - a `lenderClaims` write or `heldForLender +=`  needs the LENDER lane
 *   - a `borrowerClaims` / `borrowerSurplusClaims` write needs the BORROWER lane
 *   A both-holder host covers either lane.
 *
 * Two scans (design §2):
 *   - Invariant A (#1132): every DEFERRED-CLAIM / HELD write is co-located with a
 *     side-matched frozen-claimant register.
 *   - Invariant B (#1144): every INLINE holder payout — a function that resolves
 *     `ownerOf(*TokenId)` and pays that holder raw (directly or by threading the
 *     resolved value into a private paying helper) — routes through the
 *     fail-closed freeze helpers or carries a freeze/sync guard, NOT a bare
 *     fail-open `_assertNotSanctioned`. See the Invariant-B block below.
 *   The runtime `syncPrepaySaleListing/Offer` counterpart to Invariant B (the
 *   Seaport consideration channel) lives in the contracts, not this scanner.
 *
 * Run: `node contracts/script/check-sanctions-register-coverage.mjs`
 * Wired into `contracts/script/predeploy-check.sh` and CI (`ci.yml`).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CONTRACTS_SRC = join(__dirname, '..', 'src');

/**
 * Functions that write a claim/held row but legitimately carry NO live-NFT
 * deferred payout (a zero/claimed artifact row, or a side whose position NFT is
 * already burned in the same flow), so the register rule does not apply. Each
 * entry is `File.sol::functionName` → one-line reason. Keep this list SMALL —
 * it is for genuine exceptions, not for punching a hole around a real payout.
 */
const ALLOWLIST = {
  'EarlyWithdrawalFacet.sol::_completeLoanSaleImpl':
    'temp-loan-sale close writes only ZERO / claimed:true artifact rows to avoid a stuck record; BOTH temp-loan position NFTs are burned first, so there is no live-NFT deferred payout to freeze (design §2 Invariant A, r5 R5-2)',
  'LibFacet.sol::depositForNewLender':
    'new-lender shortfall funding on the lender-SALE path; the incoming lender is sanctions-screened Tier-1 at sale entry (EarlyWithdrawalFacet), not a deferred close-out payout to a possibly-flagged holder',
  'LibFacet.sol::depositFromPayerForLender':
    'new-lender cross-payer funding on the lender-SALE path; same Tier-1-screened-at-entry rationale as depositForNewLender',
  'ClaimFacet.sol::_distributeRetryProceeds':
    'retry-swap distribution helper — writes both lanes but BOTH callers register both holders in the same tx: _claimViaBackstopImpl terminalizes FallbackPending→Defaulted immediately after this call, and _resolveFallbackIfActive is called by _claimAsLenderImpl which records both holders at its top (recordSanctionsFrozenClaimantBoth) + terminalizes',
  'RiskMatchLiquidationFacet.sol::_retainInternalMatchResidual':
    'internal-match over-collateralized residual helper — its only caller (_settleFallbackOrTransitionPostMatch Active-full branch) terminalizes Active→InternalMatched (registers both holders) BEFORE this borrowerClaims write in the same tx',
};

const CLAIM_LANES = ['lenderClaims', 'borrowerClaims', 'borrowerSurplusClaims'];
const HELD_LANE = 'heldForLender';

// A write statement to `.lane[...]` optionally with `.field`, then `=` (not `==`).
function claimWriteRe(lane) {
  return new RegExp(
    `\\.${lane}\\[[^\\]]*\\]\\s*(?:\\.\\s*(\\w+)\\s*)?=(?!=)([^;]*)`,
    'g',
  );
}
const HELD_WRITE_RE = new RegExp(`\\.${HELD_LANE}\\[[^\\]]*\\]\\s*\\+=`);

// Register tokens that cover BOTH lanes (prefix match handles terminalizeFromAny).
const BOTH_TOKENS = ['terminalize', 'recordSanctionsFrozenClaimantBoth'];
const LENDER_HELPERS = [
  'freezeLenderProceeds',
  'parkLenderPayoffAndFreeze',
  'freezeOrPayActiveLenderResident',
  'freezeOrPayActiveLenderFromPayer',
  'freezeOrPayActiveLenderFromVault',
];
const BORROWER_HELPERS = ['freezeOrPayBorrowerSurplus'];
// Side-parameterised registers — the boolean arg selects the lane.
const SIDED_REGISTERS = [
  'recordFrozenClaimantForLoan',
  'recordFrozenClaimant',
  '_recordFrozenClaimant',
];

/**
 * Strip block + line comments so register tokens / claim-writes mentioned in
 * PROSE (e.g. "route through the terminalize host") never satisfy the check.
 * Without this the guardrail is vacuous — a function whose real register call is
 * removed still "passes" on the leftover comment. (Good enough: Solidity string
 * literals rarely contain `//`, and mangling one can't create a false PASS here.)
 */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

/** Recursively list every `.sol` file under `dir`. */
function listSolFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listSolFiles(p));
    else if (entry.endsWith('.sol')) out.push(p);
  }
  return out;
}

/**
 * Split Solidity source into `{ name, body }` function records via brace-depth
 * matching from each `function <name>(` header. Good enough for this guardrail
 * (facets don't nest function declarations).
 */
function extractFunctions(src) {
  const fns = [];
  for (const m of src.matchAll(/function\s+(\w+)\s*\(/g)) {
    const name = m[1];
    let i = m.index + m[0].length;
    // walk past the parameter list (paren depth from the header's `(`)
    const paramStart = i;
    let paren = 1;
    while (i < src.length && paren > 0) {
      const c = src[i++];
      if (c === '(') paren++;
      else if (c === ')') paren--;
    }
    const params = parseParamNames(src.slice(paramStart, i - 1));
    // skip modifiers / returns to the body `{` (or `;` for a declaration)
    while (i < src.length && src[i] !== '{' && src[i] !== ';') i++;
    if (i >= src.length || src[i] === ';') continue; // no body
    let depth = 0;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) {
        i++;
        break;
      }
    }
    fns.push({ name, params, body: src.slice(start, i) });
  }
  return fns;
}

/**
 * Parameter NAMES from a header's parameter text — the last identifier of each
 * top-level, comma-separated declaration (`address nftOwner` → `nftOwner`,
 * `LibVaipakam.Loan storage loan` → `loan`, `uint256[] memory a` → `a`). Used by
 * the Invariant-B scan to map a caller's argument POSITION to the callee param a
 * resolved-holder value flows into.
 */
function parseParamNames(paramText) {
  return splitTopLevel(paramText)
    .map((p) => {
      const ids = p.trim().match(/\w+/g);
      return ids ? ids[ids.length - 1] : null;
    })
    .filter(Boolean);
}

/** Split a call's argument text on TOP-LEVEL commas (ignoring nested (), [], {}). */
function splitTopLevel(argStr) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of argStr) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * A REAL call / selector reference to `token` — `token(` or `token.selector`
 * (comments are already stripped). NOT a bare word or a leftover local so a
 * function that only references e.g. `terminalize.selector` after the call was
 * removed, or names a similar local, doesn't false-satisfy a lane (Codex #1141
 * P2). `\w*` after the token lets a prefix token match its suffixed sibling
 * (`terminalize` → `terminalizeFromAny`).
 */
function hasCall(body, token) {
  return new RegExp(`\\b${token}\\w*\\s*(?:\\(|\\.\\s*selector\\b)`).test(body);
}

/**
 * For a side-parameterised register token, OR the lanes of every call site.
 * ONLY a STANDALONE `true`/`false` argument selects a lane — a variable, a
 * ternary (`c ? true : false`), or any other expression is NOT counted, so the
 * scanner stays conservative rather than marking BOTH lanes covered off an
 * expression whose runtime side it can't know (Codex #1141 P2).
 */
function sidesFromSidedCall(body, token) {
  const sides = new Set();
  for (const m of body.matchAll(new RegExp(`\\b${token}\\s*\\(`, 'g'))) {
    let i = m.index + m[0].length;
    let depth = 1;
    const argStart = i;
    for (; i < body.length && depth > 0; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') depth--;
    }
    for (const arg of splitTopLevel(body.slice(argStart, i - 1))) {
      const a = arg.trim();
      if (a === 'true') sides.add('lender');
      else if (a === 'false') sides.add('borrower');
    }
  }
  return sides;
}

/**
 * The `.selector` crossFacetCall form of the single-sided host register —
 * `recordSanctionsFrozenClaimant.selector, loanId, <bool>` (the `Both` variant
 * is a distinct token handled by BOTH_TOKENS). Read the STANDALONE bool arg that
 * follows the selector inside the same `abi.encodeWithSelector(...)`.
 */
function sidesFromSelectorRegister(body) {
  const sides = new Set();
  for (const m of body.matchAll(/recordSanctionsFrozenClaimant\.\s*selector\s*,/g)) {
    // read the remaining args up to the matching close of the enclosing call
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    for (; i < body.length && depth > 0; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') depth--;
    }
    for (const arg of splitTopLevel(body.slice(start, i - 1))) {
      const a = arg.trim();
      if (a === 'true') sides.add('lender');
      else if (a === 'false') sides.add('borrower');
    }
  }
  return sides;
}

/** Which lanes are register-covered in this function body? */
function coveredLanes(body) {
  const covered = new Set();
  for (const t of BOTH_TOKENS) {
    if (hasCall(body, t)) {
      covered.add('lender');
      covered.add('borrower');
    }
  }
  for (const t of LENDER_HELPERS) if (hasCall(body, t)) covered.add('lender');
  for (const t of BORROWER_HELPERS) if (hasCall(body, t)) covered.add('borrower');
  for (const t of SIDED_REGISTERS) {
    for (const s of sidesFromSidedCall(body, t)) covered.add(s);
  }
  for (const s of sidesFromSelectorRegister(body)) covered.add(s);
  return covered;
}

/** A claim FIELD-write that is a zero/claimed artifact (exempt). */
function isZeroOrClaimedFieldWrite(field, rhs) {
  if (field === 'claimed') return true; // terminal consumption / artifact flag
  return /^\s*0\b/.test(rhs); // `.amount = 0`
}

/** A full-struct `ClaimInfo{…}` assignment that is an explicit artifact row. */
function structRhsIsArtifact(rhs) {
  // Scoped to THIS assignment's RHS (Codex #1141 P2) — a function-wide check let
  // a real `claimed: false` payout ride a sibling tombstone's exemption. Exempt
  // only an explicit `claimed: true` (a computed `claimed: x == 0` is NOT exempt).
  return /claimed:\s*true\b/.test(rhs);
}

// ===========================================================================
// Invariant B (#1144) — INLINE HOLDER-PAYOUT call-graph scan.
//
// The other half of docs/DesignsAndPlans/S10CentralEnforcement.md §2. Beyond the
// DEFERRED-claim writes above, S10 also requires that an INLINE "pay
// `ownerOf(positionTokenId)` now" payout be sanctions-aware: it must route
// through the fail-closed `LibCloseoutFreeze.freezeOrPayActiveLender*` /
// `freezeOrPayBorrowerSurplus` helpers (park-or-pay) or carry an
// `assertNotFrozenParty` / `mustFreezeParty` guard — NOT a bare fail-open
// `_assertNotSanctioned` (which returns false during an oracle outage, the exact
// gap Invariant B targets).
//
// The scan is a COARSE, false-positive-tolerant dataflow backstop (design §2
// Keystone bullet 2 — "a full taint analysis is the ideal; the call-graph ban is
// the practical check + a reasoned allowlist"). A function is FLAGGED when it
//   (1) resolves a position holder — binds a local from `ownerOf(…)` /
//       `_ownerOfRaw(…)` — AND
//   (2) pays that holder raw, either DIRECTLY (a `safeTransfer` /
//       `safeTransferFrom` / `vaultWithdrawERC20*` whose recipient arg is the
//       resolved local) OR by THREADING the local into a private helper that
//       does the raw payout (the ClaimFacet `_claimViaBackstopImpl` →
//       `_absorbLenderSlice` split the design names) — AND
//   (3) carries NO co-located freeze/guard token.
// Deliberate, reviewed raw-payout paths live in ALLOWLIST_B with a reason.
// ===========================================================================

/**
 * Functions that DO resolve `ownerOf` + pay it raw, but by conscious design
 * (a discretionary hard-block path, or a prepay-sale vehicle covered by the
 * committed non-reverting `syncPrepaySale*` sync). Each entry is
 * `File.sol::functionName` → reason. Keep SMALL — every entry is a hole.
 */
const ALLOWLIST_B = {
  'SwapToRepayFacet.sol::swapToRepayPartial':
    'DISCRETIONARY loan-stays-Active partial swap (the analogue of repayPartial): it hard-SCREENS the direct EOA payee at Tier-1 (_assertNotSanctioned) rather than freezing — a flagged party\'s must-complete escape hatch is swapToRepayFull, which freeze-routes. Design §1.3 / §2 Invariant B channel 1 discretionary path.',
  'PrepayListingFacet.sol::_settleLoanFromParallelSale':
    'accepted-offer parallel-sale settlement: the inline ownerOf(lenderTokenId) payout is a PREPAY-SALE vehicle covered by the committed non-reverting syncPrepaySaleOffer + fail-closed-fill backstop (design §2 Invariant B channel 1→2), NOT a bare freeze — a mustFreezeParty-revert inside the atomic fill would roll back its own registry marker (Codex #1136-r5 R5-1).',
  'PrecloseFacet.sol::transferObligationViaOffer':
    'returns the EXITING borrower\'s OWN collateral to them inline; discretionary holder-initiated obligation transfer, function-entry Tier-1 sanctions-screened on that exact holder (requireKeeperFor authority + an explicit _assertNotSanctioned at entry). The lender payoff on this path IS freeze-routed via parkLenderPayoffAndFreeze (#1132).',
};

// Owner-resolution SOURCES — bind the LHS local when the RHS resolves a
// position-NFT holder. Comparisons (`x == ownerOf`) can't match: the `[^;=]`
// class stops at the second `=`.
const OWNER_RESOLVE_RE = /\b(\w+)\s*=\s*[^;=]*?\b(?:ownerOf|_ownerOfRaw)\s*\(/g;

// Raw fund-payout SINKS. Two SafeERC20 calling conventions coexist and put the
// recipient in DIFFERENT argument slots:
//   member form  `IERC20(token).safeTransfer(to, amt)`            → to = arg0
//   library form `SafeERC20.safeTransfer(IERC20(token), to, amt)` → to = arg1
// (and the `…From` variants shift one further). Capture the optional `SafeERC20`
// receiver so the recipient index is read from the right slot.
const SAFE_TRANSFER_RE =
  /(\bSafeERC20\b)?\s*\.\s*(safeTransfer|safeTransferFrom)\s*\(/g;
const VAULT_WITHDRAW_SEL_RE =
  /\b(?:vaultWithdrawERC20|vaultWithdrawERC20MoveOut|recordVaultWithdrawERC20)\s*\.\s*selector\s*,/g;

// Tokens that make a resolved-holder payout FAIL-CLOSED (the park-or-pay helpers,
// the hard-block gate, and the locking-deposit variants). `hasCall`'s `\w*`
// prefix match means `depositLocked` covers `depositLockedFrom(Vault)`,
// `recordFrozenClaimant` covers `…ForLoan`, `freezeOrPayActiveLender` covers all
// three variants. `_assertNotSanctioned` is DELIBERATELY absent — it is fail-open.
const FREEZE_GUARD_TOKENS = [
  'mustFreezeParty',
  'assertNotFrozenParty',
  'depositLocked',
  'freezeLenderProceeds',
  'freezeOrPayBorrowerSurplus',
  'freezeOrPayActiveLender',
  'recordFrozenClaimant',
  'recordSanctionsFrozenClaimant',
];

function hasFreezeGuard(body) {
  return FREEZE_GUARD_TOKENS.some((t) => hasCall(body, t));
}

/** Read the balanced argument list starting just after an open `(` (or after a
 *  `.selector,` inside an `encodeWithSelector`, where paren depth is already 1). */
function readArgs(body, startIdx) {
  let i = startIdx;
  let depth = 1;
  for (; i < body.length && depth > 0; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') depth--;
  }
  return splitTopLevel(body.slice(startIdx, i - 1)).map((a) => a.trim());
}

/** The recipient-position argument of every raw sink in `body` (safeTransfer →
 *  arg0, safeTransferFrom → arg1, vaultWithdrawERC20 selector-form (owner, asset,
 *  to, amt) → the `to` = second-to-last arg). */
function rawSinkRecipients(body) {
  const recips = [];
  for (const m of body.matchAll(SAFE_TRANSFER_RE)) {
    const args = readArgs(body, m.index + m[0].length);
    const isLib = !!m[1]; // `SafeERC20.` prepends the token arg → shift +1
    const base = m[2] === 'safeTransfer' ? 0 : 1;
    const to = args[base + (isLib ? 1 : 0)];
    if (to != null) recips.push(to);
  }
  for (const m of body.matchAll(VAULT_WITHDRAW_SEL_RE)) {
    const args = readArgs(body, m.index + m[0].length); // (owner, asset, to, amt)
    if (args.length >= 2) recips.push(args[args.length - 2]);
  }
  return recips;
}

/** Map each local var to the ROOT param it aliases (seeded param→itself), so a
 *  sink recipient that is `nftOwner` OR a plain `x = nftOwner;` copy traces back
 *  to the param it flowed from. */
function provenanceRoots(body, params) {
  const root = new Map(params.map((p) => [p, p]));
  for (let pass = 0; pass < 3; pass++) {
    for (const m of body.matchAll(/\b(\w+)\s*=\s*([^;]+);/g)) {
      const rhs = m[2].trim();
      if (/^\w+$/.test(rhs) && root.has(rhs)) root.set(m[1], root.get(rhs));
    }
  }
  return root;
}

/** name → Set(param index) for every function whose raw sink pays one of its own
 *  parameters. Lets the main scan follow a holder threaded into such a helper. */
function buildPayingHelpers(allFns) {
  const map = {};
  for (const { name, params, body } of allFns) {
    if (!params.length) continue;
    const recips = rawSinkRecipients(body);
    if (!recips.length) continue;
    const root = provenanceRoots(body, params);
    for (const r of recips) {
      const paramRoot = root.get(r);
      const idx = paramRoot != null ? params.indexOf(paramRoot) : -1;
      if (idx >= 0) (map[name] ||= new Set()).add(idx);
    }
  }
  return map;
}

/** Local vars in `body` that hold a resolved position holder (from ownerOf, plus
 *  one-hop `x = holder;` aliases). */
function collectHolderVars(body) {
  const holders = new Set();
  for (const m of body.matchAll(OWNER_RESOLVE_RE)) holders.add(m[1]);
  if (!holders.size) return holders;
  for (let pass = 0; pass < 3; pass++) {
    for (const m of body.matchAll(/\b(\w+)\s*=\s*([^;]+);/g)) {
      const rhs = m[2].trim();
      if (/^\w+$/.test(rhs) && holders.has(rhs)) holders.add(m[1]);
    }
  }
  return holders;
}

/** Does `recipText` (a sink/arg expression) name a resolved holder, incl. a
 *  `payable(x)` / `address(x)` wrap? */
function recipientMatchesHolder(recipText, holders) {
  const t = recipText.trim();
  if (holders.has(t)) return true;
  const wrap = t.match(/^(?:payable|address)\s*\(\s*(\w+)\s*\)$/);
  return !!(wrap && holders.has(wrap[1]));
}

/** Function-scope Invariant-B predicate: resolves a holder AND pays it raw
 *  (directly, or by threading it into a known holder-paying helper). */
function paysResolvedHolder(body, payingHelpers) {
  const holders = collectHolderVars(body);
  if (!holders.size) return false;
  for (const r of rawSinkRecipients(body)) {
    if (recipientMatchesHolder(r, holders)) return true;
  }
  for (const [helper, idxs] of Object.entries(payingHelpers)) {
    for (const m of body.matchAll(new RegExp(`\\b${helper}\\s*\\(`, 'g'))) {
      const args = readArgs(body, m.index + m[0].length);
      for (const i of idxs) {
        if (args[i] != null && recipientMatchesHolder(args[i], holders)) return true;
      }
    }
  }
  return false;
}

const violations = [];
const violationsB = [];

// Parse every production `.sol` once (comments stripped). Invariant B needs the
// full file set — inline payouts live in files with no claim-lane surface too —
// and the paying-helper pre-pass indexes across ALL functions.
const parsed = listSolFiles(CONTRACTS_SRC).map((file) => {
  const src = stripComments(readFileSync(file, 'utf8'));
  return {
    rel: relative(REPO_ROOT, file),
    base: file.split('/').pop(),
    src,
    fns: extractFunctions(src),
  };
});

// Pre-pass: index every holder-paying helper so the Invariant-B scan can follow a
// resolved holder threaded into a private helper (the ClaimFacet
// `_claimViaBackstopImpl` → `_absorbLenderSlice` call-graph split).
const payingHelpers = buildPayingHelpers(parsed.flatMap((f) => f.fns));

for (const { rel, base, src, fns } of parsed) {
  const hasClaimSurface =
    CLAIM_LANES.some((l) => src.includes(l)) || src.includes(HELD_LANE);
  for (const { name, params, body } of fns) {
    // ---- Invariant B (#1144): inline holder-payout call-graph ----
    if (
      !ALLOWLIST_B[`${base}::${name}`] &&
      paysResolvedHolder(body, payingHelpers) &&
      !hasFreezeGuard(body)
    ) {
      violationsB.push(
        `${rel}  ::${name}  resolves ownerOf(*TokenId) and pays that holder raw ` +
          `(safeTransfer / vaultWithdrawERC20) outside a freeze/sync guard`,
      );
    }

    // ---- Invariant A: deferred-claim / held register coverage ----
    if (!hasClaimSurface || ALLOWLIST[`${base}::${name}`]) continue;
    const covered = coveredLanes(body);

    // Direct `s.{lane}[...]` writes.
    for (const lane of CLAIM_LANES) {
      const need = lane === 'lenderClaims' ? 'lender' : 'borrower';
      let sawRealWrite = false;
      for (const m of body.matchAll(claimWriteRe(lane))) {
        const field = m[1]; // undefined for a full-struct assignment
        const rhs = m[2] || '';
        if (field) {
          if (isZeroOrClaimedFieldWrite(field, rhs)) continue;
        } else {
          if (structRhsIsArtifact(rhs)) continue;
        }
        sawRealWrite = true;
      }
      if (sawRealWrite && !covered.has(need)) {
        violations.push(
          `${rel}  ::${name}  writes ${lane} but has no co-located ${need}-lane register`,
        );
      }
    }

    // Aliased claim-row writes (Codex #1141 P2) — a `ClaimInfo storage x =
    // s.{lane}[id];` binding followed by `x.field = …`. The direct-write regex
    // above can't see these, so track the alias → lane and check its field
    // writes the same way. (A read `x.field` has no `=` and is ignored.)
    for (const am of body.matchAll(
      /\bstorage\s+(\w+)\s*=\s*[^;]*?\.(lenderClaims|borrowerClaims|borrowerSurplusClaims)\[/g,
    )) {
      const aliasVar = am[1];
      const lane = am[2];
      const need = lane === 'lenderClaims' ? 'lender' : 'borrower';
      if (covered.has(need)) continue;
      const writeRe = new RegExp(`\\b${aliasVar}\\s*\\.\\s*(\\w+)\\s*=(?!=)([^;]*)`, 'g');
      for (const wm of body.matchAll(writeRe)) {
        if (isZeroOrClaimedFieldWrite(wm[1], wm[2] || '')) continue;
        violations.push(
          `${rel}  ::${name}  writes ${lane} via alias '${aliasVar}' but has no co-located ${need}-lane register`,
        );
        break;
      }
    }

    if (HELD_WRITE_RE.test(body) && !covered.has('lender')) {
      violations.push(
        `${rel}  ::${name}  does heldForLender += but has no co-located lender-lane register`,
      );
    }
  }
}

// Dead-allowlist check: flag an entry (in either allowlist) whose file is gone.
const allFiles = listSolFiles(CONTRACTS_SRC);
const deadAllow = [...Object.keys(ALLOWLIST), ...Object.keys(ALLOWLIST_B)].filter(
  (k) => !allFiles.some((f) => f.endsWith('/' + k.split('::')[0])),
);

if (violations.length > 0 || violationsB.length > 0 || deadAllow.length > 0) {
  console.error('\n✗ Sanctions register-coverage guardrail FAILED\n');
  if (violations.length) {
    console.error('  [Invariant A] Un-registered deferred-claim / held writes:');
    for (const v of violations) console.error('   • ' + v);
    console.error(
      '\n  Each write above must be co-located with a side-matched frozen-claimant\n' +
        '  register (route the transition through EncumbranceMutateFacet.terminalize[FromAny],\n' +
        '  or call the matching recordFrozenClaimant* / freeze* helper), OR — if it is a\n' +
        '  zero/claimed artifact row or a burned-side write — added to the ALLOWLIST with\n' +
        '  a one-line reason. See docs/DesignsAndPlans/S10CentralEnforcement.md §2.',
    );
  }
  if (violationsB.length) {
    console.error('\n  [Invariant B] Inline holder payouts outside a freeze/sync guard:');
    for (const v of violationsB) console.error('   • ' + v);
    console.error(
      '\n  Each function above resolves a position holder via ownerOf and pays it raw.\n' +
        '  Route the payout through LibCloseoutFreeze.freezeOrPayActiveLender* /\n' +
        '  freezeOrPayBorrowerSurplus (park-or-pay), or guard it with assertNotFrozenParty /\n' +
        '  mustFreezeParty, OR — if it is a deliberate discretionary hard-block or a\n' +
        '  prepay-sale vehicle covered by syncPrepaySale* — add it to ALLOWLIST_B with a\n' +
        '  one-line reason. See docs/DesignsAndPlans/S10CentralEnforcement.md §2 Invariant B.',
    );
  }
  if (deadAllow.length) {
    console.error('\n  Stale ALLOWLIST entries (file no longer present):');
    for (const k of deadAllow) console.error('   • ' + k);
  }
  console.error('');
  process.exit(1);
}

console.log(
  '✓ Sanctions register-coverage guardrail passed ' +
    '(deferred-claim/held writes register-covered; inline holder payouts freeze/sync-guarded)',
);
