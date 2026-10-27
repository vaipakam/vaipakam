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
 * ── SCOPE: PROSE FILES, THEN AN EXCLUDE LIST ─────────────────────────────
 *
 * The gate reads PROSE FILES ONLY: the Markdown family and plain text
 * (`PROSE_EXTENSIONS`). That is an owner decision (2026-10-16, #1734), and it
 * is the root fix for a cluster of issues, not a convenience.
 *
 * WHY. The gate's premise is that a reader sees words, so dropping case and
 * punctuation and joining the file into one string finds every way of writing
 * a dead name. That premise holds for documentation. It does not hold for
 * source code, structured data or container formats, and applying it there
 * produced a false positive on every round of review: `buy + adapter` in
 * JavaScript, two separate JSON string values, a PNG text chunk, PDF strings
 * from different pages. Each was answered with another boundary rule or
 * another decoder (JSON escapes, JSX, PDF streams, Office XML), and each rule
 * defined the next edge (#1730, #1731, #1734, #1758). Knowing that `+`
 * separates operands, or which bytes of a PDF a reader sees, is a parser per
 * language, and this gate was growing one by patches. Scoping to the files
 * where the premise is true ends that by construction.
 *
 * THE FALSE-POSITIVE DIRECTION IS A DESIGN CONSTRAINT. This check blocks
 * merges, so a rule that fires on clean text stops honest work, while a rule
 * that misses a mention leaves coverage at what it was. Weigh any new rule
 * against that: a proposal that closes a false negative by adding a way for
 * clean prose to fail needs a stronger reason than the miss it closes.
 *
 * WHAT IS NOT COVERED, stated rather than implied. A dead name written in a
 * file that is not prose is outside this gate: code and its comments, app copy
 * strings in `.ts`/`.tsx`, shell help text, `.env.example`, JSON and other
 * config, SQL, CSV, and documents in container formats (PDF, Office). For code
 * identifiers the compiler is the better check, since the removed contracts,
 * selectors and errors no longer exist to compile against. For prose inside
 * those files nothing automated replaces this gate; review is what catches it.
 * The ledger entries those files carried when the scope changed are listed on
 * #1728, so the debt they recorded is not lost with them.
 *
 * Within the prose files, everything tracked is in scope except what
 * EXCLUDED_PREFIXES names. Only genuinely ARCHIVAL trees are excluded
 * wholesale — release notes, older docs, findings, ADRs — because every
 * document in them is a dated record and naming the removed surface is their
 * job. Active trees are excluded FILE BY FILE: `docs/internal/` and
 * `docs/TestScopes/` were once excluded whole, which hid a security
 * questionnaire giving a third-party scanner present-tense instructions for
 * the removed adapter, and a test matrix listing it as current coverage.
 * Excluding a tree because part of it is historical hides the live text in
 * the rest.
 *
 * An earlier version listed the directories to CHECK instead, and that list
 * omitted `SECURITY.md`, which described the removed contracts as live
 * components of the cross-chain system. A list of directories can only cover
 * the ones someone thought of. The file-type scope is different in kind: it
 * is a test on the path's extension, not a list of places, so a new document
 * anywhere in the tree is covered without anyone thinking of it.
 *
 * ── HOW IT READS ──────────────────────────────────────────────────────────
 *
 * Through the standard parsers, not its own (#1732, #1758; owner decision
 * 2026-10-25). Markdown is parsed by micromark with GFM and the HTML inside it
 * by the parse5 tokenizer, in `packages/lib/src/markdownProse.mjs`; plain text
 * is split into paragraphs at blank lines. The gate matches dead names inside
 * each rendered block, never across two, and fingerprints the block that
 * holds each mention. This file carried a hand-written CommonMark reader until
 * then, and every review round on it found another construct it misread —
 * the open lists were #1758 (grammar) and #1732 (the fingerprint's reach).
 * What a reader sees is a parser's question; which names are dead and when a
 * match is not a mention are this gate's, and are all that is left here.
 *
 * Fingerprinting by block is broader than the two-line window it replaced: a
 * long block moves its digest on an edit anywhere in it. That is a deliberate
 * trade, stated in full above `scanFile`: a false digest failure costs a
 * re-pin after reading, and the window let a retraction be reworded into live
 * guidance without moving at all.
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
 * Run:  pnpm install --filter @vaipakam/lib   (once, for the parsers)
 *       node .github/scripts/check-excision-residue.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Relative, not `@vaipakam/lib`: this script runs from the repository root
// with no workspace package of its own, and Node resolves the module's
// parser dependencies from `packages/lib/node_modules`, where
// `pnpm install --filter @vaipakam/lib` puts them.
import { readProse } from '../../packages/lib/src/markdownProse.mjs';

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
 * exact case-sensitive identifiers and reported GREEN while two deploy
 * scripts presented the removed receiver and adapter as current deployment
 * components — because they spell them "buy receiver" and "buy adapter". A
 * gate that only sees code spellings does not cover prose, and prose is where
 * this residue lives. (Those scripts are shell files, outside the prose scope
 * since #1734; the lesson about spellings holds for every document.)
 *
 * Normalization runs over each rendered BLOCK as one string, so a phrase
 * wrapped across lines inside a paragraph is still found, while two blocks
 * never join (see `scanFile`).
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
  // why it survived in IVaipakamErrors.sol until #1728's cause-fix deleted the
  // declaration (every facet inheriting that interface had carried it into its
  // ABI, 46 of them pinned on one digest). The token stays, so it cannot return.
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
  // `identifierOnly` for the same reason as `buyrequest`/`buysuccess` below:
  // once spacing and punctuation are gone these are ordinary trading prose.
  // "pending buy-side liquidity" and "quote buy orders" are clean sentences
  // about an order book, and each independently failed this BLOCKING gate as
  // removed-flow residue. The real ABI spellings (`pendingBuys`, `quoteBuy`)
  // are single identifiers, so the constraint costs nothing and admits the
  // order-book and RFQ documentation back.
  { token: 'pendingbuys', identifierOnly: true },
  { token: 'quotebuy', identifierOnly: true },
  'setbuyoptions',
  // The GETTER, which this inventory had listed only in its setter and event
  // forms. `docs/ops/tenderly-paste/Diamond-full.json:6779` still defines it
  // and no current source declares it, so "configure buyOptions before
  // deployment" was live guidance for a dead API that passed cleanly.
  // `identifierOnly` so prose about buying options stays admissible; the
  // interval dedupe below keeps `setBuyOptions` counting once, not twice.
  { token: 'buyoptions', identifierOnly: true },
  // The removed INTERFACE, TEST and MESSAGE names (spec :111-112, :148).
  // Prose can name the deleted flow through these without ever mentioning a
  // contract or a selector — and one was not merely prose: `foundry.toml`'s
  // cifast skip list named `test/VpfiBuyFlowTest.t.sol`, a file the excision
  // deleted, until #1728 removed the entry.
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
  // The removed CAP READER helpers (spec :91-92). The storage keys were
  // already here under their `vpfibuy…` spellings, but the helpers that read
  // them carry a different one — `cfgVpfiFixedGlobalCap()` — so guidance could
  // restore a deleted reader without naming anything the inventory knew.
  'cfgvpfifixedglobalcap',
  'cfgvpfifixedwalletcap',
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
const EXCLUDED_PREFIXES = [
  // ARCHIVAL TREES — every document in them is a dated record of what was
  // true when it was written. Naming the removed surface is their job.
  'docs/ReleaseNotes/',
  'docs/OlderDocs/',
  // …but NOT `docs/ReleaseNotes/unreleased/` — see EXCLUSION_CARVEOUTS below.
  // An assembled note is a dated record; a PENDING fragment is a claim about
  // the product as it ships next, which is precisely what this gate reads.
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
 * `digest` is the first 12 hex of a sha256 over the sorted raw blocks that
 * hold this file's mentions, each with its governing headings — see
 * `scanFile`. It is what catches an equal-count substitution.
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
  [".github/scripts/README.md", [2, "TOOLING — documents this gate and quotes the dead names as examples — digest re-pinned #1734: both mentions unchanged; the scope paragraph above them was rewritten for the prose-only scope", "3b4122c91eaa"]],
  ["CLAUDE.md", [13, "RETRACTION — the \"VpfiBuyAdapter — REMOVED\" section, the cross-chain note and the omit-keys note, each naming the removed flow to say it is gone (triaged #1728)", "08e6f3bd456f"]],
  ["SECURITY.md", [3, "RETRACTION — the CCIP section's note that there is no purchase surface and the removed contracts are out of scope; #1728 took them out of the live scope lists", "8f06034746ef"]],
  ["apps/agent/README.md", [2, "RETRACTION — #1651 notes where the buy-watchdog responsibility stood (triaged #1728)", "abf12c10c2e6"]],
  ["apps/www/src/content/whitepaper/Whitepaper.en.md", [3, "LIVE-TEXT — user-facing; verify against the §8 supersede banner before raising", "285f32e0bdcf"]],
  ["contracts/RUNBOOK.md", [18, "RETRACTION + LIVE-NAME — #687-A / #1651 notes where removed steps and env vars stood, plus the live ConfigureVPFIBuy.s.sol and VPFI_BUY_WEI_PER_VPFI, which set the fee-discount price anchor and only keep the old prefix. Nothing here instructs an operator to use the removed sale (triaged #1728)", "260c6b3e5857"]],
  ["contracts/deployments/CCIP-INFRA-ADDRESSES.md", [4, "HISTORICAL — deployed-address record", "230dc02e4eea"]],
  ["docs/DesignsAndPlans/BorrowerPlatformFeeResearch.md", [1, "RETRACTION — says a buy spread was dropped because the adapter no longer exists (triaged #1728)", "a4b768866ea2"]],
  ["docs/DesignsAndPlans/CloudflareStagingDeployPlan.md", [1, "RETRACTION — #1651 note where the buy-watchdog schedule stood (triaged #1728)", "5e2ddf66262c"]],
  ["docs/DesignsAndPlans/CrossChainRewardSystem.md", [10, "HISTORICAL — dated T-087 design record; #1728 added a removed-surface banner at the top", "6dfca1bdae0e"]],
  ["docs/DesignsAndPlans/DecentralizedPlatformArchitecture.md", [3, "HISTORICAL — dated LayerZero-era architecture snapshot; #1728 added a removed-surface banner at the top", "5d4b2487c07b"]],
  ["docs/DesignsAndPlans/EventSourcingAudit.md", [16, "HISTORICAL — dated event audit naming the retired buy events; #1728 added a removed-surface banner at the top", "769e08c9ba82"]],
  ["docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md", [33, "HISTORICAL — the migration design record, whose buy-flow sections describe the pre-#687-A design; #1728 added a removed-surface banner at the top", "ca4f06df80ba"]],
  ["docs/DesignsAndPlans/OfferFillModesDesign.md", [1, "RETRACTION — notes the removed buy flow the line once contrasted with (#1728)", "48d66146ff7a"]],
  ["docs/DesignsAndPlans/Research-404-OssificationRoadmap.md", [1, "RETRACTION — notes the guardian pause also wrapped the since-removed buy contracts (#1728)", "a148254b3965"]],
  ["docs/DesignsAndPlans/Stage3WorkerSplitPlan.md", [5, "HISTORICAL + RETRACTION — the split plan's original file inventory and cron list, with #687-A deletion notes beside them (triaged #1728)", "916df19737b3"]],
  ["docs/DesignsAndPlans/VPFITokenomicsRedesignResearch.md", [4, "RETRACTION — the pre-#687 warning, followed by #1728's update that the sale is gone", "53eb2c789f1e"]],
  ["docs/FunctionalSpecs/ProjectDetailsREADME.md", [1, "RETRACTION — the \"No Cross-Chain Buy Channel\" rule (triaged #1728)", "473e4a0dcadb"]],
  ["docs/FunctionalSpecs/README.md", [1, "RETRACTION — the domain list notes the buy adapter/receiver was removed (#1728)", "d44bae6edf27"]],
  ["docs/FunctionalSpecs/TokenomicsTechSpec.md", [2, "RETRACTION — the §8 supersede banner", "66406ac74943"]],
  ["docs/GLOSSARY.md", [5, "RETRACTION + HISTORICAL — the \"Buy adapter / receiver — REMOVED\" entry and the LayerZero-era contract list (#1728)", "13f885e282f0"]],
  ["docs/TestScopes/AdvancedUserGuideTestMatrix.md", [2, "RETRACTION — two rows marked retired by #687-A (#1728)", "2afacc140900"]],
  ["docs/ToDo.md", [31, "HISTORICAL — closed ToDo items and a past Safe-transaction record. The file is the owner's list and is not rewritten (triaged #1728)", "d5e9ebd21157"]],
  ["docs/internal/ContractFollowupsFromRehearsal-2026-05-06.md", [12, "HISTORICAL — dated rehearsal follow-ups; #1728 added a removed-surface banner at the top", "9a3cb74c170f"]],
  ["docs/internal/DeployOnTestnet.md", [3, "HISTORICAL — LayerZero-era deploy notes; #1728 added a removed-surface banner at the top", "599d06f26c7d"]],
  ["docs/internal/Issue687A-FrontendExcisionScout.md", [16, "RETRACTION — the #687-A excision checklist, which names what it removed (triaged #1728)", "545223732c1e"]],
  ["docs/internal/PendingTasks-2026-05-14.md", [1, "HISTORICAL — the frozen last dated task list (triaged #1728)", "abdf2e43846e"]],
  ["docs/internal/RiskCommitteeSignOffQuestionnaire.md", [1, "RETRACTION — §5's note that there is no purchase surface; #1728 rewrote §5 from the retired LayerZero answer to the CCIP posture", "3454507e3812"]],
  ["docs/internal/SecurityScanQuestionnaire.md", [1, "RETRACTION — the note that the buy contracts and payment-token modes were removed, so there is nothing to scan (#1728)", "06aa32b6afef"]],
  ["docs/internal/WethChainSafetyAudit-2026-05-14.md", [18, "HISTORICAL — dated WETH audit covering the removed payment-token modes; #1728 added a removed-surface banner at the top", "d15ee44a1396"]],
  ["docs/ops/AnalyticsLabelRegistration.md", [3, "HISTORICAL — label registry rows", "2b6cfcd8c015"]],
  ["docs/ops/BNBTestnetDeploy.md", [24, "LIVE-TEXT — known debt; largest unswept operator runbook after DeploymentRunbook", "48b79f5e343d"]],
  ["docs/ops/BaseSepoliaDeploy.md", [31, "LIVE-TEXT — known debt, PLUS a #884 retraction banner on §4 (+5). The banner is why the count rose: it names the removed knobs (VPFI_BUY_GLOBAL_CAP / _PER_WALLET_CAP / _ENABLED, getVPFIBuyConfig, DeployVPFIBuyReceiver) in order to tell an operator they no longer exist, and to stop §4's hand-invocation of ConfigureVPFIBuy walking around the peg gate. The residue BELOW the banner is untouched and still debt", "04af672b2a73"]],
  ["docs/ops/CcipCutoverRunbook.md", [6, "RETRACTION — #1719 swept the dead steps and left the notes", "b37c80c4e196"]],
  ["docs/ops/ChainByChainChecks.md", [6, "LIVE-TEXT — known debt", "64e398056c19"]],
  ["docs/ops/DeploymentRunbook.md", [46, "LIVE-TEXT — known debt; §\"VPFIBuyAdapter — payment-token mode\" still carries an actionable pre-flight checklist under a Historical banner. #884 LOWERED 47→46: the configure-phase prose no longer lists ConfigureVPFIBuy as a launch child", "1b0dfe86e18a"]],
  ["docs/ops/IncidentRunbook.md", [4, "HISTORICAL — past-incident record", "6a311da0a930"]],
  ["docs/ops/VPFITokenRotationRunbook.md", [1, "HISTORICAL — rotation-scope note", "192752fa405c"]],
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
/**
 * Paths that sit INSIDE an excluded tree but are still scanned.
 *
 * `docs/ReleaseNotes/` is excluded because an assembled note is a dated record
 * of what was true when it was written — naming a removed surface there is its
 * job. `unreleased/` is not that. A pending fragment is a forward-looking
 * description of the product as it is about to ship, written by the same PR
 * that changes behaviour, and the release-notes README requires one from every
 * behaviour-changing PR. A fragment claiming operators can use a removed
 * surface is the exact live-guidance defect this gate exists to catch, and the
 * blanket prefix exempted every one of them — including the fragment each of
 * these PRs adds to describe its own work.
 */
const EXCLUSION_CARVEOUTS = [
  'docs/ReleaseNotes/unreleased/',
  // `docs/ReleaseNotes/assemble.sh` was carved out here too, as active tooling
  // inside an archival tree. It is a shell script, so the prose scope leaves it
  // out by type; a carveout for a file the gate cannot read would be dead.
];

function isExcluded(file) {
  // Directory carveouts match by PREFIX, file carveouts by EQUALITY — the same
  // split `isExcluded` already makes one line below. Treating every carveout as
  // a prefix re-included any sibling whose name merely STARTS with a carved-out
  // file, so an archival record named after it was reported as new live-scope
  // residue.
  if (EXCLUSION_CARVEOUTS.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p)))
    return false;
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

/**
 * The Markdown family, in ONE place: these are parsed as Markdown, every other
 * prose file as plain text.
 *
 * This spelling once drifted into three copies, and adding `.mdc` to two of
 * them left the third treating the file as plain text. `.markdown` is the
 * standard long spelling and `.mdc` a Markdown rule file; leaving either out
 * let the same content skip the Markdown reading by extension alone. `.mdx` is
 * read as Markdown without MDX's JSX layer, as it always has been here.
 */
const MARKDOWN_EXTENSIONS = /\.(?:mdc?|mdx|markdown)$/i;

/**
 * The prose file types: the gate's whole scope. See "SCOPE" in the header.
 *
 * The Markdown family plus plain text, and nothing else. A test on the path
 * and nothing more, on purpose: deciding what a file IS from its content
 * would be the kind of inference the scope exists to stop making.
 */
const PROSE_EXTENSIONS = /\.(?:mdc?|mdx|markdown|txt)$/i;

/** Tracked prose files, from git, minus EXCLUDED_PREFIXES. */
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
    const mode = entry.slice(0, entry.indexOf(' '));
    if (mode === '160000') continue; // gitlink
    // SYMLINKS (120000) are skipped: `readFileSync` follows them, so the bytes
    // scanned would come from wherever the link points rather than from
    // repository-controlled content — and a tiny tracked link to a
    // non-terminating device such as `/dev/zero` would make this blocking job
    // allocate until it is killed. The link's own target text is data in the
    // tree and is not prose this gate can attribute to a file.
    if (mode === '120000') continue;
    const file = entry.slice(tab + 1);
    if (PROSE_EXTENSIONS.test(file) && !isExcluded(file)) files.push(file);
  }
  return files;
}

/**
 * Offsets at which each line begins.
 *
 * CR, LF and CRLF all end a line, as they do for the Markdown parser. The
 * digest's `lines` split by the same three, so a block's source offsets and
 * its lines stay in step.
 */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
    else if (text[i] === '\r') starts.push(text[i + 1] === '\n' ? i + 2 : i + 1);
  }
  return starts.filter((v, k) => k === 0 || v !== starts[k - 1]);
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
 * Scan one file: how many mentions, and a digest identifying WHICH mentions.
 *
 * READING. `readProse` (packages/lib/src/markdownProse.mjs) parses the file
 * with the standard parsers and returns SEGMENTS: the rendered text of each
 * leaf block, the verbatim text of each code block, and the hidden text of
 * each tag, comment and link destination, each with the source offset of
 * every character. This gate used to carry its own CommonMark reader to
 * produce the same thing, and every review round found another construct it
 * misread, in both directions; #1732 and #1758 were the open lists. A
 * reader's question about what is on the page belongs to a parser, so the
 * gate now asks one, and keeps only the questions that are its own: which
 * names are dead, and when a match is not a mention.
 *
 * MATCHING. Each segment is normalized on its own (lower-cased, everything
 * but `a-z0-9` dropped) and searched for every dead token. Nothing fuses
 * across segments, so two blocks, two table cells, two tags or a tag and the
 * text beside it can never combine into a name no reader sees. Inside one
 * segment, a match is dropped when:
 *
 *   - it is followed, in the same word, by a surviving feature's suffix
 *     (`fixed-rate buyback`; see `notFollowedBy`);
 *   - its token is `identifierOnly` and the rendered text it spans is not one
 *     identifier (`pending buy-side`, not `pendingBuys`);
 *   - in rendered or code text (not in a tag or destination), the text it
 *     spans contains sentence punctuation or a blank line. "Decide what to
 *     buy. Adapter selection follows." is two thoughts. Inside a tag the same
 *     characters are configuration, so `data-operation="buy:adapter"` is the
 *     dead name, as `buy-adapter` is.
 *
 * Every other match is a mention: what the reader sees spells the dead name.
 *
 * Overlapping matches are one mention. `scanFile` merges every INTERSECTING
 * pair of source intervals, so `bridgedbuyreceiver` (which contains
 * `buyreceiver`) and `FixedRateBuyAdapter` (where `fixedratebuy` and
 * `buyadapter` overlap) each count once, and a link whose visible text and
 * destination are the same characters counts once.
 *
 * THE DIGEST. The count alone is defeated by an offsetting edit: remove one
 * pinned mention, add another, total unchanged. So each mention contributes a
 * UNIT to a digest: the raw source lines of the block that holds it — the
 * list item's own blocks (task box included, nested-list lines left out),
 * the table row or footnote, or else the paragraph, heading, cell or code
 * block itself — preceded by what governs it: the headings over it
 * (`headingChain`, where a bold lead-in paragraph counts whole), its table's
 * header row, and the own blocks of every list item its item or table is
 * nested in. Units are sorted and hashed, so moving a
 * mention without rewording it is invisible, while rewording its block,
 * retitling a governing heading, relabelling its column or rewording its
 * parent item's lead-in moves the digest.
 *
 * Why the block and not a window of lines around the mention, which is what
 * the digest hashed until #1732: a fixed window both over- and under-reached.
 * It cut a long paragraph in the middle, so a retraction's "were removed" two
 * sentences away could be flipped to "remain deployed" without moving the
 * digest, and it reached into unrelated neighbouring blocks, so an edit to the
 * paragraph below a mention churned the pin. The block is the unit a status
 * sentence lives in.
 *
 * Raw, not normalized: only CR line endings and trailing spaces are
 * canonicalized. Normalizing would erase formatting that carries meaning —
 * striking `not` through as `~~not~~` inverts a retraction for every reader
 * and normalizes to the same string. The cost is that reflowing a block moves
 * its digest; re-pinning after a reflow is one command, whereas an invisible
 * inversion is the failure this gate exists to stop.
 *
 * THE TRADE, stated rather than implied. Reading by block is more accurate in
 * both directions, and one way it is broader: a long block now changes its
 * fingerprint for any edit anywhere in it, where the window ignored edits more
 * than two lines away. That is a false failure of the digest check (re-pin
 * after reading), never a false count, and it is the price of catching the
 * reworded retraction above.
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

  // No pre-filter. The previous reader skipped files whose normalized text
  // held no token, and keeping that pre-filter sound took a second copy of
  // the reader (tags, references and destinations change what is adjacent).
  // Only the parse can say what a reader sees, so every in-scope file is
  // parsed; the whole tree takes seconds.
  const { segments, headingChain } = readProse(
    text,
    MARKDOWN_EXTENSIONS.test(path) ? 'markdown' : 'text',
  );

  const matches = [];
  for (const segment of segments) {
    for (const m of segmentMatches(segment)) matches.push(m);
  }
  if (!matches.length) return { hits: 0, digest: '' };

  // Merge every INTERSECTING pair of source intervals — see the header.
  const kept = [];
  for (const m of [...matches].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = kept[kept.length - 1];
    if (last && m.start < last.end) {
      last.end = Math.max(last.end, m.end);
      continue;
    }
    kept.push({ ...m });
  }

  const starts = lineStarts(text);
  const lines = text.split(/\r\n|\r|\n/);
  const units = kept
    .map(({ unit }) => {
      // Every line a set of ranges touches, once each and in order. A list
      // item's ranges skip its nested lists, so their lines are not part of
      // the parent's fingerprint.
      const linesOf = (ranges) => {
        const at = new Set();
        for (const [from, to] of ranges) {
          for (let l = lineOf(starts, from); l <= lineOf(starts, Math.max(from, to - 1)); l++) at.add(l);
        }
        return [...at].sort((a, b) => a - b).map((l) => lines[l]);
      };
      return [...headingChain(unit.start), ...linesOf(unit.context), ...linesOf(unit.ranges)]
        .map((l) => l.replace(/\r/g, '').replace(/[ \t]+$/gm, ''))
        .join('\n');
    })
    .sort();

  // JSON, not `join('|')`. Joining with a bare pipe is not injective over
  // units that may THEMSELVES contain pipes — and raw Markdown routinely does,
  // every table row being a line of them. `['a', 'b|c']` and `['a|b', 'c']`
  // hash identically, so an equal-count edit that moves text across that
  // boundary would leave the digest unmoved. `JSON.stringify` escapes and
  // length-delimits each unit, so distinct unit arrays give distinct inputs.
  const digest = createHash('sha256').update(JSON.stringify(units)).digest('hex').slice(0, 12);
  return { hits: units.length, digest };
}

/** Sentence punctuation, ASCII and CJK. `|` is a table-cell edge in text that
 *  writes a table without GFM syntax. */
const SENTENCE_BREAK = /[.!?;:|。！？；：]/;
/** A blank line, whatever ends each line. Two line endings with only spaces
 *  between them; a single CRLF is ONE line ending, not a blank line. */
const BLANK_LINE = /(?:\r\n|\r|\n)[ \t]*(?:\r\n|\r|\n)/;
/** One identifier: letters and digits, joined at most by `_` or `-`. */
const IDENTIFIER = /^[A-Za-z0-9_-]+$/;

/**
 * Every dead token in one segment, as source intervals with the segment's
 * unit. See the `scanFile` header for when a match is dropped.
 */
function segmentMatches({ kind, text, map, unit }) {
  // Normalize, remembering which text unit each normalized character came
  // from. Lower-casing can lengthen a character (`İ`), so it maps per output.
  let norm = '';
  const at = [];
  for (let r = 0; r < text.length; r++) {
    for (const c of text[r].toLowerCase()) {
      if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
        norm += c;
        at.push(r);
      }
    }
  }
  const found = [];
  for (const { token, notFollowedBy, identifierOnly } of DEAD_TOKEN_RECORDS) {
    for (let from = 0; ; ) {
      const hit = norm.indexOf(token, from);
      if (hit === -1) break;
      const end = hit + token.length;
      from = end;
      const first = at[hit];
      const last = at[end - 1];
      // A surviving feature's name continues in the SAME WORD: `buyback`,
      // `buy-back`, `buy_back`, `buy<strong>back</strong>` (formatting adds no
      // rendered text). "buy. Back up config" is a mention and a new sentence.
      const joined = notFollowedBy.some(
        (suffix) =>
          norm.startsWith(suffix, end) &&
          IDENTIFIER.test(text.slice(last + 1, at[end + suffix.length - 1] + 1)),
      );
      if (joined) continue;
      if (identifierOnly && !IDENTIFIER.test(text.slice(first, last + 1))) continue;
      if (kind !== 'interior') {
        const spanned = text.slice(first, last + 1);
        if (SENTENCE_BREAK.test(spanned) || BLANK_LINE.test(spanned)) continue;
      }
      found.push({ start: map[first], end: map[last] + 1, unit });
    }
  }
  return found;
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
  // The ledger pattern must match EXACTLY ONCE. `String.replace` returns the
  // source unchanged when it does not match, so a routine reformat of the
  // `PINNED` declaration would turn the documented regeneration command into a
  // no-op that still printed a count and exited 0 — leaving the operator
  // believing they had re-pinned.
  const LEDGER_RE = /const PINNED = new Map\(\[[\s\S]*?\n\]\);/g;
  const hits = self.match(LEDGER_RE);
  if (!hits || hits.length !== 1) {
    console.error(
      `check-excision-residue: --write-pins found ${hits ? hits.length : 0} ledger ` +
        `declarations, expected exactly 1. Refusing to report success without writing.`,
    );
    process.exit(1);
  }
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
