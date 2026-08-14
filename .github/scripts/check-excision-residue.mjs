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
  // The removed CUSTOM ERRORS. Three of the six are already covered by
  // containment (`BridgedBuyReceiverNotSet` / `NotBridgedBuyReceiver` →
  // buyreceiver; `VPFIBuyRateNotSet` → vpfibuyrate); these three are not.
  // `VPFIInvalidOriginChainId` is the one whose name contains neither "buy"
  // nor "soldto", which is exactly why an earlier search for it missed it and
  // why it still survives in IVaipakamErrors.sol — see #1728.
  'vpfiinvalidoriginchainid',
  'vpfibuyamounttoosmall',
  'vpfibuydisabled',
  // The retired CONFIG knob and EVENTS. RUNBOOK.md:116-119 records
  // VPFI_BUY_REFUND_TIMEOUT as dead; EventSourcingAudit.md:276,389-390 names
  // the retired events. None is declared in current source, so guidance to set
  // the knob or subscribe to the events would restore the removed flow without
  // naming a contract, selector or error.
  'vpfibuyrefundtimeout',
  'bridgedbuyprocessed',
  'buytimedoutrefunded',
  'buyoptionsset',
  'buyresolvedsuccess',
  'buyrefunded',
  // Retired errors still present in the captured historical ABI
  // (docs/ops/tenderly-paste/Diamond-full.json), none declared in current
  // source.
  'bridgedbuyfailed',
  'bridgedbuyrescued',
  'buyalreadyresolved',
  'buyexceedsdailycap',
  'buyexceedsperrequestcap',
  'pendingbuynotfound',
  // Retired ABI operations/events; migration 0024_purge-retired-vpfi-events
  // names VPFIPurchasedWithETH as removed in #687-A.
  'vpfipurchasedwitheth',
  'pendingbuys',
  'quotebuy',
  'setbuyoptions',
  // The removed INTERFACE, TEST and MESSAGE names (spec :111-112, :148).
  // Prose can name the deleted flow through these without ever mentioning a
  // contract or a selector — and one is not merely prose: `foundry.toml:271`
  // still lists `test/VpfiBuyFlowTest.t.sol`, a file the excision deleted, so
  // the build config references something that is not there.
  'ivpfibuyccipmessages',
  'vpfibuyflowtest',
  // These two are GENERIC ENGLISH BIGRAMS, unlike every other token here, so
  // they are the only ones ordinary prose can synthesize. `identifierOnly`
  // requires the match to be one word — separated at most by `_` or `-` — so
  // `BUY_REQUEST`, `buy-request` and `buyRequest` match while "whether to
  // buy. Request advice", a paragraph break, a heading, or a table cell do not.
  //
  // This REPLACED a growing set of block-boundary rules (sentence enders, blank
  // lines, table pipes, markdown list markers). Each round found another
  // boundary those rules mishandled — a fenced code block where a real mention
  // was silenced, an ATX heading mid-paragraph where prose was blocked — because
  // they were heuristics about where an English thought ends. Constraining the
  // two tokens that need it removes the whole class instead of extending it.
  { token: 'buyrequest', identifierOnly: true },
  { token: 'buysuccess', identifierOnly: true },
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
  typeof t === 'string'
    ? { token: t, notFollowedBy: [], identifierOnly: false }
    : { notFollowedBy: [], identifierOnly: false, ...t },
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
  [".github/scripts/README.md", [2, "TOOLING — documents this gate and quotes the dead names as examples", "232b194b311b"]],
  ["AGENTS.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "b2f6b2e30107"]],
  ["CLAUDE.md", [13, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "d0da136506e3"]],
  ["SECURITY.md", [7, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "46d05ee57880"]],
  ["apps/agent/README.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "fa4fea12281e"]],
  ["apps/agent/src/env.ts", [5, "RETRACTION — the RPC-breadth note explaining #687-A removed the watchdog that justified it", "1049f8e7e767"]],
  ["apps/agent/src/index.ts", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "6a223939d69a"]],
  ["apps/agent/wrangler.jsonc", [3, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "812857e2173f"]],
  ["apps/defi/src/App.tsx", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "3f5467bb4249"]],
  ["apps/defi/src/contracts/config.ts", [3, "RETRACTION — removed-key notes on the deployment config shape", "1dcad9f37ae5"]],
  ["apps/defi/src/hooks/useAdminKnobValues.ts", [1, "RETRACTION — notes the standalone receiver is gone and knobs moved", "2cd2b170df15"]],
  ["apps/defi/src/hooks/useTimelockPendingChanges.ts", [1, "RETRACTION — replaces a receiver-specific skip that no longer applies", "30bfbff0319c"]],
  ["apps/defi/src/i18n/glossary.ts", [2, "HISTORICAL — do-not-translate entry retained for historical copy", "76419633dbab"]],
  ["apps/defi/src/lib/logIndex.ts", [3, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "d87a64264bc0"]],
  ["apps/defi/src/pages/AdminDashboard.tsx", [1, "RETRACTION — notes why the mirror-chain receiver knobs are gone", "570e1d63fc33"]],
  ["apps/indexer/migrations/0024_purge_retired_vpfi_events.sql", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "5f866b8a9a60"]],
  ["apps/www/src/content/whitepaper/Whitepaper.en.md", [3, "LIVE-TEXT — user-facing; verify against the §8 supersede banner before raising", "3af0fcd63739"]],
  ["apps/www/src/pages/BuyVPFIMarketing.tsx", [1, "LIVE-TEXT — user-facing marketing surface; the most legally sensitive entry here", "e4bab2aafa5c"]],
  ["contracts/.env.example", [3, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "830e6452fde1"]],
  ["contracts/.gas-snapshot", [17, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "8ed1ed41f91a"]],
  ["contracts/RUNBOOK.md", [18, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "968b066e3406"]],
  ["contracts/deployments/CCIP-INFRA-ADDRESSES.md", [4, "HISTORICAL — deployed-address record", "d05158e7ef0e"]],
  ["contracts/foundry.toml", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "6f81ed69763b"]],
  ["contracts/script/AnvilNewPositiveFlows.s.sol", [1, "RETRACTION — removed-step note", "e626f5dc0b3e"]],
  ["contracts/script/ConfigureCcip.s.sol", [3, "RETRACTION — removed-step note", "23b71775ea85"]],
  ["contracts/script/DeployCrosschain.s.sol", [6, "RETRACTION — removed-deploy-target notes", "8de460c38985"]],
  ["contracts/script/DeployDiamond.s.sol", [8, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "cc0cb682879f"]],
  ["contracts/script/Handover.s.sol", [2, "RETRACTION — removed-ownership-target note", "56871089b115"]],
  ["contracts/script/SetInteractionLaunch.s.sol", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "5aafc0bbce55"]],
  ["contracts/script/deploy-chain.sh", [5, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "72402d99e561"]],
  ["contracts/script/deploy-mainnet.sh", [5, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "ff7807bd97bc"]],
  ["contracts/script/deploy-testnet.sh", [6, "RETRACTION — removed-step note", "c7b61926c90d"]],
  ["contracts/script/lint-event-categories.js", [2, "RETRACTION — removed-event note", "e9e1395bfd07"]],
  ["contracts/script/predeploy-check.sh", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "fc99314f3d67"]],
  ["contracts/src/crosschain/CcipMessenger.sol", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "b6f09624d717"]],
  ["contracts/src/crosschain/GuardianPausable.sol", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "f66cbe5ac7cb"]],
  ["contracts/src/crosschain/ICrossChainMessenger.sol", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "a46326867b90"]],
  ["contracts/src/facets/OracleAdminFacet.sol", [2, "RETRACTION — #1726 corrected the natspec that cited the adapter as a safety enforcer", "3b4d67cb1753"]],
  ["contracts/src/facets/VPFIDiscountFacet.sol", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "94bb823f9655"]],
  ["contracts/src/interfaces/IVaipakamErrors.sol", [3, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "40ae2bef4313"]],
  ["contracts/src/libraries/LibKeeperReward.sol", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "433c1b3e61d7"]],
  ["contracts/src/libraries/LibVaipakam.sol", [2, "RETRACTION — replaces the dangling storage-struct header that labelled sequencer slots", "e210f535dde7"]],
  ["contracts/test/CcipDeploymentRehearsalTest.t.sol", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "747e7c5e7c86"]],
  ["contracts/test/mocks/MockCrossChainMessenger.sol", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "b5fb38f4374d"]],
  ["docs/DesignsAndPlans/BorrowerPlatformFeeResearch.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "43cd48ebc718"]],
  ["docs/DesignsAndPlans/CloudflareStagingDeployPlan.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "da070633f84f"]],
  ["docs/DesignsAndPlans/CrossChainRewardSystem.md", [8, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "c83f9372ca91"]],
  ["docs/DesignsAndPlans/DecentralizedPlatformArchitecture.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "169c4ce146a2"]],
  ["docs/DesignsAndPlans/EventSourcingAudit.md", [14, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "ab4e65c08472"]],
  ["docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md", [31, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "e86953d8d19f"]],
  ["docs/DesignsAndPlans/OfferFillModesDesign.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "eeab8694d981"]],
  ["docs/DesignsAndPlans/OssificationRoadmap.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "b40ea1fd52b7"]],
  ["docs/DesignsAndPlans/Research-404-OssificationRoadmap.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "5ff5000c02d8"]],
  ["docs/DesignsAndPlans/Stage3WorkerSplitPlan.md", [5, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "189cac2e4f9d"]],
  ["docs/DesignsAndPlans/TreasuryBuyback.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "f63d3e54daac"]],
  ["docs/DesignsAndPlans/VPFITokenomicsRedesignResearch.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "7ac36e3f5b3e"]],
  ["docs/FunctionalSpecs/ProjectDetailsREADME.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "a91cedc236ef"]],
  ["docs/FunctionalSpecs/README.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "6150782dd9b8"]],
  ["docs/FunctionalSpecs/TokenomicsTechSpec.md", [2, "RETRACTION — the §8 supersede banner", "3751e7aa744a"]],
  ["docs/GLOSSARY.md", [6, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "9b4e8ec98ce6"]],
  ["docs/TestScopes/AdvancedUserGuideTestMatrix.md", [3, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "92c3dfed32ec"]],
  ["docs/ToDo.md", [31, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "b09855ced8db"]],
  ["docs/internal/ContractFollowupsFromRehearsal-2026-05-06.md", [10, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "1693b2322bfa"]],
  ["docs/internal/DeployOnTestnet.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "d0314d1c88c5"]],
  ["docs/internal/Issue687A-FrontendExcisionScout.md", [16, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "f6482f66b3e4"]],
  ["docs/internal/PendingTasks-2026-05-14.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "cf229a942c16"]],
  ["docs/internal/RiskCommitteeSignOffQuestionnaire.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "d703643224dc"]],
  ["docs/internal/SecurityScanQuestionnaire.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "5fad22ca5f4b"]],
  ["docs/internal/WethChainSafetyAudit-2026-05-14.md", [16, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "1c8fb1ea66dc"]],
  ["docs/internal/batch5-unsafe-typecast-triage.csv", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "56475d6e7aa7"]],
  ["docs/ops/AnalyticsLabelRegistration.md", [3, "HISTORICAL — label registry rows", "c79a0f5d509b"]],
  ["docs/ops/BNBTestnetDeploy.md", [24, "LIVE-TEXT — known debt; largest unswept operator runbook after DeploymentRunbook", "0e318eb4c650"]],
  ["docs/ops/BaseSepoliaDeploy.md", [26, "LIVE-TEXT — known debt", "c657f885e48f"]],
  ["docs/ops/CcipCutoverRunbook.md", [6, "RETRACTION — #1719 swept the dead steps and left the notes", "71f856c2c04b"]],
  ["docs/ops/ChainByChainChecks.md", [6, "LIVE-TEXT — known debt", "4f51827bdd85"]],
  ["docs/ops/DeploymentRunbook.md", [47, "LIVE-TEXT — known debt; §\"VPFIBuyAdapter — payment-token mode\" still carries an actionable pre-flight checklist under a Historical banner", "3a95991f2e38"]],
  ["docs/ops/IncidentRunbook.md", [4, "HISTORICAL — past-incident record", "98772e8c78b6"]],
  ["docs/ops/VPFITokenRotationRunbook.md", [1, "HISTORICAL — rotation-scope note", "b39fa2d253dc"]],
  ["docs/ops/tenderly-paste/Diamond-full.json", [43, "HISTORICAL — a captured ABI artifact; regenerate rather than hand-edit", "0f9f95f5f0f1"]],
  ["ops/offchain-data-warm/wrangler.jsonc", [1, "RETRACTION — notes the excised surface in a coverage comment", "cbe6e6147c62"]],
  ["ops/subgraph/abis/Diamond.json", [24, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "bbc6f1112b97"]],
  ["packages/contracts/src/abis/AddCollateralFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/AdminFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/ClaimFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/ConsolidationFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/DefaultedFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/EarlyWithdrawalFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/FeeEntitlementFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/InteractionRewardsFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/LoanFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/NFTPrepayDutchListingFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/NFTPrepayListingFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/OfferAcceptFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/OfferCancelFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/OfferCreateFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/OfferMutateFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/OfferParallelSaleFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/OracleFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/PartialWithdrawalFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/PayrollFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/PrecloseFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/PrepayListingFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/ProfileFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/RefinanceFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/RepayFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/RepayPeriodicFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/RewardAggregatorFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/RewardClaimFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/RewardCommitmentFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/RewardCompensationDispatchFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/RewardRemittanceFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/RewardReporterFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/RiskFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/RiskSplitLiquidationFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/SwapToRepayFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/SwapToRepayIntentFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/TreasuryFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/VPFIDiscountFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/VPFITokenFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/VaultFactoryFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "acd3243d8ca6"]],
  ["packages/contracts/src/abis/index.ts", [2, "RETRACTION — removed-ABI notes in the barrel", "07ec71077e99"]],
  ["packages/contracts/src/chain-config.ts", [2, "RETRACTION — removed-key note", "f8d13b949591"]],
  ["packages/contracts/src/deployments.ts", [1, "RETRACTION — removed-key note on the typed loader", "d8bad2d667a8"]],
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
  // `-s` so each entry carries its MODE. Submodules appear in `git ls-files` as
  // gitlinks (mode 160000) whose path is a directory on disk, so reading one
  // EISDIRs. They are skipped BY MODE rather than by catching that error,
  // because the read path now fails closed (see `scanFile`) and a gate must
  // distinguish "this is not a file" from "I could not read this file". Two
  // exist here: contracts/lib/{limit-order-protocol,solidity-utils}.
  const out = execFileSync('git', ['ls-files', '-s', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = [];
  for (const entry of out.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    if (entry.slice(0, entry.indexOf(' ')) === '160000') continue; // gitlink
    const file = entry.slice(tab + 1);
    if (!isExcluded(file)) files.push(file);
  }
  return files;
}

/** Files where inline markup can split a phrase a reader sees as one. */
const MARKUP_EXTENSIONS = /\.(tsx|jsx|html|htm|md|mdx|svg)$/i;

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
function normalizeWithMap(text, sourcePath, withMap = true, fencedOffsets = null) {
  const out = [];
  const map = [];
  // Iterate the ORIGINAL text and lowercase ONE CHARACTER AT A TIME, so every
  // emitted character maps back to the position it actually came from.
  //
  // The previous version lowercased the whole string first and indexed THAT,
  // which silently assumed lowercasing preserves length. It does not: Turkish
  // `İ`.toLowerCase() is two code units (`i` + combining dot). One such
  // character anywhere in a file shifted every subsequent mapped offset by one,
  // which corrupts `identifierOnly`, the `notFollowedBy` guard, the block
  // boundary test and the digest line window all at once — and fails toward
  // GREEN, because a shifted span stops looking like an identifier.
  // In MARKUP files, skip over tags so a mention split by inline styling is
  // still seen. `Operators must deploy the <strong>buy</strong> adapter` reads
  // to a user as one phrase, but the tag text sat between the words and kept
  // them from fusing. Scoped to markup extensions and to a strict tag shape,
  // because a bare `<` is a comparison in most source files and skipping to the
  // next `>` there would swallow real text.
  const skipTags = MARKUP_EXTENSIONS.test(sourcePath || '');
  const TAG = /^<\/?[a-zA-Z][^<>]*>/;
  for (let i = 0; i < text.length; i++) {
    // NOT inside a fenced block: there, angle brackets are literal command
    // placeholders, not markup. `docs/ops/BaseSepoliaDeploy.md:385,392` carry
    // `<mirror VPFI_BUY_ADAPTER>` in live runbook commands, and stripping them
    // deleted two REAL mentions from that file's pin (27 -> 25) plus one more
    // elsewhere — a false negative introduced by the fix for a false negative.
    if (skipTags && text[i] === '<' && !(fencedOffsets && fencedOffsets(i))) {
      const m = TAG.exec(text.slice(i, i + 400));
      if (m) {
        i += m[0].length - 1;
        continue;
      }
    }
    const lowered = text[i].toLowerCase();
    for (const c of lowered) {
      if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
        out.push(c);
        if (withMap) map.push(i);
      }
    }
  }
  return { norm: out.join(''), map };
}

/**
 * Which lines sit inside a fenced code block.
 *
 * CommonMark: a fence closes only on a run of the SAME marker at least as long
 * as the opener, so a four-backtick block may quote a three-backtick one.
 * Shared by the boundary rules, the heading walk AND the tag skipper — all
 * three need the same answer, and giving them separate notions of "is this
 * code?" is how the last two rounds' defects happened.
 */
function computeFences(lines) {
  const flags = new Array(lines.length).fill(false);
  let openMarker = '';
  let openLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (m) {
      const marker = m[1][0];
      const len = m[1].length;
      if (!openMarker) {
        openMarker = marker;
        openLen = len;
        flags[i] = true;
        continue;
      }
      if (marker === openMarker && len >= openLen && !lines[i].slice(m[0].length).trim()) {
        openMarker = '';
        openLen = 0;
        flags[i] = true;
        continue;
      }
    }
    flags[i] = Boolean(openMarker);
  }
  return flags;
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
  } catch (err) {
    // FAIL CLOSED. Returning "no hits" here treated an unreadable file exactly
    // like a clean one, which is a complete exemption for any path that cannot
    // round-trip through the UTF-8 decoding of `git ls-files` — a tracked file
    // whose name carries an invalid UTF-8 byte decodes to a replacement
    // character, ENOENTs on read, and was silently skipped. A gate must never
    // treat "I could not look" as "I looked and it was fine".
    throw new Error(
      `check-excision-residue: cannot read tracked file ${JSON.stringify(path)} ` +
        `(${err.code || err.message}). Refusing to treat an unreadable file as clean.`,
    );
  }

  // NO binary early-return. An earlier version bailed out on the first NUL
  // byte, which made a single NUL a COMPLETE bypass: a document with a live
  // deploy instruction plus one NUL was exempt from the gate entirely, and any
  // UTF-16 text file took that path naturally. Normalization discards NUL along
  // with every other non-alphanumeric byte, so scanning real binaries costs a
  // little time and finds nothing — the right trade against a silent hole.

  // CHEAP EXACT PRE-FILTER. Normalize without building the offset map and bail
  // if no token is present. Same normalization, so this is not a heuristic and
  // adds no bypass — it only skips the expensive per-character map build for
  // files that cannot match.
  //
  // It exists because removing the binary early-return (correctly — a single NUL
  // was a total exemption) meant reading and normalizing every tracked file,
  // including ~56 MB of PNGs and vendored libraries. I described that as
  // costing "a little time" without measuring it; it was 8-10 s, which is not
  // a little for a gate on every PR. With this pre-filter: ~3.7 s, same result
  // (82 files / 455 mentions), over 5,743 tracked files including ~56 MB of
  // images and vendored libraries.
  //
  // The pre-filter deliberately ignores `notFollowedBy`: a guarded token still
  // needs the full pass to decide, and this only short-circuits files where NO
  // token appears at all. Conservative in the safe direction.
  // Must use the SAME normalization as the real scan. It previously called the
  // plain `normalize`, which is not tag-aware, so in markup files it
  // short-circuited before the tag-aware pass could run — silently defeating
  // that fix. A second implementation of the same transform is a second thing
  // to drift, which is why pin-writing was folded into this file earlier; the
  // pre-filter had reintroduced exactly that.
  // `withMap: false` — same transform, no per-character offset array. ONE
  // implementation with the map made optional, rather than a second
  // normalizer that can drift from it (which is precisely what the previous
  // cheap path did, silently defeating the markup fix in every .tsx file).
  // For NON-markup files tag-skipping is a no-op by definition, so the native
  // regex gives a provably identical string far faster than the per-character
  // loop; markup files take the loop. Same transform either way.
  const lines = text.split('\n');
  const starts = lineStarts(text);
  const inFence = computeFences(lines);
  /**
   * Offset -> "are angle brackets here LITERAL rather than markup?"
   *
   * True inside fenced blocks AND inside inline code spans. Both are places a
   * document writes `<placeholder>` and means it. Covering only fences was not
   * enough: `ContractFollowupsFromRehearsal-2026-05-06.md:41` carries
   * `cast call <buyAdapter>` in an INLINE code span, and stripping it as a tag
   * deleted a real mention — the same false negative as the fenced
   * `<mirror VPFI_BUY_ADAPTER>` case, one markup construct over.
   */
  // Spans computed over the WHOLE text, not per line: a code span may open on
  // one line and close on the next, which is exactly the shape at
  // ContractFollowupsFromRehearsal-2026-05-06.md:41 —
  // `cast call <buyAdapter>` wraps — and a per-line scan could not see it.
  const inlineCodeSpans = (() => {
    const spans = [];
    const re = /(`+)([\s\S]*?)\1/g;
    let m;
    while ((m = re.exec(text))) spans.push([m.index, m.index + m[0].length]);
    return spans;
  })();
  const literalAt = (offset) => {
    if (inFence[lineOf(starts, offset)]) return true;
    return inlineCodeSpans.some(([a, b]) => offset >= a && offset < b);
  };

  const cheap = MARKUP_EXTENSIONS.test(path)
    ? normalizeWithMap(text, path, false, literalAt).norm
    : normalize(text);
  if (!DEAD_TOKEN_RECORDS.some(({ token }) => cheap.includes(token))) {
    return { hits: 0, digest: '' };
  }

  const { norm, map } = normalizeWithMap(text, path, true, literalAt);
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

  /**
   * Is the suffix at normalized `end` part of the SAME WORD as what precedes it?
   *
   * True when the only characters between the token's last letter and the
   * suffix's last letter are `-` or `_`. See the `notFollowedBy` call site.
   */
  const joinedToSuffix = (end, suffixLength) => {
    const gap = text.slice(map[end - 1] + 1, map[end]);
    if (!/^[-_]*$/.test(gap)) return false;
    return /^[A-Za-z0-9_-]+$/.test(text.slice(map[end], map[end + suffixLength - 1] + 1));
  };

  /**
   * Is the SOURCE span behind normalized positions a..b a single identifier —
   * one word, separated at most by `_` or `-`?
   *
   * Used by `identifierOnly` tokens: the two generic English bigrams, which are
   * the only names here ordinary prose can spell by accident.
   */
  const isIdentifierSpan = (a, b) => /^[A-Za-z0-9_-]+$/.test(text.slice(map[a], map[b] + 1));

  /**
   * Lines that sit inside a fenced code block.
   *
   * Needed so the markdown list rule below can be applied to PROSE only. This
   * is bookkeeping over an explicit delimiter, not a guess about English —
   * which is the distinction that matters, because guessing is what the earlier
   * boundary rules did badly.
   */


  /**
   * Does the source span cross a boundary between two separate thoughts?
   *
   * A genuine multi-word mention is a PHRASE — "VPFI buy adapter", or the same
   * words wrapped across a comment continuation. A false positive is two
   * unrelated fragments fused by normalization stripping what separated them.
   *
   * This was deleted in round 8 on the reasoning that only the two generic
   * tokens needed it. That reasoning was wrong and unverified: with it gone,
   * "Decide what to buy. Adapter selection follows.", "buy: adapters", and a
   * paragraph break between "buy." and "Receiver" all produced false positives
   * on `buyadapter` / `buyreceiver`. Restored, minus the rule that was actually
   * harmful and plus the one that was missing:
   *
   *   - sentence enders `. ! ? ; :` and `|` (table-cell edge)
   *   - a blank line
   *   - an ATX heading opening a line — the case that had been MISSING, which
   *     let a heading mid-paragraph fuse two sections
   *   - a markdown list marker opening a line, in `.md` files and NOT inside a
   *     fenced block — the fence exemption is the fix for the rule that had
   *     been HARMFUL, silencing a real `the buy\n * adapter` mention pasted
   *     into a doc as a code sample
   *
   * Newlines alone are never boundaries: `GuardianPausable.sol:16` wraps
   * "the buy\n *         adapter/receiver" and is a real mention.
   */
  const isMarkdown = path.endsWith('.md');
  const crossesBlockBoundary = (a, b) => {
    const from = map[a];
    const to = map[b];
    // Test the span with recognized tags REMOVED, matching what the normalizer
    // saw. Otherwise punctuation that exists only inside stripped markup —
    // the `:` in `<a href="https://…">` — rejects a token the tag-aware pass
    // correctly found, so the markup fix and the boundary rule disagreed about
    // the same text. Fenced spans keep their tags, because there the brackets
    // are literal.
    let span = text.slice(from, to + 1);
    if (MARKUP_EXTENSIONS.test(path) && !literalAt(from)) {
      span = span.replace(/<\/?[a-zA-Z][^<>]*>/g, ' ');
    }
    if (/[.!?;:|]/.test(span)) return true;
    if (/\n[ \t]*\n/.test(span)) return true;
    const firstLine = lineOf(starts, from);
    const lastLine = lineOf(starts, to);
    // BOTH structural rules are markdown-only and fence-excluded. `#` is a
    // heading in Markdown and a COMMENT everywhere else: applying the heading
    // rule globally silenced `deploy-mainnet.sh:831`, which wraps "the buy\n
    // # receiver (canonical) or mirror VPFI + buy adapter" across shell comment
    // lines — live text presenting the removed components as current deploy
    // steps, and the very residue this gate was built to catch. Same trap as
    // the `*` list marker inside a fenced Solidity comment, one round earlier:
    // a character that means "new block" in Markdown means "continuation" in
    // code.
    if (isMarkdown) {
      for (let i = firstLine + 1; i <= lastLine; i++) {
        if (inFence[i]) continue;
        if (/^\s{0,3}#{1,6}\s/.test(lines[i])) return true;
        if (/^\s{0,3}(?:[-*+]\s|\d+[.)]\s)/.test(lines[i])) return true;
      }
    }
    return false;
  };

  // Matches as half-open normalized intervals, so overlaps can be resolved.
  const matches = [];

  for (const { token, notFollowedBy, identifierOnly } of DEAD_TOKEN_RECORDS) {
    let from = 0;
    for (;;) {
      const at = norm.indexOf(token, from);
      if (at === -1) break;
      const end = at + token.length;
      from = end;
      const skip = notFollowedBy.some(
        (suffix) =>
          norm.startsWith(suffix, end) &&
          // The suffix must be JOINED to the token — same word, allowing only
          // intra-word separators. `buyback`, `buy-back` and `buy_back` are all
          // the surviving treasury feature and must be skipped; "buy. Back up
          // config" is a real mention followed by a new sentence and must not
          // be. Strict contiguity got the first right and the hyphenated
          // spellings wrong, reporting live buy-back work as removed-surface
          // residue.
          joinedToSuffix(end, suffix.length),
      );
      if (skip) continue;
      if (identifierOnly && !isIdentifierSpan(at, end - 1)) continue;
      if (crossesBlockBoundary(at, end - 1)) continue;
      matches.push({ start: at, end });
    }
  }

  // Deduplicate by INTERVAL CONTAINMENT, not by start offset. Keying on start
  // was not enough: in `bridgedbuyreceiver` the long token starts at one offset
  // and `buyreceiver` starts seven characters later, so a single occurrence was
  // counted twice — and rewriting it as the prose "buy receiver" then read as a
  // count DECREASE, sending the maintainer the "cleanup happened" message for
  // what was actually a like-for-like edit.
  // Merge every INTERSECTING span, not only contained ones. Containment-only
  // still double-counted partial overlaps: in `FixedRateBuyAdapter`,
  // `fixedratebuy` and `buyadapter` intersect while neither contains the other,
  // so one identifier counted twice — and rewriting it as the prose "buy
  // adapter" then read as a count DECREASE, the same bogus cleanup diagnosis
  // the containment fix was meant to end.
  const kept = [];
  for (const m of [...matches].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = kept[kept.length - 1];
    if (last && m.start < last.end) {
      last.end = Math.max(last.end, m.end);
      continue;
    }
    kept.push({ ...m });
  }

  /**
   * Nearest preceding heading, or '' if none.
   *
   * The two-line window captures the sentence around a mention but not the
   * SECTION STATUS governing it. Flipping `docs/FunctionalSpecs/README.md:121`
   * from "Planned — per-domain functional specs" to "Current — …" turns the
   * buy-adapter entry fifteen lines below into live guidance, and the window
   * could not see it: same count, same digest, gate green. Whether a mention is
   * a record or an instruction is often decided by its heading, so the heading
   * is part of the unit.
   *
   * Matches Markdown ATX headings and the `**Bold lead-in**` form this repo's
   * docs use for sub-sections, which is what line 121 actually is.
   */
  const headingFor = (lineIdx) => {
    // Walk back collecting the APPLICABLE ANCESTRY, not just the nearest
    // heading. Hashing only the nearest one left a status carried by a PARENT
    // reversible without moving the digest: insert a legitimate
    // `### Planned domain list` above a mention, and flipping the grandparent
    // from "Planned" to "Current" became invisible again. Each heading kept
    // must be strictly shallower than the last, which is exactly the chain of
    // headings that governs this line.
    const chain = [];
    let deepest = Infinity;
    for (let i = lineIdx; i >= 0; i--) {
      // Fenced lines are CODE. `# Treasury` inside a fenced shell snippet is a
      // comment, but was read as a level-1 heading and TERMINATED the walk —
      // in contracts/RUNBOOK.md the fenced `# Treasury` at :72 hid the real
      // `### Required env vars` at :44 from the mention at :77, so retitling
      // that real heading stayed invisible. Same Markdown-vs-code confusion as
      // the boundary rules, one function along.
      if (inFence[i]) continue;
      const atx = /^\s{0,3}(#{1,6})\s/.exec(lines[i]);
      const bold = /^\s{0,3}\*\*[^*]+\*\*/.test(lines[i]);
      if (!atx && !bold) continue;
      // A `**Bold lead-in**` sits below any ATX heading; level 7 orders it so.
      const level = atx ? atx[1].length : 7;
      if (level >= deepest) continue;
      deepest = level;
      chain.push(lines[i]);
      if (level === 1) break;
    }
    return chain.reverse().join(' ');
  };

  const units = kept
    .map(({ start, end }) => {
      const startLine = lineOf(starts, map[start]);
      const first = Math.max(0, startLine - DIGEST_CONTEXT_LINES);
      const last = Math.min(
        lines.length - 1,
        lineOf(starts, map[end - 1]) + DIGEST_CONTEXT_LINES,
      );
      // RAW, not normalized — only CRLF and trailing spaces are canonicalized.
      //
      // Normalizing the digest unit erased formatting that carries meaning. In
      // CLAUDE.md's `Do not reason about a "fixed-rate buy"`, changing `not` to
      // `~~not~~` strikes the negation out for every reader while normalizing
      // to the identical string — a retraction visually inverted into an
      // instruction, with the count and digest both unmoved.
      //
      // The cost is that reflowing a paragraph now moves the digest. That is
      // the right trade: re-pinning after a reflow is a one-command chore,
      // whereas an invisible semantic inversion is the failure this gate
      // exists to prevent.
      return [headingFor(first), ...lines.slice(first, last + 1)]
        .map((l) => l.replace(/\r$/, '').replace(/[ \t]+$/, ''))
        .join('\n');
    })
    .sort();

  const digest = units.length
    ? createHash('sha256').update(units.join('|')).digest('hex').slice(0, 12)
    : '';
  return { hits: units.length, digest };
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
  console.error('SAME count, CONTEXT CHANGED (mentions may be identical):');
  for (const c of changed) console.error(`  ${c.file}  digest ${c.was} → ${c.now}`);
  console.error(
    '\n  The count is unchanged but the surrounding text is not. EITHER a\n' +
      '  mention was swapped for a different one, OR the same mentions are\n' +
      '  still there and their context moved — a reflow, a formatting change,\n' +
      '  nearby wording, or the governing heading. The digest covers raw\n' +
      '  context precisely so a retraction cannot be reworded or struck\n' +
      '  through invisibly, which means benign context edits land here too.\n' +
      '  Read the diff for this file. If the mentions still say what they\n' +
      '  said, re-pin with --write-pins; if any now reads as live guidance,\n' +
      '  fix the text.\n',
  );
}

console.error('Context: docs/DesignsAndPlans/VPFISecuritiesFeatureExcision.md, issue #1651.');
process.exit(1);
