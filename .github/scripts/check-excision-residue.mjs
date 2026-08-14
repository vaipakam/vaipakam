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
 * What it does instead: PIN two things per file — a COUNT of mentions and a
 * DIGEST identifying which ones. Both are recorded below with a reason. Three
 * ways they can move, three different failures:
 *
 *   - count UP     — new text describing the removed surface. The case this
 *                    exists to stop.
 *   - count DOWN   — cleanup happened and the ledger is now stale. Also fails,
 *                    because a ledger nobody updates stops being evidence.
 *   - count SAME,
 *     digest moved — one mention replaced by another. This one is not
 *                    hypothetical: replacing stale prose with a retraction
 *                    note is exactly how #1651 proceeds, so without the digest
 *                    a live instruction could ride in under cover of a
 *                    legitimate cleanup in the same diff.
 *
 * This is the CLOSED-WORLD POSITIVE rule shape described in the admission
 * criterion at the top of `check-docs-paths.mjs`: a fixed list of known-dead
 * names. A hit means the text really does name the removed surface, whatever
 * surrounds it. There is no extractor to over-fire. See DEAD_TOKENS for why
 * the list is matched against NORMALIZED text rather than as literal
 * identifiers — prose spellings are the majority of this residue, not an edge
 * case.
 *
 * ── SCOPE IS AN EXCLUDE LIST ──────────────────────────────────────────────
 *
 * Everything tracked is in scope except what EXCLUDED_PREFIXES names. Only
 * genuinely ARCHIVAL trees are excluded wholesale — release notes, older docs,
 * findings, ADRs — because every document in them is a dated record and naming
 * the removed surface is their job. Active trees are excluded FILE BY FILE:
 * `docs/internal/` and `docs/TestScopes/` were once excluded whole, which hid
 * a security questionnaire giving a third-party scanner present-tense
 * instructions for the removed adapter, and a test matrix listing it as current
 * coverage. Excluding a tree because part of it is historical hides the live
 * text in the rest.
 *
 * It is worth knowing what this replaced, because the earlier reasoning is
 * seductive and wrong. The first version listed the directories to CHECK —
 * live source, deploy scripts, operator config, runbooks, user-facing copy,
 * specs — on the theory that a narrow scope is what makes a ratchet cheap
 * enough to keep. What a narrow scope actually did was omit `SECURITY.md`,
 * which described the removed contracts as live components of the cross-chain
 * system, plus `contracts/RUNBOOK.md` and `contracts/.env.example`. An include
 * list can only cover the files someone thought of, and residue nobody thought
 * of is the entire category this gate exists for. Do not narrow it back.
 *
 * ── WHEN THIS FAILS ───────────────────────────────────────────────────────
 *
 * Read the mention. If it describes the removed surface as live, fix the
 * text. If it is a deliberate retraction note, update that file's count and
 * digest and say so in the reason. Do not silence the gate by widening the
 * exclusions.
 *
 * To re-pin after a deliberate change, run `--write-pins`: it rewrites the
 * ledger from the tree, keeping each entry's reason. The failure message also
 * prints the new count and digest for every file that moved, if you would
 * rather edit one entry by hand.
 *
 * Run:  node .github/scripts/check-excision-residue.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SELF = fileURLToPath(import.meta.url);

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
 * Entries are either a bare token string or `{ token, notFollowedBy }`. The
 * guard exists because a removed name can be a PREFIX of a surviving one —
 * `fixedratebuy` inside `fixedratebuyback` — and a gate that blocks every PR
 * must not fire on a live feature.
 *
 * Overlap between tokens is fine: `scanFile` deduplicates by INTERVAL
 * CONTAINMENT, so `bridgedbuyreceiver` and `buyreceiver` both appearing in the
 * list counts the same text once. Keying on the start offset alone was not
 * enough — the shorter token starts seven characters into the longer one — and
 * that undercount-by-design became a double-count in practice.
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
  // The removed contracts, by name or in prose.
  'buyadapter',
  'buyreceiver',
  'vpfibuypaymenttoken',
  // `fixedratebuy` is a PREFIX of `fixedratebuyback`, and treasury buyback is a
  // SURVIVING feature (`contracts/src/libraries/LibTreasuryBuyback.sol`). Left
  // unguarded, the sentence "a fixed-rate buyback auction for treasury intents"
  // failed this blocking every-PR gate as excision residue — a false positive
  // that would have blocked legitimate work on a live feature. When choosing
  // broad tokens I reasoned that over-matching was "unlikely in this repo";
  // that was wrong, and this is the counter-example.
  { token: 'fixedratebuy', notFollowedBy: ['back'] },
  // Same guard, same reason: `fixedratevpfibuy` is equally a prefix of
  // `fixedratevpfibuyback`. Guarding one of an adjacent pair and not the
  // other is how the first fix for this left the bug in place.
  { token: 'fixedratevpfibuy', notFollowedBy: ['back'] },
  // The removed SELECTORS, per VPFISecuritiesFeatureExcision.md:113-119.
  // Text can restore the dead API without naming a contract at all —
  // "call buyVPFIWithETH() before cutover" is exactly the operator
  // instruction this gate exists to stop, and the contract-name tokens
  // above do not see it.
  'buyvpfiwitheth',
  'processbridgedbuy',
  'getvpfisoldto',
  'vpfibuyrate',
  'vpfibuycaps',
  'vpfibuyenabled',
  'vpfibuyconfig',
  'computebuyanddebitcaps',
  // The adapter's removed RECOVERY selector — `contracts/RUNBOOK.md:392-394`
  // records that neither it nor its contract exists.
  'reclaimtimedoutbuy',
  // The removed INTERFACE, TEST and MESSAGE names (spec :111-112, :148).
  // Prose can name the deleted flow through these without ever mentioning a
  // contract or a selector — and one is not merely prose: `foundry.toml:271`
  // still lists `test/VpfiBuyFlowTest.t.sol`, a file the excision deleted, so
  // the build config references something that is not there.
  'ivpfibuyccipmessages',
  'vpfibuyflowtest',
  'buyrequest',
  'buysuccess',
  // The removed OFF-CHAIN WATCHDOG and NOTIFICATION CHANNEL (spec :99-100,
  // :138-139). Operator guidance can say "schedule runBuyWatchdog" or "wire
  // VPFI_BUY_CHANNEL" without naming any contract or selector.
  'runbuywatchdog',
  'buywatchdog',
  'vpfibuychannel',
  // The removed STORAGE keys (spec :116, :126-128) — counters, caps, the
  // enable flag and the per-chain sold-to mapping. Stale guidance could tell
  // someone to restore the deleted sale STATE without naming its API.
  'vpfifixedratesoldto',
  'soldtobychainid',
  'vpfibuyglobalcap',
  'vpfibuyperwalletcap',
  'vpfibuytotalsold',
  'bridgedbuyreceiver',
  // NOT listed, being substrings of tokens above and so double-counted:
  // `quoteFixedRateBuy` (→ fixedratebuy), `set/getBridgedBuyReceiver`
  // (→ buyreceiver, which `bridgedbuyreceiver` also contains — see the
  // dedupe in `scanFile`).
  //
  // NOT listed, because the spec KEEPS them: `vpfiFixedRateWeiPerVpfi`
  // (:129-130 — the retained discount quoting reads it) and
  // `getVPFIDiscountConfig` / `setVPFIDiscountRate` (:124-125).
];

/** Normalize the token table into {token, notFollowedBy} records. */
const DEAD_TOKEN_RECORDS = DEAD_TOKENS.map((t) =>
  typeof t === 'string' ? { token: t, notFollowedBy: [] } : t,
);

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
  // ARCHIVAL TREES — every document in them is a dated record of what was
  // true when it was written. Naming the removed surface is their job.
  'docs/ReleaseNotes/',
  'docs/OlderDocs/',
  'docs/FindingsAndFixes/',
  'docs/adr/',
  // NAMED FILES ONLY, inside trees that are otherwise ACTIVE.
  //
  // `docs/internal/` and `docs/TestScopes/` were excluded wholesale and that
  // was wrong: `SecurityScanQuestionnaire.md` gives a third-party security
  // scanner present-tense payment-token instructions for the removed adapter,
  // and `AdvancedUserGuideTestMatrix.md` lists it as current test coverage.
  // Excluding a whole tree because SOME of it is historical hides the live
  // text in the rest — partner-facing and QA-facing, which is worse than the
  // residue this gate started with. `docs/DesignsAndPlans/` went the same way;
  // only the excision record itself is exempt, because a design record for a
  // removal must name what it removed.
  'docs/DesignsAndPlans/VPFISecuritiesFeatureExcision.md',
  // This file names every dead token by definition.
  '.github/scripts/check-excision-residue.mjs',
];

/**
 * The pinned ledger: path → [count, reason, digest].
 *
 * `digest` is the first 12 hex of a sha256 over this file's sorted normalized
 * match contexts — see `scanFile`. It is what catches an equal-count
 * substitution.
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
  [".github/scripts/README.md", [2, "TOOLING — documents this gate and quotes the dead names as examples", "f9575479dca8"]],
  ["AGENTS.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "76758155965d"]],
  ["CLAUDE.md", [13, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "d7163e1020a3"]],
  ["SECURITY.md", [7, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "341316371b03"]],
  ["apps/agent/README.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "5e84d4c67881"]],
  ["apps/agent/src/env.ts", [5, "RETRACTION — the RPC-breadth note explaining #687-A removed the watchdog that justified it", "506ac2098d49"]],
  ["apps/agent/src/index.ts", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "4345c697dee6"]],
  ["apps/agent/wrangler.jsonc", [3, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "fba267868a99"]],
  ["apps/defi/src/App.tsx", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "c4ebe234788b"]],
  ["apps/defi/src/contracts/config.ts", [3, "RETRACTION — removed-key notes on the deployment config shape", "1802851dc6bc"]],
  ["apps/defi/src/hooks/useAdminKnobValues.ts", [1, "RETRACTION — notes the standalone receiver is gone and knobs moved", "426f05fa3ca9"]],
  ["apps/defi/src/hooks/useTimelockPendingChanges.ts", [1, "RETRACTION — replaces a receiver-specific skip that no longer applies", "12ff6d8b623f"]],
  ["apps/defi/src/i18n/glossary.ts", [2, "HISTORICAL — do-not-translate entry retained for historical copy", "7f8daa30207b"]],
  ["apps/defi/src/pages/AdminDashboard.tsx", [1, "RETRACTION — notes why the mirror-chain receiver knobs are gone", "512e6c5717b9"]],
  ["apps/www/src/content/whitepaper/Whitepaper.en.md", [4, "LIVE-TEXT — user-facing; verify against the §8 supersede banner before raising", "710c0ab438f2"]],
  ["apps/www/src/pages/BuyVPFIMarketing.tsx", [1, "LIVE-TEXT — user-facing marketing surface; the most legally sensitive entry here", "2e3d73493eac"]],
  ["contracts/.env.example", [3, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "53463f12de27"]],
  ["contracts/.gas-snapshot", [16, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "cf70ddc30844"]],
  ["contracts/RUNBOOK.md", [17, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "1cf1aa207bf7"]],
  ["contracts/deployments/CCIP-INFRA-ADDRESSES.md", [4, "HISTORICAL — deployed-address record", "e77aee67be9f"]],
  ["contracts/foundry.toml", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "83250658d3a6"]],
  ["contracts/script/AnvilNewPositiveFlows.s.sol", [1, "RETRACTION — removed-step note", "1a5646554f18"]],
  ["contracts/script/ConfigureCcip.s.sol", [3, "RETRACTION — removed-step note", "1dc3b180263a"]],
  ["contracts/script/DeployCrosschain.s.sol", [6, "RETRACTION — removed-deploy-target notes", "f632cffe066e"]],
  ["contracts/script/DeployDiamond.s.sol", [9, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "26cce521e03e"]],
  ["contracts/script/Handover.s.sol", [2, "RETRACTION — removed-ownership-target note", "aec5893311c1"]],
  ["contracts/script/SetInteractionLaunch.s.sol", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "51c50e93ff2f"]],
  ["contracts/script/deploy-chain.sh", [5, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "40e1ee49e313"]],
  ["contracts/script/deploy-mainnet.sh", [5, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "8c6f959815c8"]],
  ["contracts/script/deploy-testnet.sh", [7, "RETRACTION — removed-step note", "024ed284cdea"]],
  ["contracts/script/lint-event-categories.js", [2, "RETRACTION — removed-event note", "04d5d5aaacec"]],
  ["contracts/script/predeploy-check.sh", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "0264cee0c3d8"]],
  ["contracts/src/crosschain/CcipMessenger.sol", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "4b121e87b66b"]],
  ["contracts/src/crosschain/GuardianPausable.sol", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "33422e3ec4aa"]],
  ["contracts/src/crosschain/ICrossChainMessenger.sol", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "f977552c1059"]],
  ["contracts/src/facets/OracleAdminFacet.sol", [2, "RETRACTION — #1726 corrected the natspec that cited the adapter as a safety enforcer", "c3582b84b0dd"]],
  ["contracts/src/facets/VPFIDiscountFacet.sol", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "09cdff31a14b"]],
  ["contracts/src/interfaces/IVaipakamErrors.sol", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "97b2dc4454a8"]],
  ["contracts/src/libraries/LibKeeperReward.sol", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "dcd02714ec8d"]],
  ["contracts/src/libraries/LibVaipakam.sol", [2, "RETRACTION — replaces the dangling storage-struct header that labelled sequencer slots", "cb044c197b6e"]],
  ["contracts/test/CcipDeploymentRehearsalTest.t.sol", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "674ac44df17a"]],
  ["contracts/test/mocks/MockCrossChainMessenger.sol", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "a9dcd28ffcfd"]],
  ["docs/DesignsAndPlans/BorrowerPlatformFeeResearch.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "d9ce3777fa68"]],
  ["docs/DesignsAndPlans/CloudflareStagingDeployPlan.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "7f87299ddcca"]],
  ["docs/DesignsAndPlans/CrossChainRewardSystem.md", [8, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "1631f7e888d8"]],
  ["docs/DesignsAndPlans/DecentralizedPlatformArchitecture.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "f1d97d1f5b58"]],
  ["docs/DesignsAndPlans/EventSourcingAudit.md", [5, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "d6a439fed207"]],
  ["docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md", [26, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "1ae4baa44e75"]],
  ["docs/DesignsAndPlans/OfferFillModesDesign.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "6d86b5281325"]],
  ["docs/DesignsAndPlans/OssificationRoadmap.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "b56aa60682b2"]],
  ["docs/DesignsAndPlans/Research-404-OssificationRoadmap.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "1498b52c6d00"]],
  ["docs/DesignsAndPlans/Stage3WorkerSplitPlan.md", [5, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "af43f9f0f3eb"]],
  ["docs/DesignsAndPlans/TreasuryBuyback.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "371e4df1bbf3"]],
  ["docs/DesignsAndPlans/VPFITokenomicsRedesignResearch.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "3da26451af8f"]],
  ["docs/FunctionalSpecs/ProjectDetailsREADME.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "65abf0b56228"]],
  ["docs/FunctionalSpecs/README.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "ea9dea92aa6b"]],
  ["docs/FunctionalSpecs/TokenomicsTechSpec.md", [2, "RETRACTION — the §8 supersede banner", "513c1075317f"]],
  ["docs/GLOSSARY.md", [6, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "d205132203ae"]],
  ["docs/TestScopes/AdvancedUserGuideTestMatrix.md", [3, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "6631b16451de"]],
  ["docs/ToDo.md", [28, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "38059c8f10da"]],
  ["docs/internal/ContractFollowupsFromRehearsal-2026-05-06.md", [10, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "8f2df1d93c18"]],
  ["docs/internal/DeployOnTestnet.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "f9ad1ffff9b3"]],
  ["docs/internal/Issue687A-FrontendExcisionScout.md", [16, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "fbeae2fbfb72"]],
  ["docs/internal/PendingTasks-2026-05-14.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "0a552e841982"]],
  ["docs/internal/RiskCommitteeSignOffQuestionnaire.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "27482fe157e0"]],
  ["docs/internal/SecurityScanQuestionnaire.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "221c8d80edab"]],
  ["docs/internal/WethChainSafetyAudit-2026-05-14.md", [16, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "9b4561c4f2d7"]],
  ["docs/internal/batch5-unsafe-typecast-triage.csv", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "043ce2c94f2c"]],
  ["docs/ops/AnalyticsLabelRegistration.md", [3, "HISTORICAL — label registry rows", "beefecb68bfb"]],
  ["docs/ops/BNBTestnetDeploy.md", [24, "LIVE-TEXT — known debt; largest unswept operator runbook after DeploymentRunbook", "991df1fdd878"]],
  ["docs/ops/BaseSepoliaDeploy.md", [27, "LIVE-TEXT — known debt", "9ba38b6eee27"]],
  ["docs/ops/CcipCutoverRunbook.md", [6, "RETRACTION — #1719 swept the dead steps and left the notes", "6c8c8cd8c0b0"]],
  ["docs/ops/ChainByChainChecks.md", [6, "LIVE-TEXT — known debt", "0e5b914741dc"]],
  ["docs/ops/DeploymentRunbook.md", [47, "LIVE-TEXT — known debt; §\"VPFIBuyAdapter — payment-token mode\" still carries an actionable pre-flight checklist under a Historical banner", "c7b9e2a0c414"]],
  ["docs/ops/IncidentRunbook.md", [4, "HISTORICAL — past-incident record", "9c433fcdab4b"]],
  ["docs/ops/VPFITokenRotationRunbook.md", [2, "HISTORICAL — rotation-scope note", "725d18cfbbef"]],
  ["docs/ops/tenderly-paste/Diamond-full.json", [25, "HISTORICAL — a captured ABI artifact; regenerate rather than hand-edit", "17cac180920f"]],
  ["ops/offchain-data-warm/wrangler.jsonc", [1, "RETRACTION — notes the excised surface in a coverage comment", "3a079192595e"]],
  ["ops/subgraph/abis/Diamond.json", [12, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "25d9f51c0d9e"]],
  ["packages/contracts/src/abis/index.ts", [2, "RETRACTION — removed-ABI notes in the barrel", "7d43c4b59dec"]],
  ["packages/contracts/src/chain-config.ts", [2, "RETRACTION — removed-key note", "c50a1fe36831"]],
  ["packages/contracts/src/deployments.ts", [1, "RETRACTION — removed-key note on the typed loader", "6d6a473b0675"]],
]);

/**
 * Directory entries (trailing `/`) match by PREFIX; file entries match by
 * EXACT EQUALITY.
 *
 * `startsWith` was applied to both, which quietly exempted any sibling whose
 * name merely begins with an exempt filename — a tracked
 * `VPFISecuritiesFeatureExcision.md-followup.md` would have been outside the
 * ratchet entirely, contradicting the comment two lines above its own
 * exclusion. A file exemption should exempt that file and nothing else.
 */
function isExcluded(file) {
  return EXCLUDED_PREFIXES.some((p) =>
    p.endsWith('/') ? file.startsWith(p) : file === p,
  );
}

/**
 * Repository root, resolved once.
 *
 * Everything is anchored to it, because `git ls-files` reports paths relative
 * to the CURRENT DIRECTORY while the ledger keys are repo-root-relative. Run
 * from anywhere but the root, every path mismatched — and it failed in both
 * directions at once: a wall of bogus "NEW FILE" lines for the subtree it ran
 * in, plus a "no mentions left" line for every one of the 77 real entries.
 * Worse, `--write-pins` from a subdirectory would have written that mangled
 * view back as the ledger — dropping most of the tree while reporting a
 * successful re-pin. Anchoring removes the class.
 */
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

/** Tracked files, from git — the whole tree, minus EXCLUDED_PREFIXES. */
function inScopeFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((f) => !isExcluded(f));
}

/** Lower-case, strip every non-alphanumeric. See DEAD_TOKENS. */
function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Normalize, keeping a map back to source offsets.
 *
 * `map[i]` is the offset in the ORIGINAL text of the character that produced
 * normalized character `i` — what lets a match found in the collapsed string
 * be reported against the lines it actually came from.
 */
function normalizeWithMap(text) {
  const out = [];
  const map = [];
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i];
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      out.push(c);
      map.push(i);
    }
  }
  return { norm: out.join(''), map };
}

/** Byte offset → 0-based line index, via a prefix table built once per file. */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}
function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Lines of context each side of a mention that feed the digest.
 *
 * The digest's job is to notice when an existing mention is REWRITTEN — a
 * retraction turned back into live guidance. An earlier version hashed a fixed
 * 40 normalized characters either side of the token, which was too tight to do
 * that job: in `packages/contracts/src/deployments.ts`, flipping "were removed"
 * to "remain deployed" and "no longer exist" to "continue to exist" left both
 * count and digest unchanged, because the words carrying the meaning sat
 * outside the window. Character windows are the wrong unit — a mention's status
 * lives in its sentence, and in comment blocks that sentence is wrapped across
 * lines.
 *
 * Two lines either side covers the wrapped-comment case that defeated the
 * character window, without reaching so far that unrelated edits churn the
 * digest.
 */
const DIGEST_CONTEXT_LINES = 2;

/**
 * Scan one file: how many mentions, and a digest identifying WHICH mentions.
 *
 * The digest exists because a bare count is defeated by an offsetting edit —
 * remove one pinned mention, add another elsewhere in the same file, total
 * unchanged. Not hypothetical: that is the shape of this project's own
 * remediation, so a live instruction could ride in under cover of a cleanup in
 * the same diff.
 *
 * Each match contributes its containing line plus DIGEST_CONTEXT_LINES either
 * side, normalized; units are sorted then hashed, so moving a mention within a
 * file without changing its wording is invisible while rewording is not.
 */
function scanFile(path) {
  let text;
  try {
    // Resolved against REPO_ROOT, not the process CWD — `path` is a
    // repo-root-relative ledger key.
    text = readFileSync(join(REPO_ROOT, path), 'utf8');
  } catch {
    return { hits: 0, digest: '' };
  }

  // NO binary early-return. An earlier version bailed out on the first NUL
  // byte, which made a single NUL a COMPLETE bypass: a document with a live
  // deploy instruction plus one NUL was exempt from the gate entirely, and any
  // UTF-16 text file took that path naturally. Normalization discards NUL along
  // with every other non-alphanumeric byte, so scanning real binaries costs a
  // little time and finds nothing — the right trade against a silent hole.

  const { norm, map } = normalizeWithMap(text);
  const starts = lineStarts(text);
  const lines = text.split('\n');

  /**
   * Were normalized positions a..b contiguous in the SOURCE text?
   *
   * Normalization deletes punctuation and whitespace, so adjacency in `norm`
   * says nothing about adjacency on the page. The `notFollowedBy` guard has to
   * know the difference: "fixed-rate buyback" is one word and must be skipped,
   * while "the fixed-rate buy. Back up configuration first." is a real mention
   * followed by a new sentence and must NOT be. Both normalize to a tail of
   * `back`, and the first version of the guard skipped both — turning a
   * false-positive fix into a false negative.
   */
  const contiguous = (a, b) => map[b] - map[a] === b - a;

  // Matches as half-open normalized intervals, so overlaps can be resolved.
  const matches = [];

  for (const { token, notFollowedBy } of DEAD_TOKEN_RECORDS) {
    let from = 0;
    for (;;) {
      const at = norm.indexOf(token, from);
      if (at === -1) break;
      const end = at + token.length;
      from = end;
      const skip = notFollowedBy.some(
        (suffix) =>
          norm.startsWith(suffix, end) &&
          // Contiguity is checked across the JOIN only — from the token's last
          // character through the suffix's last — never across the whole token.
          // The token itself is usually punctuated ("fixed-rate VPFI buy"), so
          // requiring contiguity from its start made the guard never fire and
          // the false positive survived its own fix.
          contiguous(end - 1, end + suffix.length - 1),
      );
      if (skip) continue;
      matches.push({ start: at, end });
    }
  }

  // Deduplicate by INTERVAL CONTAINMENT, not by start offset. Keying on start
  // was not enough: in `bridgedbuyreceiver` the long token starts at one offset
  // and `buyreceiver` starts seven characters later, so a single occurrence was
  // counted twice — and rewriting it as the prose "buy receiver" then read as a
  // count DECREASE, sending the maintainer the "cleanup happened" message for
  // what was actually a like-for-like edit.
  const kept = matches.filter(
    (m) => !matches.some((o) => o !== m && o.start <= m.start && o.end >= m.end && o.end - o.start > m.end - m.start),
  );

  const units = kept
    .map(({ start, end }) => {
      const first = Math.max(0, lineOf(starts, map[start]) - DIGEST_CONTEXT_LINES);
      const last = Math.min(
        lines.length - 1,
        lineOf(starts, map[end - 1]) + DIGEST_CONTEXT_LINES,
      );
      return normalize(lines.slice(first, last + 1).join(' '));
    })
    .sort();

  const digest = units.length
    ? createHash('sha256').update(units.join('|')).digest('hex').slice(0, 12)
    : '';
  return { hits: units.length, digest };
}

/**
 * Every ledger entry must carry a digest.
 *
 * Comparison used to be guarded by `pinnedDigest && ...`, which silently read a
 * missing third element as "this file opts out of digest checking" — so an
 * entry copied from the pre-digest two-element format would disable the
 * protection for that file with nothing to show for it. A ledger invariant that
 * can be switched off by omission is not an invariant.
 */
const malformed = [...PINNED.entries()].filter(
  ([, v]) => !Array.isArray(v) || v.length !== 3 || typeof v[2] !== 'string' || !v[2],
);
if (malformed.length) {
  console.error('check-excision-residue: FAILED — malformed PINNED entries\n');
  for (const [file] of malformed) {
    console.error(`  ${file}  — needs [count, reason, digest]; digest missing or empty`);
  }
  console.error('\nFix, then re-run with --write-pins to regenerate the ledger.');
  process.exit(1);
}

/**
 * `--write-pins` rewrites the PINNED ledger in this file from the current tree,
 * preserving each existing entry's reason.
 *
 * It lives HERE rather than in a helper because a second copy of the scan logic
 * is a second thing to drift. The first version of this ledger was generated by
 * an outside script that counted matching LINES while the gate counted
 * OCCURRENCES; they disagreed on twelve of twenty-nine files, and only running
 * the gate caught it. One implementation, one answer.
 *
 * Review the diff before committing — this rewrites pins, it does not judge
 * them, and a reason still reading UNTRIAGED is one nobody has read. The
 * standing backlog of those is #1728; add to it rather than letting the marker
 * become permanent furniture.
 */
if (process.argv.includes('--write-pins')) {
  const rows = [];
  for (const file of inScopeFiles()) {
    const { hits, digest } = scanFile(file);
    if (hits) rows.push([file, hits, digest]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const UNTRIAGED =
    'UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement';
  // Serialize with JSON.stringify, NOT hand-rolled quoting.
  //
  // This writes JavaScript source into this very file, so getting the escaping
  // wrong corrupts the gate itself. An earlier version emitted
  // `'${reason.replace(/'/g, "\\'")}'`, which CodeQL flagged (alert 1913): it
  // escaped apostrophes but not BACKSLASHES, so a reason ending in one would
  // escape its own closing quote and produce a file that either fails to parse
  // or silently swallows the next entry. Paths and digests were not escaped at
  // all. JSON.stringify emits a valid JS string literal for any input —
  // backslashes, quotes and control characters included. It uses double quotes
  // where the rest of this file uses single; correctness wins.
  const body = rows
    .map(([f, n, d]) => {
      const reason = (PINNED.get(f) || [])[1] || UNTRIAGED;
      return `  [${JSON.stringify(f)}, [${n}, ${JSON.stringify(reason)}, ${JSON.stringify(d)}]],`;
    })
    .join('\n');
  const self = readFileSync(SELF, 'utf8');
  const replacement = `const PINNED = new Map([\n${body}\n]);`;
  writeFileSync(
    SELF,
    // Function replacer, so `$&` / `$'` / `$1` inside a reason are inserted
    // literally instead of being expanded as replacement patterns — the same
    // class of bug as the escaping above, one layer out.
    self.replace(/const PINNED = new Map\(\[[\s\S]*?\n\]\);/, () => replacement),
  );
  console.log(
    `check-excision-residue: wrote ${rows.length} pins ` +
      `(${rows.reduce((a, r) => a + r[1], 0)} mentions). Review the diff.`,
  );
  process.exit(0);
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
    appeared.push({ file, hits, digest });
    continue;
  }
  const [pinnedHits, reason, pinnedDigest] = pin;
  if (hits > pinnedHits) grew.push({ file, hits, pinned: pinnedHits, reason, digest });
  else if (hits < pinnedHits)
    shrank.push({ file, hits, pinned: pinnedHits, reason, digest });
  else if (pinnedDigest !== digest)
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
  for (const a of appeared)
    console.error(`  ${a.file}  (${a.hits} mention(s))   digest ${a.digest}`);
  console.error(
    '\n  Read each mention. If it describes the surface as live, remove it —\n' +
      '  there is no protocol VPFI purchase surface. If it is a deliberate\n' +
      "  retraction note, add the file to PINNED with a reason.\n",
  );
}

if (grew.length) {
  console.error('MORE mentions than pinned:');
  for (const g of grew) {
    console.error(`  ${g.file}  ${g.pinned} → ${g.hits}   digest now ${g.digest}`);
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
  for (const s of shrank)
    console.error(`  ${s.file}  ${s.pinned} → ${s.hits}   digest now ${s.digest}`);
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
