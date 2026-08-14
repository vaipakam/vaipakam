#!/usr/bin/env node
/**
 * Excision gate: the #687-A VPFI fixed-rate buy surface does not grow back.
 *
 * WHY THIS EXISTS. #687-A removed the protocol VPFI purchase surface
 * (`VpfiBuyAdapter` / `VpfiBuyReceiver`, the per-chain payment-token modes,
 * the `*_VPFI_BUY_PAYMENT_TOKEN` operator config) for LEGAL reasons — it was
 * the securities-shaped surface. Deleting the contracts did not delete the
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

/**
 * Identifiers of the removed surface. Closed-world: every entry names a
 * thing #687-A deleted, so a hit is never about nothing.
 *
 * NOT included, on purpose:
 *   - `VPFIMirror*` / `*TokenPool` — the CCT mirror + pools SURVIVED #687-A.
 *   - `ConfigureVPFIBuy.s.sol` as a path — the file name contains "VPFIBuy"
 *     but the script is LIVE and configures surviving surfaces. Matching on
 *     file names rather than content would flag it every run. This trap cost
 *     a previous pass real time; it is recorded here so the next reader does
 *     not re-add it.
 */
const DEAD_IDENTIFIERS = [
  'VpfiBuyAdapter',
  'VpfiBuyReceiver',
  'VPFIBuyAdapter',
  'VPFIBuyReceiver',
  'vpfiBuyAdapter',
  'vpfiBuyReceiver',
  'vpfiBuyPaymentToken',
  'VPFI_BUY_PAYMENT_TOKEN',
  'fixed-rate buy',
  'fixed rate buy',
];

/**
 * Directories where a mention is actionable. Pathspecs, passed to
 * `git ls-files`, so the file set is the TRACKED tree — never a stale
 * hand-written list, and never an untracked scratch file.
 */
const IN_SCOPE = [
  'contracts/src/*',
  'contracts/script/*',
  'contracts/deployments/*',
  'packages/contracts/src/*',
  'apps/*',
  'ops/*',
  'docs/ops/*',
  'docs/FunctionalSpecs/*',
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
  ['apps/agent/src/env.ts', [2, 'RETRACTION — the RPC-breadth note explaining #687-A removed the watchdog that justified it']],
  ['apps/defi/src/contracts/config.ts', [2, 'RETRACTION — removed-key notes on the deployment config shape']],
  ['apps/defi/src/hooks/useAdminKnobValues.ts', [1, 'RETRACTION — notes the standalone receiver is gone and knobs moved']],
  ['apps/defi/src/hooks/useTimelockPendingChanges.ts', [1, 'RETRACTION — replaces a receiver-specific skip that no longer applies']],
  ['apps/defi/src/i18n/glossary.ts', [2, 'HISTORICAL — do-not-translate entry retained for historical copy']],
  ['apps/defi/src/pages/AdminDashboard.tsx', [1, 'RETRACTION — notes why the mirror-chain receiver knobs are gone']],
  ['apps/www/src/content/whitepaper/Whitepaper.en.md', [1, 'LIVE-TEXT — user-facing; verify against the §8 supersede banner before raising']],
  ['apps/www/src/pages/BuyVPFIMarketing.tsx', [1, 'LIVE-TEXT — user-facing marketing surface; the most legally sensitive entry here']],
  ['contracts/deployments/CCIP-INFRA-ADDRESSES.md', [3, 'HISTORICAL — deployed-address record']],
  ['contracts/script/AnvilNewPositiveFlows.s.sol', [1, 'RETRACTION — removed-step note']],
  ['contracts/script/ConfigureCcip.s.sol', [2, 'RETRACTION — removed-step note']],
  ['contracts/script/DeployCrosschain.s.sol', [6, 'RETRACTION — removed-deploy-target notes']],
  ['contracts/script/Handover.s.sol', [2, 'RETRACTION — removed-ownership-target note']],
  ['contracts/script/deploy-testnet.sh', [1, 'RETRACTION — removed-step note']],
  ['contracts/script/lint-event-categories.js', [2, 'RETRACTION — removed-event note']],
  ['contracts/src/facets/OracleAdminFacet.sol', [2, 'RETRACTION — #1726 corrected the natspec that cited the adapter as a safety enforcer']],
  ['contracts/src/libraries/LibVaipakam.sol', [1, 'RETRACTION — replaces the dangling storage-struct header that labelled sequencer slots']],
  ['docs/FunctionalSpecs/TokenomicsTechSpec.md', [1, 'RETRACTION — the §8 supersede banner']],
  ['docs/ops/AnalyticsLabelRegistration.md', [3, 'HISTORICAL — label registry rows']],
  ['docs/ops/BNBTestnetDeploy.md', [16, 'LIVE-TEXT — known debt; largest unswept operator runbook after DeploymentRunbook']],
  ['docs/ops/BaseSepoliaDeploy.md', [6, 'LIVE-TEXT — known debt']],
  ['docs/ops/CcipCutoverRunbook.md', [6, 'RETRACTION — #1719 swept the dead steps and left the notes']],
  ['docs/ops/ChainByChainChecks.md', [2, 'LIVE-TEXT — known debt']],
  ['docs/ops/DeploymentRunbook.md', [32, 'LIVE-TEXT — known debt; §"VPFIBuyAdapter — payment-token mode" still carries an actionable pre-flight checklist under a Historical banner']],
  ['docs/ops/IncidentRunbook.md', [4, 'HISTORICAL — past-incident record']],
  ['docs/ops/VPFITokenRotationRunbook.md', [1, 'HISTORICAL — rotation-scope note']],
  ['docs/ops/tenderly-paste/Diamond-full.json', [3, 'HISTORICAL — a captured ABI artifact; regenerate rather than hand-edit']],
  ['ops/offchain-data-warm/wrangler.jsonc', [1, 'RETRACTION — notes the excised surface in a coverage comment']],
  ['packages/contracts/src/abis/index.ts', [2, 'RETRACTION — removed-ABI notes in the barrel']],
  ['packages/contracts/src/chain-config.ts', [2, 'RETRACTION — removed-key note']],
  ['packages/contracts/src/deployments.ts', [1, 'RETRACTION — removed-key note on the typed loader']],
]);

/** Tracked in-scope files, from git — never a hand-maintained list. */
function inScopeFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...IN_SCOPE], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

/**
 * Count dead-identifier occurrences in a file.
 *
 * Counts OCCURRENCES, not matching lines: two mentions on one line are two
 * hits. Line-counting would let a mention be added to an already-matching
 * line without moving the number — the same line-granularity blind spot that
 * let a line-broken phrase survive a sweep on #1720.
 */
function countHits(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return 0; // unreadable (binary/deleted) — not our concern
  }
  let n = 0;
  for (const id of DEAD_IDENTIFIERS) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(id, from);
      if (at === -1) break;
      n++;
      from = at + id.length;
    }
  }
  return n;
}

const grew = [];
const shrank = [];
const appeared = [];
const vanished = [];

const seen = new Set();
for (const file of inScopeFiles()) {
  const hits = countHits(file);
  if (hits === 0) continue;
  seen.add(file);
  const pin = PINNED.get(file);
  if (!pin) {
    appeared.push({ file, hits });
  } else if (hits > pin[0]) {
    grew.push({ file, hits, pinned: pin[0], reason: pin[1] });
  } else if (hits < pin[0]) {
    shrank.push({ file, hits, pinned: pin[0], reason: pin[1] });
  }
}
for (const [file, [pinned]] of PINNED) {
  if (!seen.has(file)) vanished.push({ file, pinned });
}

const fail = grew.length || appeared.length || shrank.length || vanished.length;

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
      '  removed for legal reasons is a defect unless it is a retraction note.\n' +
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

console.error('Context: docs/DesignsAndPlans/VPFISecuritiesFeatureExcision.md, issue #1651.');
process.exit(1);
