#!/usr/bin/env node
/**
 * Excision gate: the #687-A VPFI fixed-rate buy surface does not grow back.
 *
 * WHY THIS EXISTS. #687-A removed the protocol VPFI purchase surface
 * (`VpfiBuyAdapter` / `VpfiBuyReceiver`, the per-chain payment-token modes,
 * the `*_VPFI_BUY_PAYMENT_TOKEN` operator config) to reduce securities-law
 * exposure — a project risk decision, recorded in
 * `VPFISecuritiesFeatureExcision.md`, which is explicit that it is an
 * engineering/risk analysis and not legal advice. Do not restate it as a
 * settled regulatory classification. Deleting the contracts did not delete the
 * ~80 places that describe them, and #1651 has been retiring those in
 * batches. Each batch found residue the previous one missed, in a different
 * file class every time: a facet natspec citing the adapter as the enforcer
 * of a safety property (#1726), a partner security questionnaire (#1723),
 * runbook steps (#1719), a storage-struct header left labelling unrelated
 * slots.
 *
 * The failure mode is not "a stale mention". It is that a REMOVED surface
 * keeps being described as live, in operator-facing and legal-facing text,
 * long after the removal — and nothing in the toolchain notices, because
 * prose has no compiler.
 *
 * ── WHAT THIS GATE IS, AND IS NOT ─────────────────────────────────────────
 *
 * It is a RATCHET, not a cleaner. It does not judge whether any given
 * mention is good or bad; that requires reading, and much of the surviving
 * text is deliberate — retraction notes that name the removed thing in order
 * to say it is gone are exactly what #1651 has been ADDING. A gate that
 * banned the names outright would fight its own remediation.
 *
 * What it does instead: PIN the count per file. Every in-scope file's current
 * hit count is recorded below with a reason. A count that goes UP means new
 * text describing the removed surface — the thing this exists to stop. A
 * count that goes DOWN means cleanup happened and the ledger is now stale;
 * that also fails, with a different message, because a ledger nobody updates
 * stops being evidence of anything.
 *
 * This is the CLOSED-WORLD POSITIVE rule shape described in the admission
 * criterion at the top of `check-docs-paths.mjs`: a fixed list of known-dead
 * identifiers. A hit means the text really does name the removed surface,
 * whatever surrounds it. There is no extractor to over-fire.
 *
 * ── SCOPE, AND WHY IT IS NARROW ───────────────────────────────────────────
 *
 * Only surfaces where a mention is ACTIONABLE are in scope: live source,
 * deploy scripts, operator config, operator runbooks, user-facing copy, and
 * the functional specs.
 *
 * Historical narrative is deliberately OUT of scope — `docs/ReleaseNotes`,
 * `docs/OlderDocs`, `docs/FindingsAndFixes`, `docs/internal`, `docs/adr`,
 * `docs/DesignsAndPlans`. A release note for the excision SHOULD name what
 * was excised; the design record for it certainly should. Those directories
 * hold roughly fifty more files, and pinning them would generate constant
 * churn from documents whose whole job is to record that this surface once
 * existed. Scope is what makes the ratchet cheap enough to keep.
 *
 * ── WHEN THIS FAILS ───────────────────────────────────────────────────────
 *
 * Read the mention. If it describes the removed surface as live, fix the
 * text. If it is a deliberate retraction note, raise the pin and say so in
 * the reason. Do not silence the gate by widening the exclusions.
 *
 * Run:  node .github/scripts/check-excision-residue.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * Canonical forms of the removed surface's names.
 *
 * Matching is done on NORMALIZED text: lower-cased with every non-alphanumeric
 * character removed. That folds `VpfiBuyAdapter`, `VPFIBuyAdapter`,
 * `vpfi_buy_adapter` and the ordinary prose spelling `VPFI buy adapter` onto
 * one string, so a sentence written in English is caught by the same rule as
 * an identifier.
 *
 * This matters more than it looks. The first version of this gate matched
 * exact case-sensitive identifiers and reported GREEN while
 * `contracts/script/deploy-chain.sh` and `deploy-mainnet.sh` presented the
 * removed receiver and adapter as current deployment components — because
 * they spell them "buy receiver" and "buy adapter". A gate that only sees
 * code spellings does not cover prose, and prose is where this residue lives.
 *
 * Normalization also joins the whole file into one string before matching, so
 * a phrase broken across a line boundary is still found.
 *
 * The tokens are chosen NON-OVERLAPPING so nothing is double-counted:
 * `buyadapter` already covers every `vpfibuyadapter` spelling, so the longer
 * form is not listed separately.
 *
 * NOT included, on purpose:
 *   - `VPFIMirror*` / `*TokenPool` — the CCT mirror + pools SURVIVED #687-A.
 *   - `ConfigureVPFIBuy.s.sol` as a path — the file name contains "VPFIBuy"
 *     but the script is LIVE and configures surviving surfaces. Matching on
 *     file names rather than content would flag it every run. This trap cost
 *     a previous pass real time; it is recorded here so the next reader does
 *     not re-add it.
 */
const DEAD_TOKENS = [
  'buyadapter',
  'buyreceiver',
  'vpfibuypaymenttoken',
  'fixedratebuy',
  'fixedratevpfibuy',
];

/**
 * Scope is an EXCLUDE list, not an include list.
 *
 * The first version listed the directories to check, and that list omitted
 * `SECURITY.md` — which described the removed contracts as live CCIP
 * components — along with `contracts/RUNBOOK.md` and `contracts/.env.example`.
 * An include list cannot cover a file nobody thought of, and the whole point
 * of this gate is the residue nobody thought of. So: everything tracked is in
 * scope unless it is excluded here.
 *
 * Excluded because a mention there is CORRECT — these directories record that
 * the surface once existed, which is their job:
 */
const EXCLUDED_PREFIXES = [
  'docs/ReleaseNotes/',
  'docs/OlderDocs/',
  'docs/FindingsAndFixes/',
  'docs/internal/',
  'docs/adr/',
  'docs/DesignsAndPlans/',
  'docs/TestScopes/',
  // This file names every dead token by definition.
  '.github/scripts/check-excision-residue.mjs',
];

/**
 * The pinned ledger: path → [count, reason].
 *
 * Reasons are grouped by what the mentions ARE, because that determines what
 * a future reader should do when the count moves:
 *
 *   RETRACTION — text added by #1651 that names the removed surface in order
 *                to say it is gone. Growth here is usually fine and wants the
 *                pin raised; these are the notes doing the remediation.
 *   HISTORICAL — deployed-address tables and past-tense runbook records. The
 *                addresses were really deployed; the rows are audit history.
 *   LIVE-TEXT  — prose that still reads as current instruction. Growth here
 *                is the defect this gate exists to catch, and the existing
 *                count is a known debt, not an endorsement.
 */
const PINNED = new Map([
  ['.github/scripts/README.md', [2, 'TOOLING — documents this gate and quotes the dead names as examples', 'd588eb2c7422']],
  ['AGENTS.md', [1, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', '7825bf5193af']],
  ['CLAUDE.md', [13, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', '4a39a69e2277']],
  ['SECURITY.md', [7, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', 'c42da58d7825']],
  ['apps/agent/src/env.ts', [2, 'RETRACTION — the RPC-breadth note explaining #687-A removed the watchdog that justified it', '868dbce09b41']],
  ['apps/defi/src/App.tsx', [1, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', 'c2aea8bd1bcf']],
  ['apps/defi/src/contracts/config.ts', [3, 'RETRACTION — removed-key notes on the deployment config shape', '4c7b5e1d9366']],
  ['apps/defi/src/hooks/useAdminKnobValues.ts', [1, 'RETRACTION — notes the standalone receiver is gone and knobs moved', '80b0e1ecaed7']],
  ['apps/defi/src/hooks/useTimelockPendingChanges.ts', [1, 'RETRACTION — replaces a receiver-specific skip that no longer applies', '3f2b1b6b65cd']],
  ['apps/defi/src/i18n/glossary.ts', [2, 'HISTORICAL — do-not-translate entry retained for historical copy', '545f04e4a423']],
  ['apps/defi/src/pages/AdminDashboard.tsx', [1, 'RETRACTION — notes why the mirror-chain receiver knobs are gone', 'c94397138747']],
  ['apps/www/src/content/whitepaper/Whitepaper.en.md', [3, 'LIVE-TEXT — user-facing; verify against the §8 supersede banner before raising', 'd1c494871332']],
  ['apps/www/src/pages/BuyVPFIMarketing.tsx', [1, 'LIVE-TEXT — user-facing marketing surface; the most legally sensitive entry here', '9034cbd1f188']],
  ['contracts/.env.example', [3, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', 'd92377d85c3f']],
  ['contracts/RUNBOOK.md', [11, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', '6526182b0dea']],
  ['contracts/deployments/CCIP-INFRA-ADDRESSES.md', [4, 'HISTORICAL — deployed-address record', '674c5476fb96']],
  ['contracts/script/AnvilNewPositiveFlows.s.sol', [1, 'RETRACTION — removed-step note', 'd6a09efdf2ca']],
  ['contracts/script/ConfigureCcip.s.sol', [2, 'RETRACTION — removed-step note', 'c0646d6289e6']],
  ['contracts/script/DeployCrosschain.s.sol', [6, 'RETRACTION — removed-deploy-target notes', 'b42ff8c2a025']],
  ['contracts/script/DeployDiamond.s.sol', [2, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', '9668ed19eba3']],
  ['contracts/script/Handover.s.sol', [2, 'RETRACTION — removed-ownership-target note', '7188d4e02d35']],
  ['contracts/script/deploy-chain.sh', [5, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', 'ebd7e8525faa']],
  ['contracts/script/deploy-mainnet.sh', [3, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', '32275aa421c9']],
  ['contracts/script/deploy-testnet.sh', [5, 'RETRACTION — removed-step note', 'b3bbbfa54a8e']],
  ['contracts/script/lint-event-categories.js', [2, 'RETRACTION — removed-event note', '386057d069ca']],
  ['contracts/script/predeploy-check.sh', [2, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', '97db6a29fae6']],
  ['contracts/src/crosschain/CcipMessenger.sol', [1, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', '17272e1b9ad1']],
  ['contracts/src/crosschain/GuardianPausable.sol', [1, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', 'd2f739a14a85']],
  ['contracts/src/crosschain/ICrossChainMessenger.sol', [1, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', 'e77036a0d17b']],
  ['contracts/src/facets/OracleAdminFacet.sol', [2, 'RETRACTION — #1726 corrected the natspec that cited the adapter as a safety enforcer', 'b5553aea2002']],
  ['contracts/src/interfaces/IVaipakamErrors.sol', [2, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', 'fee92f336c1b']],
  ['contracts/src/libraries/LibVaipakam.sol', [2, 'RETRACTION — replaces the dangling storage-struct header that labelled sequencer slots', '84c75fa30e3b']],
  ['contracts/test/CcipDeploymentRehearsalTest.t.sol', [1, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', '9b88888ba872']],
  ['contracts/test/mocks/MockCrossChainMessenger.sol', [1, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', '72f36faac8af']],
  ['docs/FunctionalSpecs/ProjectDetailsREADME.md', [2, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', 'dc02dfec22ed']],
  ['docs/FunctionalSpecs/README.md', [1, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', 'fb93eccde799']],
  ['docs/FunctionalSpecs/TokenomicsTechSpec.md', [2, 'RETRACTION — the §8 supersede banner', '39d4cceaf50f']],
  ['docs/GLOSSARY.md', [5, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', '7a21ca8444bb']],
  ['docs/ToDo.md', [15, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', 'ea9b55788d85']],
  ['docs/ops/AnalyticsLabelRegistration.md', [3, 'HISTORICAL — label registry rows', '710066eac702']],
  ['docs/ops/BNBTestnetDeploy.md', [23, 'LIVE-TEXT — known debt; largest unswept operator runbook after DeploymentRunbook', 'bdd3879f581b']],
  ['docs/ops/BaseSepoliaDeploy.md', [19, 'LIVE-TEXT — known debt', '21d2af0e20bf']],
  ['docs/ops/CcipCutoverRunbook.md', [6, 'RETRACTION — #1719 swept the dead steps and left the notes', '40e5673b2dd2']],
  ['docs/ops/ChainByChainChecks.md', [5, 'LIVE-TEXT — known debt', '439a645acc2e']],
  ['docs/ops/DeploymentRunbook.md', [42, 'LIVE-TEXT — known debt; §"VPFIBuyAdapter — payment-token mode" still carries an actionable pre-flight checklist under a Historical banner', '9c40aa535012']],
  ['docs/ops/IncidentRunbook.md', [4, 'HISTORICAL — past-incident record', '561efd9c6bc7']],
  ['docs/ops/VPFITokenRotationRunbook.md', [2, 'HISTORICAL — rotation-scope note', 'dce68e17a3ea']],
  ['docs/ops/tenderly-paste/Diamond-full.json', [13, 'HISTORICAL — a captured ABI artifact; regenerate rather than hand-edit', '89a0e02af3d7']],
  ['ops/offchain-data-warm/wrangler.jsonc', [1, 'RETRACTION — notes the excised surface in a coverage comment', '71235bd8ead9']],
  ['ops/subgraph/abis/Diamond.json', [8, 'UNTRIAGED — admitted by the #1727 widened scope (prose forms + whole-tree); classify on first movement', '8b6af5bbd7b5']],
  ['packages/contracts/src/abis/index.ts', [2, 'RETRACTION — removed-ABI notes in the barrel', 'ff908534d89e']],
  ['packages/contracts/src/chain-config.ts', [2, 'RETRACTION — removed-key note', '54bfc8375dcc']],
  ['packages/contracts/src/deployments.ts', [1, 'RETRACTION — removed-key note on the typed loader', '8677731f9a0e']],
]);

/** Tracked files, from git — the whole tree, minus EXCLUDED_PREFIXES. */
function inScopeFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((f) => !EXCLUDED_PREFIXES.some((p) => f === p || f.startsWith(p)));
}

/** Lower-case, strip every non-alphanumeric. See DEAD_TOKENS. */
function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Scan one file: how many mentions, and a digest identifying WHICH mentions.
 *
 * The digest exists because a bare count is defeated by an offsetting edit —
 * remove one pinned mention, add a new one elsewhere in the same file, and the
 * total is unchanged. That is not a hypothetical: it is the shape of this
 * project's own remediation (replace stale prose with a retraction note), so
 * a live instruction could ride in under cover of a cleanup in the same diff.
 *
 * Each match contributes a window of surrounding normalized text; the windows
 * are sorted and hashed. Moving a mention within a file is invisible (same
 * text, same window), but replacing one with different words is not.
 */
function scanFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { hits: 0, digest: '' };
  }
  if (text.indexOf(String.fromCharCode(0)) !== -1) return { hits: 0, digest: '' }; // binary
  const norm = normalize(text);
  const windows = [];
  for (const token of DEAD_TOKENS) {
    let from = 0;
    for (;;) {
      const at = norm.indexOf(token, from);
      if (at === -1) break;
      windows.push(norm.slice(Math.max(0, at - 40), at + token.length + 40));
      from = at + token.length;
    }
  }
  windows.sort();
  const digest = windows.length
    ? createHash('sha256').update(windows.join('|')).digest('hex').slice(0, 12)
    : '';
  return { hits: windows.length, digest };
}

const grew = [];
const shrank = [];
const changed = [];
const appeared = [];
const vanished = [];

const seen = new Set();
for (const file of inScopeFiles()) {
  const { hits, digest } = scanFile(file);
  if (hits === 0) continue;
  seen.add(file);
  const pin = PINNED.get(file);
  if (!pin) {
    appeared.push({ file, hits });
    continue;
  }
  const [pinnedHits, reason, pinnedDigest] = pin;
  if (hits > pinnedHits) grew.push({ file, hits, pinned: pinnedHits, reason });
  else if (hits < pinnedHits) shrank.push({ file, hits, pinned: pinnedHits, reason });
  else if (pinnedDigest && pinnedDigest !== digest)
    changed.push({ file, hits, reason, was: pinnedDigest, now: digest });
}
for (const [file, [pinned]] of PINNED) {
  if (!seen.has(file)) vanished.push({ file, pinned });
}

const fail =
  grew.length || appeared.length || shrank.length || vanished.length || changed.length;

if (!fail) {
  const total = [...PINNED.values()].reduce((s, [n]) => s + n, 0);
  console.log(
    `check-excision-residue: OK — ${PINNED.size} in-scope files, ${total} pinned mentions, none changed.`,
  );
  process.exit(0);
}

console.error('check-excision-residue: FAILED\n');

if (appeared.length) {
  console.error('NEW FILE describes the removed #687-A VPFI buy surface:');
  for (const { file, hits } of appeared) console.error(`  ${file}  (${hits} mention(s))`);
  console.error(
    '\n  Read each mention. If it describes the surface as live, remove it —\n' +
      '  there is no protocol VPFI purchase surface. If it is a deliberate\n' +
      "  retraction note, add the file to PINNED with a reason.\n",
  );
}

if (grew.length) {
  console.error('MORE mentions than pinned:');
  for (const g of grew) {
    console.error(`  ${g.file}  ${g.pinned} → ${g.hits}`);
    console.error(`      pinned as: ${g.reason}`);
  }
  console.error(
    '\n  This is the case the gate exists for. New text describing a surface\n' +
      '  removed to limit legal exposure is a defect unless it is a retraction note.\n' +
      '  If it is one, raise the pin and say so in the reason.\n',
  );
}

if (shrank.length) {
  console.error('FEWER mentions than pinned (cleanup happened — lower the pin):');
  for (const s of shrank) console.error(`  ${s.file}  ${s.pinned} → ${s.hits}`);
  console.error('');
}

if (vanished.length) {
  console.error('PINNED file has no mentions left, or no longer exists (drop its entry):');
  for (const v of vanished) console.error(`  ${v.file}  (pinned ${v.pinned})`);
  console.error('');
}

if (changed.length) {
  console.error('SAME count, DIFFERENT mentions (an offsetting edit):');
  for (const c of changed) console.error(`  ${c.file}  digest ${c.was} → ${c.now}`);
  console.error(
    '\n  One mention was removed and another added in the same file, so the\n' +
      '  total did not move. Read the new one. If it is a retraction note,\n' +
      '  update this file\u2019s digest in PINNED; if it describes the removed\n' +
      '  surface as live, fix the text.\n',
  );
}

console.error('Context: docs/DesignsAndPlans/VPFISecuritiesFeatureExcision.md, issue #1651.');
process.exit(1);
