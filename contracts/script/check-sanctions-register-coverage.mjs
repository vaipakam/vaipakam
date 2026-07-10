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
 * Scope note (#1132 Invariant A): this run covers the DEFERRED-CLAIM / HELD half
 * of the design's guardrail. The inline-holder-payout (Invariant B) call-graph
 * scan + the Seaport prepay-sale sync are tracked as the #1132-B follow-up.
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
    let paren = 1;
    while (i < src.length && paren > 0) {
      const c = src[i++];
      if (c === '(') paren++;
      else if (c === ')') paren--;
    }
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
    fns.push({ name, body: src.slice(start, i) });
  }
  return fns;
}

/** For a side-parameterised register token, OR the lanes of every call site. */
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
    const args = body.slice(argStart, i - 1);
    if (/\btrue\b/.test(args)) sides.add('lender');
    if (/\bfalse\b/.test(args)) sides.add('borrower');
  }
  return sides;
}

/** Which lanes are register-covered in this function body? */
function coveredLanes(body) {
  const covered = new Set();
  for (const t of BOTH_TOKENS) {
    if (new RegExp(`\\b${t}`).test(body)) {
      covered.add('lender');
      covered.add('borrower');
    }
  }
  for (const t of LENDER_HELPERS) if (body.includes(t)) covered.add('lender');
  for (const t of BORROWER_HELPERS) if (body.includes(t)) covered.add('borrower');
  for (const t of SIDED_REGISTERS) {
    for (const s of sidesFromSidedCall(body, t)) covered.add(s);
  }
  // The `.selector` crossFacetCall form of the single-sided host register —
  // `recordSanctionsFrozenClaimant.selector, loanId, <bool>` (the `Both` variant
  // is a distinct token handled by BOTH_TOKENS). Read the side arg that follows.
  for (const m of body.matchAll(
    /recordSanctionsFrozenClaimant\.selector\s*,[^;]*?\b(true|false)\b/g,
  )) {
    covered.add(m[1] === 'true' ? 'lender' : 'borrower');
  }
  return covered;
}

/** A claim FIELD-write that is a zero/claimed artifact (exempt). */
function isZeroOrClaimedFieldWrite(field, rhs) {
  if (field === 'claimed') return true; // terminal consumption / artifact flag
  return /^\s*0\b/.test(rhs); // `.amount = 0`
}

/** A full-struct assignment that is an explicit `claimed: true` artifact row. */
function structIsArtifact(body, lane) {
  return new RegExp(
    `\\.${lane}\\[[^\\]]*\\]\\s*=\\s*[^;]*claimed:\\s*true`,
    's',
  ).test(body);
}

const violations = [];

for (const file of listSolFiles(CONTRACTS_SRC)) {
  const src = stripComments(readFileSync(file, 'utf8'));
  if (!CLAIM_LANES.some((l) => src.includes(l)) && !src.includes(HELD_LANE)) continue;
  const rel = relative(REPO_ROOT, file);
  const base = file.split('/').pop();
  for (const { name, body } of extractFunctions(src)) {
    if (ALLOWLIST[`${base}::${name}`]) continue;
    const covered = coveredLanes(body);

    for (const lane of CLAIM_LANES) {
      const need = lane === 'lenderClaims' ? 'lender' : 'borrower';
      let sawRealWrite = false;
      for (const m of body.matchAll(claimWriteRe(lane))) {
        const field = m[1]; // undefined for a full-struct assignment
        const rhs = m[2] || '';
        if (field) {
          if (isZeroOrClaimedFieldWrite(field, rhs)) continue;
          sawRealWrite = true;
        } else {
          if (structIsArtifact(body, lane)) continue;
          sawRealWrite = true;
        }
      }
      if (sawRealWrite && !covered.has(need)) {
        violations.push(
          `${rel}  ::${name}  writes ${lane} but has no co-located ${need}-lane register`,
        );
      }
    }

    if (HELD_WRITE_RE.test(body) && !covered.has('lender')) {
      violations.push(
        `${rel}  ::${name}  does heldForLender += but has no co-located lender-lane register`,
      );
    }
  }
}

// Dead-allowlist check: flag an entry whose file no longer exists.
const allFiles = listSolFiles(CONTRACTS_SRC);
const deadAllow = Object.keys(ALLOWLIST).filter(
  (k) => !allFiles.some((f) => f.endsWith('/' + k.split('::')[0])),
);

if (violations.length > 0 || deadAllow.length > 0) {
  console.error('\n✗ Sanctions register-coverage guardrail FAILED\n');
  if (violations.length) {
    console.error('  Un-registered deferred-claim / held writes:');
    for (const v of violations) console.error('   • ' + v);
    console.error(
      '\n  Each write above must be co-located with a side-matched frozen-claimant\n' +
        '  register (route the transition through EncumbranceMutateFacet.terminalize[FromAny],\n' +
        '  or call the matching recordFrozenClaimant* / freeze* helper), OR — if it is a\n' +
        '  zero/claimed artifact row or a burned-side write — added to the ALLOWLIST with\n' +
        '  a one-line reason. See docs/DesignsAndPlans/S10CentralEnforcement.md §2.',
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
  '✓ Sanctions register-coverage guardrail passed (every deferred-claim / held write is register-covered)',
);
