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
 * exact case-sensitive identifiers and reported GREEN while two deploy
 * scripts presented the removed receiver and adapter as current deployment
 * components — because they spell them "buy receiver" and "buy adapter". A
 * gate that only sees code spellings does not cover prose, and prose is where
 * this residue lives. (Those scripts are shell files, outside the prose scope
 * since #1734; the lesson about spellings holds for every document.)
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

/**
 * Character references, resolved to the characters a reader actually sees.
 *
 * Three passes need this and they must agree, because a disagreement is
 * exactly how a mention hides: the normalizer (so `buy&nbsp;adapter` fuses),
 * the boundary check (so `buy&#46; Adapter` does NOT fuse — `&#46;` is a full
 * stop and ends the sentence), and the identifier check (so `buyOpti&#111;ns`
 * is still recognized as the identifier it renders as).
 *
 * Numeric references are decoded properly. Named references resolve through a
 * small table of the ones that carry a boundary or are common in prose;
 * anything else is dropped, since an unknown named entity resolves to
 * punctuation or a letter outside a-z either way and normalization would strip
 * it. A full HTML entity table would be a large dependency for no coverage.
 */
const NAMED_REFS = {
  // Whitespace and punctuation references. The table is small on purpose, but
  // it must cover every VALID reference that renders as space or punctuation —
  // an untabled one is preserved literally (see `renderRefs`), and its letters
  // then wedge two words apart. `&Tab;` was the case that proved it: valid,
  // renders a tab, absent here, so `buy&Tab;adapter` read as `buyTabadapter`
  // and the residue went unreported. Preserving unknown names fixed a false
  // POSITIVE and opened this false negative in the same edit; both are only
  // safe together with a table that is actually complete for this class.
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '', zwj: '', zwnj: '',
  // Keys are LOWER CASE because the lookup lower-cases the name. Written in
  // their HTML spelling (`Tab`, `NewLine`, `ZeroWidthSpace`) they matched
  // nothing at all and the entries were silently dead.
  tab: '\t', newline: '\n', hairsp: ' ', puncsp: ' ', numsp: ' ',
  emsp13: ' ', emsp14: ' ', mediumspace: ' ', nobreak: '',
  verythinspace: ' ', zerowidthspace: '', lrm: '', rlm: '',
  nldr: '.', hellip: '.',
  period: '.', full: '.', excl: '!', quest: '?', semi: ';', colon: ':',
  comma: ',', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', sol: '/', bsol: '\\',
  ndash: '-', mdash: '-', hyphen: '-', bull: '*', middot: '*',
};
const renderRefs = (s) =>
  s.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g,
    (_m, dec, hex, name) => {
      // An UNRECOGNIZED reference is left exactly as written. Deleting it
      // assumed every name outside this table renders as ignorable
      // punctuation, and that assumption manufactured dead names out of clean
      // prose: `buy&bogus;adapter` became `buyadapter` and blocked a document
      // in which no reader sees that phrase. A browser renders an unknown
      // reference as its own source text, so the honest normalization is to
      // keep it — the visible `bogus` then separates the words, as it should.
      // Same for a numeric reference outside the Unicode range.
      if (dec !== undefined || hex !== undefined) {
        const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : _m;
      }
      return Object.prototype.hasOwnProperty.call(NAMED_REFS, name.toLowerCase())
        ? NAMED_REFS[name.toLowerCase()]
        : _m;
    },
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
  [".github/scripts/README.md", [2, "TOOLING — documents this gate and quotes the dead names as examples — digest re-pinned #1734: both mentions unchanged; the scope paragraph above them was rewritten for the prose-only scope", "bd141fc1fd73"]],
  ["AGENTS.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "79390720e2fe"]],
  ["CLAUDE.md", [13, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "3edc0988a8d9"]],
  ["SECURITY.md", [7, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "09e46e416b30"]],
  ["apps/agent/README.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "0ef57050c5e9"]],
  ["apps/www/src/content/whitepaper/Whitepaper.en.md", [3, "LIVE-TEXT — user-facing; verify against the §8 supersede banner before raising", "0d1fb72ff2d8"]],
  ["contracts/RUNBOOK.md", [18, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "e874f90656ff"]],
  ["contracts/deployments/CCIP-INFRA-ADDRESSES.md", [4, "HISTORICAL — deployed-address record", "025166244bba"]],
  ["docs/DesignsAndPlans/BorrowerPlatformFeeResearch.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "0b2df05b7d0a"]],
  ["docs/DesignsAndPlans/CloudflareStagingDeployPlan.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "68d7c258ecf9"]],
  ["docs/DesignsAndPlans/CrossChainRewardSystem.md", [8, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "db8ac858db48"]],
  ["docs/DesignsAndPlans/DecentralizedPlatformArchitecture.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "c9a9c8c91d2e"]],
  ["docs/DesignsAndPlans/EventSourcingAudit.md", [14, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "b2356be9cbf0"]],
  ["docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md", [31, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "ce9ae3a19380"]],
  ["docs/DesignsAndPlans/OfferFillModesDesign.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "d1f7403606be"]],
  ["docs/DesignsAndPlans/OssificationRoadmap.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "8ffefa95f532"]],
  ["docs/DesignsAndPlans/Research-404-OssificationRoadmap.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "319219216d8f"]],
  ["docs/DesignsAndPlans/Stage3WorkerSplitPlan.md", [5, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "a5754fbe447c"]],
  ["docs/DesignsAndPlans/TreasuryBuyback.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "866f16a74d4e"]],
  ["docs/DesignsAndPlans/VPFITokenomicsRedesignResearch.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "7f0a68b88a8c"]],
  ["docs/FunctionalSpecs/ProjectDetailsREADME.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "97e86b8c48a1"]],
  ["docs/FunctionalSpecs/README.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "242c30f2f5e3"]],
  ["docs/FunctionalSpecs/TokenomicsTechSpec.md", [2, "RETRACTION — the §8 supersede banner", "4b76320c09c4"]],
  ["docs/GLOSSARY.md", [6, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "857792c509dd"]],
  ["docs/TestScopes/AdvancedUserGuideTestMatrix.md", [3, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "83bed4aa55e1"]],
  ["docs/ToDo.md", [31, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "e68c77fade19"]],
  ["docs/internal/ContractFollowupsFromRehearsal-2026-05-06.md", [10, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "c1d15d0eef44"]],
  ["docs/internal/DeployOnTestnet.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "55563580671a"]],
  ["docs/internal/Issue687A-FrontendExcisionScout.md", [16, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "5e5014a10efb"]],
  ["docs/internal/PendingTasks-2026-05-14.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "60d70d431e51"]],
  ["docs/internal/RiskCommitteeSignOffQuestionnaire.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "48e800ec4569"]],
  ["docs/internal/SecurityScanQuestionnaire.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "9bd9487effb2"]],
  ["docs/internal/WethChainSafetyAudit-2026-05-14.md", [16, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "09b634ef7230"]],
  ["docs/ops/AnalyticsLabelRegistration.md", [3, "HISTORICAL — label registry rows", "0284187b3cbb"]],
  ["docs/ops/BNBTestnetDeploy.md", [24, "LIVE-TEXT — known debt; largest unswept operator runbook after DeploymentRunbook", "ba2802d042ea"]],
  ["docs/ops/BaseSepoliaDeploy.md", [31, "LIVE-TEXT — known debt, PLUS a #884 retraction banner on §4 (+5). The banner is why the count rose: it names the removed knobs (VPFI_BUY_GLOBAL_CAP / _PER_WALLET_CAP / _ENABLED, getVPFIBuyConfig, DeployVPFIBuyReceiver) in order to tell an operator they no longer exist, and to stop §4's hand-invocation of ConfigureVPFIBuy walking around the peg gate. The residue BELOW the banner is untouched and still debt", "10b5b32f287c"]],
  ["docs/ops/CcipCutoverRunbook.md", [6, "RETRACTION — #1719 swept the dead steps and left the notes", "ab9aa52ffbe1"]],
  ["docs/ops/ChainByChainChecks.md", [6, "LIVE-TEXT — known debt", "874f9b73f212"]],
  ["docs/ops/DeploymentRunbook.md", [46, "LIVE-TEXT — known debt; §\"VPFIBuyAdapter — payment-token mode\" still carries an actionable pre-flight checklist under a Historical banner. #884 LOWERED 47→46: the configure-phase prose no longer lists ConfigureVPFIBuy as a launch child", "529ea61a6eba"]],
  ["docs/ops/IncidentRunbook.md", [4, "HISTORICAL — past-incident record", "967c59306dff"]],
  ["docs/ops/VPFITokenRotationRunbook.md", [1, "HISTORICAL — rotation-scope note", "a3516730a6f5"]],
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
 * The Markdown family, in ONE place.
 *
 * This spelling had drifted into three copies and adding `.mdc` to two of
 * them left the third — link and autolink parsing — still treating the file
 * as plain text. That is the fourth "fixed one path, left its twin" defect on
 * this gate, so the shape is now shared rather than repeated. `.markdown` is
 * the standard long spelling and `.mdc` a Markdown rule file; leaving either
 * out let the same content skip the Markdown handling by extension alone.
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
 * Does the `]` at `end` close a Markdown link or image label?
 *
 * Walks back for an unescaped `[` with no intervening unescaped `]`, which is
 * what CommonMark requires before a destination can follow. Bounded to the
 * paragraph, because a label cannot span a blank line.
 */
/**
 * Offsets of every `]` that really CLOSES a link or image label and is followed
 * by a destination opener.
 *
 * ONE FORWARD PASS over the file, not a backward walk per candidate. The
 * backward version was wrong in a way worth recording: walking right-to-left,
 * the run of backslashes you have just passed sits to the RIGHT of the
 * character you are looking at, so applying it to that character tests the
 * wrong side. `[\*buy](zzzz)` has its `[` preceded by nothing and its `*`
 * escaped, but the walk charged the `\` to the `[`, rejected the real opener,
 * and left the destination in the rendered stream. Escaping is a property of
 * what comes AFTER a backslash run, which only a forward scan sees naturally.
 *
 * Being a single pass also removes the quadratic risk the backward version kept
 * reintroducing — there is nothing left to rescan.
 */
function linkClosePositions(text, literalAt) {
  const closes = new Set();
  const openers = [];
  // Whether the character just consumed was an UNESCAPED `!`. `\\!` is an
  // escaped exclamation mark, so the bracket after it opens a LINK, not an
  // image — and since images survive an inner link while links do not, getting
  // this backwards preserved an opener CommonMark had deactivated and stripped
  // a destination the reader sees.
  let bangBefore = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++; // the escape consumes the next character, whatever it is
      bangBefore = false;
      continue;
    }
    // A bracket inside a code span or fence is LITERAL and cannot open a label;
    // letting one pair with a later bare `](` in prose stripped visible text.
    // Same literal-region information the destination skip already consults.
    if (literalAt && literalAt(i)) {
      bangBefore = false;
      continue;
    }
    // …and a bracket inside a recognized HTML TAG is tag data, not a label
    // opener — `<span title="[">` is one element, and letting its `[` pair with
    // a later `](` in prose stripped a run the reader sees. Skipped with the
    // same quote-aware walk the tag scanner uses, so an attribute value
    // containing `>` cannot end the tag early here either.
    // Comments, CDATA, processing instructions and declarations are raw HTML
    // too, and a `[` inside any of them is invisible — `<!-- [ -->` is not a
    // label opener. Round 17 skipped element tags only, so the comment case
    // still paired with a later `](` and stripped a run the reader sees.
    const rawSpan = [
      ['<!--', '-->'],
      ['<![CDATA[', ']]>'],
      ['<?', '?>'],
    ].find(([open]) => text.startsWith(open, i));
    if (rawSpan) {
      const close = text.indexOf(rawSpan[1], i + rawSpan[0].length);
      if (close === -1) break;
      i = close + rawSpan[1].length - 1;
      bangBefore = false;
      continue;
    }
    if (c === '<' && /^<![A-Za-z]/.test(text.slice(i, i + 4))) {
      const close = text.indexOf('>', i + 2);
      if (close === -1) break;
      i = close;
      bangBefore = false;
      continue;
    }
    if (c === '<' && /^<\/?[a-zA-Z][a-zA-Z0-9-]*(?=[\s/>])/.test(text.slice(i, i + 64))) {
      let j = i + 1;
      let q = '';
      for (; j < text.length; j++) {
        const d = text[j];
        if (q) {
          if (d === q) q = '';
        } else if (d === '"' || d === "'") q = d;
        else if (d === '>') break;
      }
      if (j < text.length) {
        i = j;
        bangBefore = false;
        continue;
      }
    }
    // A label cannot span a blank line, so a paragraph break drops any
    // still-open brackets rather than letting them match across it.
    if (/[\r\n]/.test(c) && /^[ \t\r]*\n|^[ \t]*\r/.test(text.slice(i + 1))) {
      openers.length = 0;
      continue;
    }
    // `![` opens an IMAGE, `[` a link. The distinction decides what an inner
    // link deactivates.
    if (c === '[') openers.push({ at: i, image: bangBefore });
    else if (c === ']' && openers.length > 0) {
      openers.pop();
      if (text[i + 1] === '(' || text[i + 1] === '[') {
        closes.add(i);
        // LINKS CANNOT CONTAIN LINKS, so completing one marks every enclosing
        // LINK opener inactive and the outer pair renders literally. IMAGES
        // CAN contain links, though — `![alt [x](/inner)](/image)` is a valid
        // image whose description holds a link — so clearing the whole stack
        // discarded a real image opener and left its `/image` destination in
        // the rendered stream. Deactivate the link openers; keep the images.
        for (let k = openers.length - 1; k >= 0; k--) {
          if (!openers[k].image) openers.splice(k, 1);
        }
      }
    }
    bangBefore = c === '!';
  }
  return closes;
}

/**
 * How many block-quote containers a line opens with.
 *
 * A boolean is not enough: `>` and `>>` are different blocks, and treating
 * both as merely "quoted" fused text across a nesting change.
 */
function quoteDepth(line) {
  let rest = line;
  let depth = 0;
  for (;;) {
    const m = /^[ \t]{0,3}>[ \t]?/.exec(rest);
    if (!m) return depth;
    depth++;
    rest = rest.slice(m[0].length);
  }
}

/**
 * A line with every active container prefix removed.
 *
 * ITERATIVE, because quotes and lists interleave in both orders. Two fixed
 * replacements handled `> - ` and missed `- > `: stripping the list marker
 * only exposes the quote after the quote pass has already run, so a fence
 * opened inside a quote inside a list went unrecognized and its literal
 * markup was stripped as HTML.
 */
function stripContainers(line) {
  let bare = line;
  for (;;) {
    const stripped = bare
      .replace(/^(?:[ \t]{0,3}>[ \t]?)+/, '')
      .replace(/^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/, '');
    if (stripped === bare) return bare;
    bare = stripped;
  }
}

/**
 * Leading indentation measured in COLUMNS, expanding tabs to four-column
 * stops. A tab is one character but four columns, so counting characters made
 * a tab-indented line look like a one-space one — and `\t```` reads as
 * indented CODE in CommonMark, not as a fence opener.
 */
function indentColumns(str) {
  return columnWidthFrom(0, /^[ \t]*/.exec(str)[0]);
}

/**
 * How many COLUMNS a string occupies, expanding tabs to four-column stops
 * reckoned from `start` — the column the string actually begins at. Tab stops
 * are absolute, so a width measured from zero is wrong for anything nested.
 */
function columnWidthFrom(start, str) {
  let col = start;
  for (const ch of str) col += ch === '\t' ? 4 - (col % 4) : 1;
  return col - start;
}

/**
 * Every line's CONTAINER CHAIN — the block quotes and list items it sits
 * inside, each as a distinct INSTANCE.
 *
 * Depth alone cannot answer the question the fence walk actually has, which is
 * "is this line inside the same container the fence opened in?". Two sibling
 * list items have equal depth and equal indentation but are different blocks;
 * a blank line ends a quote, so `>` after it opens a new one at the same
 * depth. Identity is what distinguishes them, so each entry carries an id
 * that changes when the container restarts.
 *
 * Returns one entry per line: `chain` (the instances, outermost first) and
 * `prefixLens[k]` (characters consumed by the first k of them), so a caller
 * can strip exactly the containers it cares about and treat anything deeper
 * as literal content.
 */
function containerChains(lines) {
  const out = [];
  let chain = [];
  let nextId = 1;
  let blankBefore = false;
  // Whether the previous line was PARAGRAPH text. An ordered marker other
  // than `1.` cannot interrupt a paragraph, so it opens no list — and without
  // that, `intro` / `2. ``` ` manufactured a container whose backticks opened
  // a fence, hiding every following line. Approximated as "non-blank and not
  // itself a leaf block": a heading or thematic break IS interruptible-after,
  // so a list may follow one directly.
  let prevParagraph = false;
  for (const line of lines) {
    if (line.trim() === '') {
      // A blank line does not itself close a container — the block may
      // continue after it — but it DOES end a block quote, so a later `>` at
      // the same depth is a new quote rather than a continuation.
      out.push({ chain: chain.slice(), prefixLens: [0] });
      blankBefore = true;
      prevParagraph = false;
      continue;
    }
    let rest = line;
    let consumed = 0;
    let absCol = 0;
    const next = [];
    const prefixLens = [0];
    for (;;) {
      // A list item continued by INDENTATION comes first. `  > text` under
      // `- > text` is two spaces of list-item content followed by a quote
      // marker — reading the quote first made it a new top-level quote and
      // lost the enclosing item.
      //
      // The width compared here is RELATIVE to the item's own parent. Measured
      // absolutely, the columns an OUTER quote marker consumed counted toward
      // an inner item's continuation, so `  > text` under `> - ```` kept the
      // list item alive on a line that has no indentation after its quote
      // prefix at all — and the fence inside it never closed.
      const open = chain[next.length];
      if (open && open.kind === 'li' && columnWidthFrom(absCol, /^[ \t]*/.exec(rest)[0]) >= open.relCol) {
        const pad = /^[ \t]*/.exec(rest)[0];
        let take = 0;
        let cols = 0;
        while (take < pad.length && cols < open.relCol) {
          cols += pad[take] === '\t' ? 4 - ((absCol + cols) % 4) : 1;
          take++;
        }
        consumed += take;
        absCol += cols;
        next.push(open);
        prefixLens.push(consumed);
        rest = rest.slice(take);
        continue;
      }
      const q = /^[ \t]{0,3}>[ \t]?/.exec(rest);
      if (q) {
        const reuse = !blankBefore && chain[next.length]?.kind === 'q';
        consumed += q[0].length;
        const w = columnWidthFrom(absCol, q[0]);
        absCol += w;
        next.push({
          kind: 'q',
          id: reuse ? chain[next.length].id : nextId++,
          relCol: w,
        });
        prefixLens.push(consumed);
        rest = rest.slice(q[0].length);
        continue;
      }
      // A list MARKER always starts a new item, which is exactly why sibling
      // items must not be conflated: same depth, same indentation, different
      // block. `[ \t]+|$` because a marker alone on its line is a valid EMPTY
      // item — requiring trailing space made no container at all, so a fence
      // indented under it looked top-level and never closed at the sibling.
      const li = /^[ \t]{0,3}(?:([-*+])|(\d{1,9})[.)])(?:[ \t]+|$)/.exec(rest);
      // An ordered marker that is not `1.` cannot interrupt a paragraph, so
      // after paragraph text it stays prose and opens no container. Without
      // this, `intro` / `2. ``` ` manufactured a list whose backticks opened a
      // fence and hid every line below it.
      const interrupts = li && (li[1] !== undefined || li[2] === '1' || !prevParagraph);
      if (li && interrupts) {
        consumed += li[0].length;
        // COLUMNS, measured FROM THE PARENT's column — not restarted at zero.
        // `-\t` after `> ` occupies two columns, not four, because the tab
        // stop is reckoned from where the quote content began. Restarting let
        // a correctly indented continuation look like a dedent and closed a
        // fence that was still open.
        const w = columnWidthFrom(absCol, li[0]);
        absCol += w;
        next.push({
          kind: 'li',
          id: nextId++,
          relCol: w,
        });
        prefixLens.push(consumed);
        rest = rest.slice(li[0].length);
        continue;
      }
      break;
    }
    chain = next;
    blankBefore = false;
    // Paragraph text for the NEXT line's interruption test: content remains
    // after the containers, and it is not a leaf block of its own.
    prevParagraph =
      rest.trim() !== '' &&
      !/^[ \t]{0,3}(?:#{1,6}(?:\s|$)|(?:`{3,}|~{3,})|(?:[-*+_][ \t]*){3,}$|=+[ \t]*$)/.test(rest);
    out.push({ chain: chain.slice(), prefixLens });
  }
  return out;
}

/** Do two container chains share the same first `n` instances? */
function sameContainer(a, b, n) {
  if (a.length < n || b.length < n) return false;
  for (let k = 0; k < n; k++) if (a[k].id !== b[k].id) return false;
  return true;
}

/**
 * The column a line's content starts in, counting container prefixes.
 *
 * What the containers consumed plus whatever indentation survives them — NOT
 * the raw leading whitespace, which is zero for `- - text` even though its
 * content sits in column four.
 */
function contentColumn(line) {
  const bare = stripContainers(line);
  return line.length - bare.length + /^[ \t]*/.exec(bare)[0].length;
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
/** Sentinel path: text already inside a tag — decode refs, do not strip tags. */
const TAG_INTERIOR = '\0tag-interior';

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
  // Two separate questions, and conflating them cost a bypass. `skipTags` asks
  // "should elements be lifted out of the stream" — false when we are already
  // INSIDE one, so a nested tag is not stripped twice. `decodeRefs` asks
  // "does this text render character references" — which is true of a tag's
  // interior as much as the document's body, since `data-x="buyOpti&#111;ns"`
  // resolves to the dead identifier in any renderer. Passing `''` as the path
  // to suppress the first had been silently suppressing the second.
  const skipTags = MARKDOWN_EXTENSIONS.test(sourcePath || '');
  const isMdSource = MARKDOWN_EXTENSIONS.test(sourcePath || '');
  const decodeRefs = skipTags || sourcePath === TAG_INTERIOR;
  const TAG = /^<\/?[a-zA-Z][^<>]*>/;
  const tagSpans = [];
  // Memo for the link-destination scan below: once a closing delimiter is
  // known to be absent from the rest of the file, every later opener can be
  // rejected in O(1). `at` is the offset from which that is known.
  const noRParenAfter = { at: -1 };
  const noRBracketAfter = { at: -1 };
  const linkCloses = isMdSource ? linkClosePositions(text, fencedOffsets) : new Set();
  for (let i = 0; i < text.length; i++) {
    // NOT inside a literal region: there, angle brackets are literal command
    // placeholders, not markup. `docs/ops/BaseSepoliaDeploy.md:385,392` carry
    // `<mirror VPFI_BUY_ADAPTER>` in live runbook commands, and stripping them
    // deleted two REAL mentions from that file's pin (27 -> 25) plus one more
    // elsewhere — a false negative introduced by the fix for a false negative.
    // MARKDOWN LINK DESTINATIONS are not rendered text. A reader of
    // `deploy the [buy](https://example.com/config) adapter` sees the two words
    // side by side; the normalizer kept the URL's letters between them, so the
    // phrase never fused and the gate passed live prose naming a dead surface.
    // Skipping from `]` through the closing delimiter emits nothing, leaving the
    // label and the following text adjacent — which is what renders.
    if (
      isMdSource &&
      text[i] === ']' &&
      (text[i + 1] === '(' || text[i + 1] === '[') &&
      !(fencedOffsets && fencedOffsets(i)) &&
      // …and only when this `]` actually CLOSES a label. A bare `](` in
      // running prose is literal visible text under CommonMark — there is no
      // link without an opener — but this branch assumed one and deleted the
      // destination, so `Decide what to buy](configuration)Adapter selection`
      // lost the middle and synthesized `buyadapter` on a clean file. Same
      // class as the angle-bracket case two rounds ago: treating something
      // shaped like markup as markup without checking that it is.
      linkCloses.has(i)
    ) {
      const open = text[i + 1];
      const close = open === '(' ? ')' : ']';
      // O(1) reject once we know the delimiter never appears again.
      //
      // Without this, a document full of unterminated `](` walked the whole
      // remaining file per candidate: 100,000 repetitions in 200 KB took ~30 s,
      // and this is a blocking gate, so a malformed document could stall CI.
      //
      // Measured, because my first attempt at this did not work: bounding each
      // candidate to its own LINE changed nothing (30511 ms -> 30061 ms), since
      // the pathological document is a single long line. What actually bounds
      // it is noticing that the closing delimiter is absent from the rest of
      // the file — then every later opener is rejected without scanning.
      // Sound because it is a statement about the delimiter's absence, not
      // about nesting depth: if `close` does not occur after `i`, no scan
      // starting at or after `i` can find it.
      const noneAfter = open === '(' ? noRParenAfter : noRBracketAfter;
      if (noneAfter.at >= 0 && i >= noneAfter.at) {
        i += 1;
        continue;
      }
      if (text.indexOf(close, i + 2) === -1) {
        noneAfter.at = i;
        i += 1;
        continue;
      }
      // BACKSLASH ESCAPES are not delimiters. `[buy](https://example/a\\)b)`
      // has ONE destination whose text contains a literal `)`, and treating the
      // escaped one as the terminator ended the destination early — the
      // leftover `b)` stayed in the stream and wedged the label apart from the
      // word after it, so a rendered mention went unreported. A delimiter inside a
      // quoted or escaped context is data, not structure.
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === '\\') {
          j++; // skip the escaped character, whatever it is
          continue;
        }
        if (text[j] === open) depth++;
        else if (text[j] === close) {
          depth--;
          if (depth === 0) break;
        } else if (/[\r\n]/.test(text[j]) && /^[ \t\r]*\n|^[ \t]*\r/.test(text.slice(j + 1))) {
          // A line of spaces or tabs is BLANK under CommonMark, and requiring
          // two adjacent newlines missed it — the walk then crossed the
          // paragraph, ran to EOF, and set the absence memo on evidence it had
          // no right to. Same rule as the label scan uses, which already
          // allowed the whitespace.
          break; // unterminated
        }
      }
      // …but ONLY when the walk actually reached EOF. It also stops at a blank
      // line (an unterminated destination cannot span one), and recording
      // absence there claimed something about the whole rest of the file that
      // one paragraph cannot establish — every later destination was then
      // rejected unscanned and real mentions after it went unreported. A
      // performance memo that is allowed to lie is worse than no memo.
      if (j >= text.length) {
        // No UNESCAPED closer after `i`. The cheap `indexOf` pre-check above
        // cannot establish that — it finds escaped ones too, so a file whose
        // only `)` is written `\)` defeated the memo and every earlier `[x](`
        // walked to EOF again. Recording it here, where the walk has just
        // proved it, restores the O(1) rejection: if no unescaped closer
        // follows `i`, none follows any later position either.
        noneAfter.at = i;
      }
      if (j < text.length && text[j] === close) {
        // Record the destination so the SECOND stream still scans it, exactly
        // as tag interiors are handled. Plain skipping cost three real pinned
        // mentions (`docs/ToDo.md` 31 -> 29, ContractFollowups 10 -> 9): dead
        // names DO appear inside link targets, and a URL naming a removed
        // artifact is residue even though no reader sees the characters.
        // Removed from the rendered stream, kept under its own scan.
        tagSpans.push([i + 1, j + 1]);
        i = j;
        continue;
      }
    }
    if (skipTags && text[i] === '<' && !(fencedOffsets && fencedOffsets(i))) {
      // MARKDOWN AUTOLINKS are VISIBLE text, not invisible markup. `<https://…>`
      // and `<name@example.com>` render as the URL itself, so they separate the
      // words either side exactly as any other visible run does. Stripping them
      // as tags fused `buy<https://example.com>Adapter` into a mention and
      // failed a clean document — a false positive on a blocking gate, which is
      // the more expensive direction. Recognized by the CommonMark shape: a
      // scheme, or an address, with no spaces and no `<` before the `>`.
      if (isMdSource) {
        // NO LENGTH CAP. This used to test `text.slice(i, i + 2048)`, so a
        // valid autolink longer than that lost its closing `>`, failed
        // recognition, and fell through to the tag scanner — which stripped
        // the whole visible URL and fused the words either side back together.
        // A 2050-character query string was enough to make `buy<…>Adapter`
        // report as a mention again, i.e. the cap silently reopened the bypass
        // this branch exists to close.
        //
        // Bounded work without a bounded window: an autolink admits neither
        // whitespace nor `<`, so for any VALID one the first `>` after `i` is
        // necessarily its terminator. Test exactly that substring, anchored at
        // both ends.
        //
        // Walk forward ONCE, abandoning the candidate at the first character an
        // autolink cannot contain. `indexOf('>')` looked bounded and was not:
        // on a document with many unmatched `<` before a distant `>`, every
        // opening bracket rescanned the same suffix, making normalization
        // quadratic — ~25 s on 1 MB against ~11 s normally, with 2 MB failing
        // to finish. A blocking CI gate that a malformed document can stall is
        // a denial of the gate itself, which is a worse failure than the false
        // positive the autolink branch exists to prevent.
        //
        // Whitespace and `<` are both disallowed inside an autolink, so either
        // proves this `<` opens none. Each character is examined by at most one
        // candidate before that candidate is abandoned, so the total stays
        // linear in the file.
        let close = -1;
        for (let j = i + 1; j < text.length; j++) {
          const ch = text[j];
          if (ch === '>') {
            close = j;
            break;
          }
          if (ch === '<' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            break;
          }
        }
        const auto =
          close === -1
            ? null
            : /^<(?:[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>$/.exec(
                text.slice(i, close + 1),
              );
        if (auto) {
          // Left in the stream deliberately — the reader sees these characters.
          //
          // Each character carries its OWN source offset. Pushing `i` for all
          // of them collapsed the whole autolink onto the opening `<`, so a
          // dead name inside the URL gave `isIdentifierSpan` a one-character
          // span consisting of a bracket — which is not an identifier, so the
          // match was discarded and `<https://example.com/buyOptions>` passed
          // a gate whose entire job is to catch that name.
          for (let k = 0; k < auto[0].length; k++) {
            const c = auto[0][k].toLowerCase();
            // Single-char lowercase only: the ASCII alphanumerics this admits
            // are 1:1 under `toLowerCase`, and anything that expands to more
            // than one unit is not alphanumeric here anyway. Keeping it 1:1 is
            // what lets `k` stay a faithful source offset.
            if (
              c.length === 1 &&
              ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))
            ) {
              out.push(c);
              if (withMap) map.push(i + k);
            }
          }
          i += auto[0].length - 1;
          continue;
        }
      }
      // HTML comments FIRST — they are invisible markup too, and the tag shape
      // below does not recognize them (`!` is not a letter). A reader of
      // `deploy the buy <!-- note --> adapter` sees one phrase; leaving the
      // comment in the stream kept the two words from fusing and the gate
      // green. Invisible-to-the-reader is the property that matters here, not
      // element-shaped.
      // …and the OTHER raw-HTML constructs CommonMark defines beside it, for
      // exactly the same reason. A processing instruction, a declaration and a
      // CDATA section are all passed through to the output as markup and none
      // of them is presented to the reader as text — yet each begins `<` with
      // a NON-LETTER after it, so the comment special case missed them and the
      // letter-led tag shape below rejected them, and their payload stayed in
      // the stream wedging two words apart. `<?target data?>` between `buy`
      // and `adapter` normalized to `vpfibuytargetdataadapter` and a visible
      // mention went unreported. Each carries its own terminator, so none of
      // them can be scanned as an ordinary tag.
      const rawHtml = [
        ['<!--', '-->'],
        ['<![CDATA[', ']]>'],
        ['<?', '?>'],
        // Declaration: `<!` followed by an ASCII LETTER. Verified against the
        // repository's own micromark rather than from memory, because the
        // boundary is not obvious — `<!not-html>` and `<!A>` ARE declarations
        // and are passed through as markup, while `<!>`, `<! >`, `<!9>`,
        // `<!->` and `<![x]>` all render as literal visible text. A catch-all
        // `<!` stripped that second group and could fuse the words either side
        // of it.
        [/^<![A-Za-z]/, '>'],
      ].find(([open]) =>
        typeof open === 'string' ? text.startsWith(open, i) : open.test(text.slice(i, i + 4)),
      );
      if (rawHtml) {
        const openLen = typeof rawHtml[0] === 'string' ? rawHtml[0].length : 2;
        const close = text.indexOf(rawHtml[1], i + openLen);
        // An unterminated construct swallows the rest of the file in a real
        // renderer; do the same rather than resuming mid-construct.
        const stop = close === -1 ? text.length : close + rawHtml[1].length;
        tagSpans.push([i, stop]);
        i = stop - 1;
        continue;
      }
      // Scan to the ACTUAL closing `>`, with no length cap. The cap was 400
      // source characters, which meant an element whose attributes ran longer
      // than that was not recognized as a tag and stayed in the stream —
      // reopening the very bypass the tag handling exists to close, for anyone
      // who writes a long `data-` attribute. An arbitrary limit on how much
      // markup counts as markup is a limit on how much of the file is checked.
      //
      // Unbounded is SAFE here, which is not obvious and was worth checking:
      // a stray `<x` with its next `>` far away swallows a large span, but
      // nothing is thereby exempted — every tag span is re-normalized and
      // scanned on its own further down (the pre-filter concatenates them, and
      // the main pass walks each one), precisely so a mention hidden inside an
      // attribute still counts. Removing the cap can only widen what is read
      // as markup, never narrow what is examined.
      // Quote-AWARE scan for the closing `>`. A bare `indexOf('>')` stops at
      // the first one, and `<span title="1 > 0">` puts one inside an
      // attribute value — so the tag was split early, the leftover `0">`
      // stayed in the stream, and the words either side of the element did not
      // fuse. Attribute quoting is part of the syntax; a scanner that ignores
      // it is not reading the markup, it is reading past it.
      let close = -1;
      // STRICT tag grammar, not just "starts with a letter". The loose test
      // accepted anything bracketed beginning with a letter, so an angle-
      // bracket run containing whitespace — rejected as an autolink just above
      // — fell through here and was stripped as markup. `buy<https://example.com
      // some-label>Adapter` is literal visible text in Markdown: not an
      // autolink, not a tag. Stripping it synthesized `buyadapter` and BLOCKED
      // a clean file, which is the expensive direction for a blocking gate.
      //
      // CommonMark: a tag name is a letter followed by letters, digits or
      // hyphens, and must then be followed by whitespace, `/`, or `>`. That is
      // exactly what rejects `<https://…>` — `https` is a valid name, but the
      // `:` after it is none of the three.
      const tagShape = /^<\/?[a-zA-Z][a-zA-Z0-9-]*(?=[\s/>])/.test(
        text.slice(i, i + 64),
      );
      if (tagShape) {
        let quote = '';
        for (let j = i + 1; j < text.length; j++) {
          const ch = text[j];
          if (quote) {
            if (ch === quote) quote = '';
          } else if (ch === '"' || ch === "'") {
            quote = ch;
          } else if (ch === '<') {
            break; // A new tag starts: this one never closed.
          } else if (ch === '>') {
            close = j;
            break;
          }
        }
      }
      if (close !== -1) {
        tagSpans.push([i, close + 1]);
        i = close;
        continue;
      }
    }
    // Character references are RENDERED, so the stream must carry what the
    // reader sees rather than the source spelling. `buy&nbsp;adapter` renders
    // as "buy adapter" — one phrase — but normalizing the source put the
    // letters `nbsp` between the words and kept them from fusing. Same class
    // as the tag and comment skips: markup that is invisible on the page.
    //
    // Numeric references are DECODED, because `&#65;` is the letter A and
    // dropping it would lose a real character. Named references are dropped
    // instead of decoded: every named entity a document uses here resolves to
    // punctuation or whitespace, which normalization would strip anyway, and a
    // full HTML entity table is a large dependency for no additional coverage.
    // Every emitted character maps to the reference's START offset, so the
    // digest window and the boundary tests still point at the source text.
    if (decodeRefs && text[i] === '&' && !(fencedOffsets && fencedOffsets(i))) {
      // A semicolon is REQUIRED here, including on the HTML path — and that is
      // a known gap, not the intended end state. HTML does consume a legacy
      // named reference without one, so `buy&nbsp adapter` renders the retired
      // phrase and this misses it. Widening the pattern was tried twice in
      // review and reverted both times: `;?` is greedy, so it matched
      // `nbspadapter` as the entity name, decoded it to nothing, and ate the
      // following word — a worse failure than the one it fixed. The sound
      // version needs HTML's following-character rules and is on #1758.
      //
      // An earlier version of this comment described the widening as though it
      // were implemented. It never was, and a comment claiming behaviour the
      // code does not have is worse here than no comment at all.
      const ref = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|[a-zA-Z][a-zA-Z0-9]{1,31});/.exec(
        text.slice(i, i + 40),
      );
      if (ref) {
        // Same `renderRefs` the boundary and identifier checks use — one table,
        // so the three passes cannot drift apart about what a reference means.
        for (const c of renderRefs(ref[0]).toLowerCase()) {
          if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
            out.push(c);
            if (withMap) map.push(i);
          }
        }
        i += ref[0].length - 1;
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
  return { norm: out.join(''), map, tagSpans };
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
  // Which lines are the fence DELIMITERS themselves, as distinct from the
  // content between them. `flags` conflates the two (a delimiter is marked
  // in-fence so its own text is treated as code), but the boundary rule below
  // needs to know a span JUMPED one: "Decide what to buy", an empty fenced
  // block, then "Adapter selection follows" is two separate thoughts with a
  // block between them, and reading only `flags` there sees an uninterrupted
  // run of non-code lines.
  const delimiter = new Array(lines.length).fill(false);
  let openMarker = '';
  let openLen = 0;
  // The container context the open fence lives in. A fence inside a list item
  // or a block quote is closed by the END OF THAT CONTAINER, not only by a
  // matching delimiter — CommonMark closes any open block when its parent
  // closes. Tracking only `openMarker` meant an UNCLOSED container fence
  // marked the rest of the file literal, so markup below it was never
  // stripped and a live `buy<strong>adapter</strong>` went unseen. That is a
  // false NEGATIVE on a blocking gate, which is the one failure this whole
  // file exists to prevent; every other container defect here has been a
  // false positive.
  //
  // Identity, not depth or indentation. Four separate defects came from
  // approximating "the same container" with a number: sibling list items have
  // equal depth and equal indentation, a blank line ends a quote so an
  // identical `>` after it is a NEW quote, and a top-level fence's own
  // optional 1–3 space indent is not a container column at all.
  let openChain = [];
  const chains = containerChains(lines);
  for (let i = 0; i < lines.length; i++) {
    // Container prefixes come off first — a fence opened inside a list item or
    // a block quote starts after its marker, and a raw-line test saw only
    // whitespace before the backticks. The fence then went unrecognized, the
    // literal `<strong>` inside it was stripped as markup, and a clean document
    // was BLOCKED. Third pass in this file to learn the same lesson about
    // containers, after the indentation and heading walks.
    const { chain, prefixLens } = chains[i];
    // While a fence is open, ONLY the containers it was opened in are
    // structure; anything deeper is literal content. That single rule settles
    // two cases that pull in opposite directions: a sibling list item at the
    // opener's own depth ends the fence, while `- ```` inside a TOP-LEVEL
    // fence is just code and must not.
    if (openMarker && lines[i].trim() !== '' && !sameContainer(chain, openChain, openChain.length)) {
      openMarker = '';
      openLen = 0;
      flags[i] = false;
      // Deliberately NO `continue`: the line that leaves the old container
      // can itself open a new fence, and skipping it left that opener
      // unrecognized.
    }
    // Strip exactly the containers in scope — the opener's own while a fence
    // is open, all of them otherwise.
    const depth = openMarker ? openChain.length : chain.length;
    const containerBare = lines[i].slice(prefixLens[Math.min(depth, prefixLens.length - 1)] ?? 0);
    // Tab-aware: `\t```` is indented code, not a fence, because a tab is four
    // columns. The character-counting `\s{0,3}` accepted it as a fence and
    // then classified the live prose below it as code.
    const m =
      indentColumns(containerBare) <= 3
        ? /^[ \t]*(`{3,}|~{3,})/.exec(containerBare)
        : null;
    // Everything below reads `containerBare`, not `lines[i]`. Matching on the
    // stripped line and then validating the closer against the RAW one meant a
    // quoted fence could open but never close: the slice landed inside the `> `
    // prefix, the trailing-content test failed, and every later line stayed
    // classified as fenced — so prose after the quote was treated as literal
    // and a live mention passed.
    if (m) {
      const marker = m[1][0];
      const len = m[1].length;
      // A BACKTICK fence's info string may not itself contain a backtick —
      // CommonMark reserves that spelling so an inline code span cannot be
      // mistaken for a block opener. Accepting it here opened a fence that
      // never was, and every following line to the end of the file was then
      // classified as code: live prose below it read as literal and passed.
      // The same restriction does NOT apply to tilde fences, whose info
      // string is unrestricted.
      const infoHasBacktick =
        marker === '`' && containerBare.slice(m[0].length).includes('`');
      if (!openMarker && !infoHasBacktick) {
        openMarker = marker;
        openLen = len;
        openChain = chain;
        flags[i] = true;
        delimiter[i] = true;
        continue;
      }
      if (marker === openMarker && len >= openLen && !containerBare.slice(m[0].length).trim()) {
        openMarker = '';
        openLen = 0;
        flags[i] = true;
        delimiter[i] = true;
        continue;
      }
    }
    flags[i] = Boolean(openMarker);
  }
  return { inFence: flags, delimiter };
}

/** Byte offset → 0-based line index, via a prefix table built once per file. */
/**
 * Offsets at which each line begins.
 *
 * CR, LF and CRLF all end a line. Splitting on LF alone made a CR-only
 * document ONE logical line, so every blank-line boundary check saw no
 * paragraph breaks at all and two paragraphs fused into a mention no reader
 * sees. `lines` below splits by the same three, so the two stay in step —
 * which is the property every pass in this file has had to be taught.
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
 * Lines of context each side of a mention that feed the digest.
 *
 * The digest's job is to notice when an existing mention is REWRITTEN — a
 * retraction turned back into live guidance. An earlier version hashed a fixed
 * 40 normalized characters either side of the token, which was too tight to do
 * that job: in a typed-loader comment (a source file, in scope at the time),
 * flipping "were removed" to "remain deployed" and "no longer exist" to
 * "continue to exist" left both
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

  // NO early-return ON NUL BYTES. An earlier version bailed out on the first
  // NUL, which made a single NUL a COMPLETE bypass: a document with a live
  // deploy instruction plus one NUL was exempt from the gate entirely.
  // Normalization discards NUL along with every other non-alphanumeric byte,
  // so a stray one costs nothing and hides nothing.

  // CHEAP EXACT PRE-FILTER. Normalize without building the offset map and bail
  // if no token is present. Same normalization, so this is not a heuristic and
  // adds no bypass — it only skips the expensive per-character map build for
  // files that cannot match. It ignores `notFollowedBy` on purpose: a guarded
  // token still needs the full pass to decide, and this only short-circuits
  // files where NO token appears at all.
  //
  // It must use the SAME normalization as the real scan. It once called the
  // plain `normalize`, which is not tag-aware, so in Markdown it
  // short-circuited before the tag-aware pass could run — silently defeating
  // that fix. `withMap: false` is the same transform with no per-character
  // offset array: one implementation with the map made optional, rather than a
  // second normalizer that can drift from it. For plain text tag-skipping is a
  // no-op by definition, so the native regex gives a provably identical string
  // far faster than the per-character loop; Markdown takes the loop.
  const lines = text.split(/\r\n|\r|\n/);
  const starts = lineStarts(text);
  const { inFence, delimiter: fenceDelimiter } = computeFences(lines);
  // Fences, inline code spans, indented code blocks and inline HTML are
  // MARKDOWN constructs, and a plain-text file has none of them: a backtick or
  // an angle bracket in a `.txt` is just a character. `.mdc` and `.mdx` get the
  // fence, boundary and container treatment their `.md` sibling gets.
  const isMarkdown = MARKDOWN_EXTENSIONS.test(path);
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
    if (!isMarkdown) return [];
    const spans = [];
    // Delimiter runs must match EXACTLY, per Markdown. A bare backreference
    // lets a two-backtick opener close against the first two of a THREE-
    // backtick run, so ``…``` was read as one code span, the whole sentence
    // was treated as a literal region, and the `<strong>` tags inside it were
    // preserved instead of stripped — the words never fused and the gate
    // stayed green on text that renders the phrase plainly. The lookarounds
    // require the closing run to be a complete run of the same length: not
    // preceded by a backtick, not followed by one.
    // The backslash exclusion belongs to the OPENER only. In prose `\\`` is an
    // escaped backtick and cannot open a span; INSIDE a code span no escapes
    // are processed, so a delimiter run preceded by `\\` still closes it —
    // confirmed against the repository's micromark, where
    // `` `buy <foo>\\` `` renders `<foo>\\` as literal code. Rejecting that
    // closer left the span unrecognized, the `<foo>` inside it was stripped as
    // HTML, and a clean file was BLOCKED.
    const re = /(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g;
    let m;
    while ((m = re.exec(text))) {
      // The opener is escaped only when the backslash run before it is ODD.
      // `\\` is an escaped BACKSLASH, so the backtick after it is a live
      // opener — a lookbehind that rejects any backslash missed the span, and
      // the `<foo>` inside it was stripped as HTML on a clean file. Lookbehind
      // cannot count, so parity is checked here.
      let bs = 0;
      while (m.index - 1 - bs >= 0 && text[m.index - 1 - bs] === '\\') bs++;
      if (bs % 2 === 1) {
        // Rewind. The regex has already consumed everything through this
        // candidate's closing run — and that closer may itself be a LIVE
        // opener for the next span. Leaving `lastIndex` past it meant the real
        // span was never seen, its contents were stripped as HTML, and a clean
        // file was blocked. Resume one character after the ESCAPED opener so
        // every later delimiter is reconsidered.
        re.lastIndex = m.index + 1;
        continue;
      }
      // A backtick INSIDE a fence cannot open an inline span. Pairing across
      // the fence boundary let a stray backtick in a tilde-fenced block pair
      // with one in later prose, making the visible sentence between them
      // literal to the tag stripper — so its `<strong>` tags survived, the
      // words never fused, and the gate passed a rendered dead phrase.
      // BOTH delimiters must be outside a fence, and no fence may sit between
      // them. Checking only the opener still let prose pair with a backtick
      // inside a LATER fence — the same false span, approached from the other
      // side, which is what the opener-only version of this check missed.
      const endLine = lineOf(starts, m.index + m[0].length - 1);
      let crossesFence = false;
      for (let ln = lineOf(starts, m.index); ln <= endLine; ln++) {
        if (inFence[ln]) { crossesFence = true; break; }
      }
      if (crossesFence) continue;
      spans.push([m.index, m.index + m[0].length]);
    }
    return spans;
  })();
  /**
   * Markdown's THIRD code construct: a block indented four spaces (or a tab).
   *
   * The literal-region model covered fences and inline spans but not this one,
   * so a live runbook command written as an indented `cast call <buyAdapter>
   * "owner()"` had its placeholder removed as an HTML tag — the same real
   * mention deleted twice before, now via the one code form still unmodelled.
   *
   * CommonMark: indented code cannot interrupt a paragraph, so a line only
   * opens one when the last non-blank line above it is blank or is itself
   * indented code. That precondition is what keeps ordinary wrapped list
   * continuations — indented, but prose — out of the exemption.
   */
  const indentedCode = (() => {
    const flags = new Array(lines.length).fill(false);
    if (!isMarkdown) return flags;
    let prevBlank = true;
    // Width of the enclosing list item's content column, carried forward so a
    // continuation paragraph is measured from it rather than from column zero.
    let listIndent = 0;
    for (let i = 0; i < lines.length; i++) {
      // Container prefixes come off BEFORE anything is measured — both the
      // indentation and the blankness. A `>` line with nothing after it is a
      // blank line INSIDE the quote, and testing the raw line called it
      // non-blank, which broke the "preceded by a blank line" condition an
      // indented block needs.
      // Container prefixes come off BEFORE anything is measured — quote
      // markers AND list markers. Four spaces under a list item are the LIST's
      // indentation, not a code block's: `- Intro\n\n    Operators must…`
      // renders as an ordinary list paragraph, and marking it literal let its
      // `<strong>` survive as text and a live mention pass. Round 17 removed
      // the quote prefix and stopped there.
      //
      // The list marker's own width is what the continuation is measured
      // against, so it is consumed as part of the prefix rather than counted.
      let content = lines[i].replace(/^(?:[ \t]{0,3}>[ \t]?)+/, '');
      const listMarker = /^([ \t]{0,3})(?:[-*+]|\d{1,9}[.)])([ \t]+)/.exec(content);
      if (listMarker) content = content.slice(listMarker[0].length);
      else if (listIndent > 0) content = content.replace(new RegExp(`^ {0,${listIndent}}`), '');
      const blank = !content.trim();
      if (inFence[i]) {
        prevBlank = false;
        continue;
      }
      // An indented code block nested in a quote starts its SOURCE line with
      // `>`, so a raw four-space test never saw it, the scanner stripped the
      // literal `<strong>` inside it as markup, and a clean file was BLOCKED.
      // CommonMark removes the container prefix before parsing the block; so
      // does the `content` above.
      if (listMarker) listIndent = listMarker[0].length;
      else if (blank === false && !/^[ \t]/.test(lines[i])) listIndent = 0;
      if (!blank && /^(?: {4}|\t)/.test(content) && (prevBlank || flags[i - 1])) {
        flags[i] = true;
      } else if (blank && i > 0 && flags[i - 1]) {
        // A blank line inside an indented block does not close it; the next
        // indented line continues the same block.
        flags[i] = true;
      }
      prevBlank = blank;
    }
    return flags;
  })();
  const literalAt = (offset) => {
    if (!isMarkdown) return false;
    const line = lineOf(starts, offset);
    if (inFence[line] || indentedCode[line]) return true;
    // BINARY SEARCH, not `.some()`. This is called for every `<` and every `&`
    // in the file, and a linear scan of the span list made normalization
    // quadratic: on a document with 50k code spans and 50k ampersands the gate
    // went from ~11s to ~17.5s, and it grows from there. It blocks CI, so its
    // worst case is not a slow check — it is a timeout that reads to everyone
    // downstream as a broken gate. Spans are collected in ascending order and
    // never overlap, so the search is sound.
    let lo = 0;
    let hi = inlineCodeSpans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [a, b] = inlineCodeSpans[mid];
      if (offset < a) hi = mid - 1;
      else if (offset >= b) lo = mid + 1;
      else return true;
    }
    return false;
  };

  const cheap = (() => {
    // Plain text takes the native regex: the per-character loop does nothing
    // extra there, so the two strings are identical. Whenever the loop learns
    // to render something, this condition has to let the affected format
    // reach it — a second implementation of the transform that silently stops
    // matching the first is the drift this pre-filter must not reintroduce.
    if (!MARKDOWN_EXTENSIONS.test(path)) return normalize(text);
    // The pre-filter must see everything the full scan can match, or it
    // short-circuits a file the scan would have flagged. Tag interiors are now
    // a second stream (see below), and a document that carries a dead
    // identifier ONLY inside tags — `<vpfi-buy-adapter>` as raw HTML in a document —
    // normalizes to the empty string here. Appending the tag texts can fuse
    // tokens across tags that the real scan would not, but a pre-filter may
    // only err toward doing MORE work: a false positive costs one file's scan,
    // a false negative is a silent miss.
    const { norm, tagSpans } = normalizeWithMap(text, path, false, literalAt);
    // Tag interiors go through the ENTITY-AWARE normalizer, not the plain
    // `normalize`. This is the cheap gate that decides whether a file gets the
    // detailed pass at all, so a blind spot here is not a slower scan — it is
    // a file never scanned. `data-operation="buyOpti&#111;ns"` normalized to
    // `buyopti111ns` here, matched no token, and the file was skipped before
    // the detailed pass could decode anything: the fix one layer down was
    // correct and unreachable.
    return (
      norm +
      tagSpans
        .map(([s, e]) => normalizeWithMap(text.slice(s, e), TAG_INTERIOR, false, null).norm)
        .join('')
    );
  })();
  if (!DEAD_TOKEN_RECORDS.some(({ token }) => cheap.includes(token))) {
    return { hits: 0, digest: '' };
  }

  const { norm, map, tagSpans } = normalizeWithMap(text, path, true, literalAt);
  /**
   * Is the suffix at normalized `end` part of the SAME WORD as what precedes it?
   *
   * True when the only characters between the token's last letter and the
   * suffix's last letter are `-` or `_`. See the `notFollowedBy` call site.
   */
  const joinedToSuffix = (map, end, suffixLength) => {
    if (map[end] === undefined || map[end + suffixLength - 1] === undefined) return false;
    // `renderRefs` + `identifierSpanEnd` for the SAME reason `isIdentifierSpan`
    // below uses them, and this is the one place that reasoning had not reached:
    // the normalizer decodes character references but records offsets pointing
    // at the reference's `&`, so a raw slice sees the SOURCE spelling. In
    // `fixed-rate-buy&#98;ack` the normalized stream reads `buyback`, so the
    // suffix matches — but the raw slice held `&`, `#` and `;`, failed the
    // identifier test, and the guard did not apply. The gate then reported a
    // live treasury-buyback sentence as removed-surface residue. Every check
    // that decides what a word IS has to read the rendered stream.
    // …and the recognized TAGS have to come out for the same reason, which is
    // the one direction that reasoning still had not reached. `The treasury
    // uses a fixed-rate buy<strong>back</strong> auction` normalizes to
    // `fixedratebuyback`, so the surviving-feature guard should fire — but the
    // raw gap held `</strong><strong>`, failed the intra-word test, and the
    // gate reported LIVE treasury-buyback prose as excision residue. That is
    // the exact false positive the `notFollowedBy` guard exists to prevent,
    // reached through formatting instead of through an entity.
    const readGap = (from, to) =>
      renderRefs(
        MARKDOWN_EXTENSIONS.test(path) && !literalAt(from)
          ? stripRecognizedTags(from, to)
          : text.slice(from, to),
      );
    // A BLOCK tag in the gap is not inline formatting and must not be removed
    // here. `<p>…fixed-rate buy</p><p>Back up config…</p>` is two paragraphs:
    // the first names the removed surface as live and the second starts a new
    // sentence, so treating `back` as the surviving-feature suffix suppressed a
    // real hit before `crossesBlockBoundary` ever saw it. The tag strip that
    // fixed the inline case had to keep this distinction, which is the same one
    // `crossesBlockBoundary` itself draws.
    if (
      MARKDOWN_EXTENSIONS.test(path) &&
      !literalAt(map[end - 1] + 1) &&
      /<\s*\/?\s*(?:hr|p|div|section|article|aside|nav|main|header|footer|figure|figcaption|blockquote|pre|table|thead|tbody|tr|td|th|ul|ol|li|dl|dt|dd|h[1-6]|form|fieldset|details|summary|address)\b/i.test(
        text.slice(map[end - 1] + 1, map[end]),
      )
    )
      return false;
    const gap = readGap(map[end - 1] + 1, map[end]);
    if (!/^[-_]*$/.test(gap)) return false;
    return /^[A-Za-z0-9_-]+$/.test(
      readGap(map[end], identifierSpanEnd(map[end + suffixLength - 1])),
    );
  };

  /**
   * Is the SOURCE span behind normalized positions a..b a single identifier —
   * one word, separated at most by `_` or `-`?
   *
   * Used by `identifierOnly` tokens: the two generic English bigrams, which are
   * the only names here ordinary prose can spell by accident.
   */
  /**
   * Source text for [from,to) with the markup the NORMALIZER recognized removed.
   *
   * Never re-parses. Two rounds proved re-parsing is the wrong tool here, from
   * opposite directions: a `[^<>]*` regex stops at the `>` inside
   * `<span title="1 > 0">` and leaves markup behind (false negative), while
   * iterating that regex to a fixed point splices leftover fragments into tags
   * that were never in the document — `buyOpti<o<strong>></strong>ns` becomes
   * identifier-shaped and a clean file fails (false positive). Reusing
   * `tagSpans`, which the normalizer already computed with a quote-aware
   * scanner, makes this pass agree with the rendered stream by construction
   * rather than by a second implementation that has to be kept in step.
   */
  /**
   * Index of the first tag span that could intersect `from`.
   *
   * Binary search, not a scan from zero. `tagSpans` is sorted, and restarting
   * at its head for every candidate made the pass QUADRATIC in a file that
   * alternates tags and dead names — 10,000 of each took a 15-second whole-tree
   * run to about 21 seconds, and this gate blocks every PR. Same lesson as the
   * destination memo and the link-opener walk: stop re-deriving what is already
   * known.
   */
  const firstSpanFrom = (from) => {
    let lo = 0;
    let hi = tagSpans.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tagSpans[mid][1] <= from) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const stripRecognizedTags = (from, to) => {
    let out = '';
    let at = from;
    for (let k = firstSpanFrom(from); k < tagSpans.length; k++) {
      const [s0, e0] = tagSpans[k];
      if (s0 >= to) break;
      if (s0 > at) out += text.slice(at, Math.min(s0, to));
      at = Math.max(at, Math.min(e0, to));
    }
    if (at < to) out += text.slice(at, to);
    return out;
  };

  const isIdentifierSpan = (map, a, b, inTagInterior = false) => {
    // `renderRefs` first: the normalizer decodes character references, but the
    // offsets it records all point at the reference's `&`, so this slice sees
    // the SOURCE spelling. `buyOpti&#111;ns` renders as the exact retired
    // identifier and must be caught, yet the raw slice contains `&`, `#` and
    // `;` and was rejected as non-identifier — the encoding silently bought an
    // exemption. Both this check and the boundary check below have to reason
    // about what the reader sees, which is what `renderRefs` produces.
    // Strip tags BEFORE decoding references, because `tagSpans` are offsets into
    // the source. Same reason the references are decoded at all: the normalizer
    // removes inline markup, so `buyOpti<strong>o</strong>ns` normalizes to the
    // exact retired identifier, and a pass that saw the raw `<`/`>` rejected it
    // — formatting buying the exemption the encoding used to. A block-level tag
    // inside the span is not silently fused: `crossesBlockBoundary` has already
    // rejected the match before this runs.
    const from = map[a];
    const to = identifierSpanEnd(map[b]);
    const seen = renderRefs(
      !inTagInterior && MARKDOWN_EXTENSIONS.test(path) && !literalAt(from)
        ? stripRecognizedTags(from, to)
        : text.slice(from, to),
    );
    return /^[A-Za-z0-9_-]+$/.test(seen);
  };


  /**
   * End offset (exclusive) for an identifier span whose LAST character may have
   * come from a character reference.
   *
   * Every decoded character maps to the reference's `&`, so `map[b] + 1` cuts
   * the slice one character into `&#115;` and leaves `renderRefs` nothing it
   * can decode — `buyOption&#115;` was rejected as a non-identifier and passed
   * clean, which is the same bypass as the previous round with the encoded
   * character moved to the end. Extend through the reference's `;` when one
   * starts exactly at that offset.
   */
  function identifierSpanEnd(lastOffset) {
    const ref = /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/.exec(
      text.slice(lastOffset, lastOffset + 40),
    );
    if (ref) return lastOffset + ref[0].length;
    return lastOffset + 1;
  }

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
   *   - a markdown list marker opening a line, in Markdown files and NOT
   *     inside a fenced block — the fence exemption is the fix for the rule
   *     that had been HARMFUL, silencing a real `the buy\n * adapter` mention
   *     pasted into a doc as a code sample
   *   - a fenced-block DELIMITER line — see below
   *
   * Newlines alone are never boundaries: a sentence wrapped as "the buy\n
   * adapter" across two lines is one phrase and a real mention.
   *
   * The structural rules apply to `.mdx` as well as `.md`. MDX is in
   * MARKDOWN_EXTENSIONS and is Markdown, but the flag here tested `.md` only, so
   * an `.mdx` document with "Decide what to buy" followed by a
   * `# Adapter selection follows` heading had no boundary between them and the
   * gate BLOCKED a clean file.
   */
  const crossesBlockBoundary = (map, a, b, inTagInterior = false) => {
    const from = map[a];
    const to = map[b];
    // Test the span with recognized tags REMOVED, matching what the normalizer
    // saw. Otherwise punctuation that exists only inside stripped markup —
    // the `:` in `<a href="https://…">` — rejects a token the tag-aware pass
    // correctly found, so the markup fix and the boundary rule disagreed about
    // the same text. Fenced spans keep their tags, because there the brackets
    // are literal.
    // Build the span from the SAME removals the normalizer made, rather than
    // re-deriving them from raw source. `tagSpans` already holds every range the
    // rendered stream dropped — quote-aware tags AND markdown link destinations —
    // so this pass and the stream agree by construction. Re-parsing here is what
    // let `<span title="1 > 0: yes">` leave `: yes"` behind and reject a real
    // match, and what left a link's URL punctuation sitting between two words
    // the reader sees side by side.
    // The tag-interior stream is, by definition, text INSIDE one recognized
    // tag. Removing `tagSpans` there deletes the candidate itself, and treating
    // the enclosing element as a block boundary rejects every match found in an
    // attribute — which silently switched off the attribute/component-name
    // scanning this stream exists for. `<div data-operation="buyOptions">` went
    // clean again exactly the way it did before that stream was restored.
    let span = inTagInterior ? text.slice(from, to + 1) : '';
    if (!inTagInterior) {
      let at = from;
      for (let k = firstSpanFrom(from); k < tagSpans.length; k++) {
        const [s0, e0] = tagSpans[k];
        if (s0 > to) break;
        if (s0 > at) span += text.slice(at, Math.min(s0, to + 1));
        // A BLOCK-level element still separates what the reader sees, so it is a
        // boundary rather than a removable span.
        if (/^<\s*\/?\s*(?:hr|p|div|section|article|aside|nav|main|header|footer|figure|figcaption|blockquote|pre|table|thead|tbody|tr|td|th|ul|ol|li|dl|dt|dd|h[1-6]|form|fieldset|details|summary|address)\b/i.test(text.slice(s0, e0)))
          return true;
        at = Math.max(at, Math.min(e0, to + 1));
      }
      if (at <= to) span += text.slice(at, to + 1);
    }
    // ATTRIBUTE VALUES ARE NOT SENTENCES. The tag-interior stream scans element
    // names and attribute values, which are configuration/source text — so the
    // prose punctuation rules below must not run on them. `data-operation=
    // "buy:adapter"` names the dead identifier exactly as `buy-adapter` does,
    // but the `:` read as a sentence boundary discarded the match while the
    // hyphenated spelling was caught. Exempting the stream from `tagSpans`
    // removal (the previous fix here) restored the candidate; this stops the
    // boundary rules from throwing it away one step later.
    if (inTagInterior) return false;

    if (MARKDOWN_EXTENSIONS.test(path) && !literalAt(from)) {
      // Comments FIRST and by the same rule as the normalizer, which now skips
      // them. Leaving them in re-broke the case they were skipped for: the `!`
      // in `<!--` is a sentence ender, so `buy <!-- note --> adapter` fused in
      // the stream and was then rejected here by punctuation that exists only
      // inside markup the reader never sees. The two passes have to agree
      // about what is on the page — the same disagreement, one construct over,
      // that the element-tag strip below was added to end.
      // BLOCK-LEVEL tags separate what a reader sees into different blocks, so
      // they are boundaries, not removable formatting. Stripping `<hr>` out of
      // `buy<hr>Adapter` fused two visibly separate thoughts into a mention
      // and failed a clean file — the same false-BLOCK direction as the YAML
      // regression, and the reason inline tags (`<strong>`, `<em>`, `<code>`)
      // must keep being stripped: those two cases pull opposite ways and the
      // tag handling had treated every element as the inline case.
      span = span.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
      // Blank QUOTED ATTRIBUTE VALUES before looking for block tags. The test
      // searches raw text, so `buy<span title="<hr>">adapter</span>` had the
      // `<hr>` inside the title attribute read as a real horizontal rule — an
      // inline span that renders the phrase continuously was treated as two
      // blocks and the mention was dropped. Attribute text is not markup.
      const forBlockTest = span.replace(/=\s*("[^"]*"|'[^']*')/g, '=""');
      if (/<\s*\/?\s*(?:hr|p|div|section|article|aside|nav|main|header|footer|figure|figcaption|blockquote|pre|table|thead|tbody|tr|td|th|ul|ol|li|dl|dt|dd|h[1-6]|form|fieldset|details|summary|address)\b[^<>]*>/i.test(forBlockTest))
        return true;
      span = span.replace(/<\/?[a-zA-Z][^<>]*>/g, ' ');
      // And character references, for the third time in the same shape: the
      // `;` that terminates `&nbsp;` is a sentence ender, so a span the
      // normalizer had correctly fused would be rejected here by punctuation
      // belonging to markup the reader never sees. Whenever the normalizer
      // learns to skip something, this must learn it in the same commit.
      //
      // DECODED, not blanked. Replacing every reference with a space was the
      // first attempt and it overshot: `&#46;` RENDERS as a full stop, so
      // blanking it deleted a real sentence boundary and fused two sentences
      // into a mention that no reader would see. The entity syntax is
      // invisible; the character it stands for is not.
      span = renderRefs(span);
    }
    // CJK terminators alongside their ASCII equivalents. A full-width `。`
    // ends a sentence exactly as `.` does — normalization drops it, so a
    // rendered "…buy。Adapter…" in a translated document would fuse into a
    // mention and block a clean file. Future-proofing rather than a live fix,
    // but it can only ever PREVENT a false block, never hide a mention.
    if (/[.!?;:|]/.test(span)) return true;
    if (/[。！？；：]/.test(span)) return true;
    // CR, LF and CRLF — a blank line is a blank line whatever ends it.
    if (/[\r\n][ \t]*[\r\n]/.test(span)) return true;
    const firstLine = lineOf(starts, from);
    const lastLine = lineOf(starts, to);
    // BOTH structural rules are markdown-only and fence-excluded. `#` and `*`
    // mean "new block" in Markdown and nothing in plain text, and applying the
    // heading rule outside Markdown once silenced a real wrapped mention in a
    // shell comment (code files were in scope then). Inside a fence they are
    // code, not structure.
    if (isMarkdown) {
      for (let i = firstLine + 1; i <= lastLine; i++) {
        // A fence delimiter is itself the boundary: the span jumped over a
        // code block. `inFence` marks delimiters, so this test has to come
        // BEFORE the skip below or an empty fenced block — whose two
        // delimiters are its only lines — would be invisible here and fuse
        // the prose either side of it into a mention that no reader sees.
        if (fenceDelimiter[i]) return true;
        if (inFence[i]) continue;
        // A BLANK QUOTED LINE is a paragraph break. `>` with nothing after it
        // ends the quote's paragraph exactly as an empty line ends an
        // unquoted one, but the blank-line test above works on the raw span
        // and `>` is not empty text, while the depth test below sees no
        // change. So two paragraphs inside one quote fused into a phrase no
        // reader sees — a false BLOCK on a clean document. Round 20 opened
        // this when it stopped treating every quoted line as a boundary; the
        // case had been covered by accident until then.
        if (quoteDepth(lines[i]) > 0 && stripContainers(lines[i]).trim() === '') return true;
        // `#` alone on a line is a valid EMPTY heading — micromark renders it
        // as `<h1></h1>` — so end-of-line closes the marker just as whitespace
        // does. Requiring whitespace missed it and fused the blocks either
        // side.
        if (/^\s{0,3}#{1,6}(\s|$)/.test(lines[i])) return true;
        // The ordered branch is deliberately left as `\d+`, not narrowed to
        // the CommonMark paragraph-interruption rule (`1.` only). Narrowing it
        // is unobservable here: any span crossing an ordered marker carries
        // the marker's DIGITS, and the normalizer keeps digits, so the span
        // reads `buy2adapter` and can never equal a dead token whatever this
        // rule decides. Verified, not assumed — the reported case is missed
        // identically with and without the narrowing.
        if (/^\s{0,3}(?:[-*+]\s|\d+[.)]\s)/.test(lines[i])) return true;
        // Blockquote marker. Markdown renders `> …` as its own quote block, so
        // the line before it and the line after it are not one sentence — but
        // only headings and list markers were recognized, so a sentence ending
        // at a quote fused with the quote's first words and failed a clean
        // file. Same class as the heading and list rules: an explicit block
        // delimiter, not a guess about English.
        // …but only when it ENTERS or LEAVES the quote. A phrase wrapping
        // across consecutive quoted lines is ONE rendered paragraph — every
        // continuation begins with `>` and none of them starts a new block —
        // so treating each marker as a boundary meant a live mention could
        // hide simply by being wrapped inside a quote.
        {
          const quoted = quoteDepth(lines[i]);
          const prevQuoted = quoteDepth(lines[i - 1] ?? '');
          // ENTERING a quote is a boundary. LEAVING one is only a boundary if
          // the line is genuinely outside the paragraph: CommonMark allows a
          // LAZY CONTINUATION, where a wrapped paragraph's later lines drop the
          // `>` and remain the same block. Round 20 fixed the continuation case
          // INSIDE the quote and opened this one on the way out — treating the
          // marker's disappearance as a break let the same wrapped phrase hide
          // by starting inside a quote and finishing outside it.
          //
          // DEPTH, not a boolean. Collapsing every nonzero depth into "quoted"
          // made `>` → `>>` a continuation, so two fragments in different
          // nested quote blocks fused into a phrase no reader sees — the
          // false-BLOCK direction, on a document that is clean. The lazy
          // exception applies only to an actual drop to zero: a lazy
          // continuation is a paragraph line with NO marker at all, so a
          // change between two nonzero depths is always a real block change.
          const lazy = prevQuoted > 0 && quoted === 0 && lines[i].trim() !== '';
          if (quoted !== prevQuoted && !lazy) return true;
        }
        // Thematic breaks — `***`, `---`, `___`, optionally spaced. A reader
        // sees a horizontal rule dividing two blocks; the walk saw nothing and
        // fused the sentence before it with the one after. Note the overlap
        // with the Setext rule above: a `---` line is a heading underline when
        // text sits directly above it and a thematic break otherwise, so the
        // Setext check runs FIRST and this only sees the leftovers.
        if (/^\s{0,3}(?:\*[ \t]*){3,}$|^\s{0,3}(?:-[ \t]*){3,}$|^\s{0,3}(?:_[ \t]*){3,}$/.test(lines[i]))
          return true;
        // A `===` Setext underline makes the line above it an `<h1>`, so it
        // separates two blocks exactly as an ATX heading does. The `---` form
        // was covered only by ACCIDENT, through the thematic-break rule above;
        // the level-one form matches nothing there and fused the paragraphs
        // either side of a heading, blocking a clean document.
        // ONE `=` is a valid underline — CommonMark says "one or more". The
        // `-` form is deliberately NOT relaxed here: a lone `-` also spells an
        // empty list item, and resolving that needs to know whether the line
        // above is a paragraph or a list item, which this line-local test
        // cannot see. Half the finding, with the ambiguous half on #1758.
        if (/^\s{0,3}={1,}\s*$/.test(lines[i])) return true;
      }
    }
    return false;
  };

  /**
   * Find every dead token in one normalized stream, as SOURCE intervals.
   *
   * Source rather than normalized offsets, because there are now TWO streams —
   * the document with its markup removed, and the markup itself — and their
   * normalized coordinates are unrelated. The source text is the one frame
   * both can be expressed in, so it is the one the dedupe below works in.
   */
  // `inTagInterior` — the second stream scans the INSIDE of a recognized tag,
  // where the match legitimately sits within a `tagSpans` entry. Stripping
  // recognized tags there deletes the candidate itself, which silently undid
  // the attribute/component-name scanning this stream exists for.
  const collectMatches = (norm, map, inTagInterior = false) => {
    const found = [];
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
            joinedToSuffix(map, end, suffix.length),
        );
        if (skip) continue;
        if (identifierOnly && !isIdentifierSpan(map, at, end - 1, inTagInterior))
          continue;
        if (crossesBlockBoundary(map, at, end - 1, inTagInterior)) continue;
        found.push({ start: map[at], end: map[end - 1] + 1 });
      }
    }
    return found;
  };

  const matches = collectMatches(norm, map);

  // Second stream: the INSIDE of each recognized tag.
  //
  // Stripping a tag removes its element name and attributes along with its
  // brackets, and those are executable source, not rendered decoration. An
  // HTML file containing `<vpfi-buy-adapter></vpfi-buy-adapter>` passed
  // cleanly because both occurrences were deleted before matching; the same
  // holds for a JSX component name or an attribute configuring a removed
  // endpoint. The tag has to keep being removed from the DOCUMENT stream —
  // that removal is what lets `the <strong>buy</strong> adapter` fuse into the
  // phrase a reader sees — so its contents are scanned separately instead,
  // one tag at a time so nothing fuses ACROSS a tag boundary either.
  for (const [s, e] of tagSpans) {
    const { norm: tagNorm, map: tagMap } = normalizeWithMap(text.slice(s, e), TAG_INTERIOR, true, null);
    for (const m of collectMatches(
      tagNorm,
      tagMap.map((o) => o + s),
      true,
    )) {
      matches.push(m);
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
      // Container prefixes come off first, exactly as they do for the literal
      // and boundary passes. A heading inside a BLOCK QUOTE begins its source
      // line with `>`, so a raw-line test never saw it — and that is the same
      // silent-substitution bypass this ancestry hash exists to close: retitle
      // `> ## Historical procedure` to `> ## Current procedure` above an
      // untouched quoted mention and neither the count nor the digest moves.
      // Quote markers AND list markers. `- ## Historical procedure` is a
      // heading inside a list item, and leaving the `-` on kept it invisible to
      // this walk — the same silent-substitution bypass the quote fix closed,
      // one container over. Written as a loop because the two nest.
      const bare = stripContainers(lines[i]);
      const atx = /^\s{0,3}(#{1,6})(?:\s|$)/.exec(bare);
      const bold = /^\s{0,3}\*\*[^*]+\*\*/.test(bare);
      // Setext headings — a line of text UNDERLINED by `===` or `---` — are
      // headings too, and were invisible here. That let the governing status
      // be rewritten without moving the digest: retitle `Historical guidance`
      // to `Current guidance` above an untouched `---`, and the mention below
      // silently changes from a record to an instruction. Exactly the
      // substitution this ancestry hash exists to catch, in the one heading
      // syntax it did not recognize. `===` is level 1, `---` level 2, per
      // Markdown. The underline must not itself be a list marker or a thematic
      // break with spaces, so require a run of three or more.
      // MARKDOWN ONLY. Without this guard the rule fired on every extension,
      // and a `---` line in plain text (YAML was in scope then, where it
      // separates documents) was read as a level-2 heading governing a mention
      // further down the file, so editing an unrelated earlier line moved the
      // digest. That direction is worse than the miss it fixes: a false BLOCK
      // on an ordinary edit trains people to re-pin without reading, which is
      // the one habit that would make this whole gate worthless.
      // The SAME container stripping the heading text gets — looped, because
      // quotes and list markers nest. A Setext heading nested two list levels
      // deep has an underline behind two containers, and a single pass did not
      // reach it, so the heading was classified and its underline was not.
      const underBare = stripContainers(i + 1 < lines.length ? lines[i + 1] : '');
      // What remains after the containers come off is CONTENT indentation, and
      // Markdown caps a Setext underline at three spaces of it. An unbounded
      // `^\s*` here accepted any depth, which made a `---` indented four or
      // more spaces below a line of prose — a paragraph continuation, or a
      // fragment of an indented code block — read as a heading underline. That
      // is the false-BLOCK direction: an unrelated documentation edit above
      // such a line moved the ancestry hash and failed the gate. The allowance
      // is measured from the heading's CONTENT COLUMN rather than from column
      // zero, so a heading nested inside a list keeps its underline while a
      // top-level one gets the plain three-space limit.
      //
      // The content column is what the containers consumed plus whatever
      // indentation survives them — NOT the raw line's leading whitespace,
      // which is zero for `- - Historical procedure` even though its content
      // sits in column four. Measuring the raw line rejected exactly the
      // nested underline the previous round had been asked to accept: I
      // narrowed the unbounded case and reopened the bounded one in the same
      // edit, which is the shape of half the defects on this PR.
      const headIndent = contentColumn(lines[i]);
      const underMatch =
        isMarkdown && i + 1 < lines.length && !inFence[i + 1] && bare.trim() !== ''
          ? /^([ \t]*)(?:(=)={0,}|(-)--+)[ \t]*$/.exec(underBare)
          : null;
      const setext = underMatch && underMatch[1].length <= headIndent + 3 ? underMatch : null;
      if (!atx && !bold && !setext) continue;
      // A `**Bold lead-in**` sits below any ATX heading; level 7 orders it so.
      // A Setext heading takes the ATX level its underline corresponds to, so
      // the two syntaxes interleave in one ancestry rather than forming
      // separate ladders.
      // Group 2 is the `=` form (one or more, per CommonMark), group 3 the
      // `-` form — still held at three or more, because a lone `-` also
      // spells an empty list item and telling the two apart needs the block
      // context this walk does not carry. See #1758.
      const level = atx ? atx[1].length : setext ? (setext[2] ? 1 : 2) : 7;
      if (level >= deepest) continue;
      deepest = level;
      // The PREFIX-STRIPPED text, so `> ## Current` and `## Current` hash the
      // same. What governs the mention is the heading, not the container it
      // happens to sit in.
      chain.push(bare);
      if (level === 1) break;
    }
    return chain.reverse().join(' ');
  };

  const units = kept
    .map(({ start, end }) => {
      // `start` / `end` are SOURCE offsets — see collectMatches.
      const startLine = lineOf(starts, start);
      const first = Math.max(0, startLine - DIGEST_CONTEXT_LINES);
      const last = Math.min(
        lines.length - 1,
        lineOf(starts, end - 1) + DIGEST_CONTEXT_LINES,
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

  // JSON, not `join('|')`. Joining with a bare pipe is not injective over
  // contexts that may THEMSELVES contain pipes — and raw Markdown context
  // routinely does, every table row being a line of them. `['a', 'b|c']` and
  // `['a|b', 'c']` hash identically, so an equal-count edit that moves text
  // across that boundary leaves the digest unmoved and walks past the
  // substitution guard, with no SHA collision required. `JSON.stringify`
  // escapes and length-delimits each unit, so distinct unit arrays give
  // distinct inputs.
  //
  // This re-pins every digest in the ledger — counts are untouched, and no
  // mention text changed.
  const digest = units.length
    ? createHash('sha256').update(JSON.stringify(units)).digest('hex').slice(0, 12)
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
