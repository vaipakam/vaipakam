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
import { inflateSync } from 'node:zlib';

/**
 * Signature test for formats whose bytes are not prose in any sense.
 *
 * RASTER IMAGES AND FONTS ONLY. `%PDF` and the ZIP container behind
 * docx/xlsx were briefly here and are NOT: those are DOCUMENTS, carrying the
 * operator- and user-facing guidance this gate exists to police, and this repo
 * tracks PDFs today (the OpenZeppelin audit reports). Exempting them opened a
 * hole a PDF runbook could walk through — a live "deploy the buy adapter"
 * instruction in one was caught before that change and passed after it. A
 * format earns a place here only if NOTHING a reader sees can be recovered
 * from its bytes; where text is merely encoded rather than absent, the answer
 * is to extract it, not to skip the file.
 *
 * Reads the first bytes rather than trusting the extension, and is NOT the
 * retired "any NUL means binary" rule — that one let a document exempt itself
 * from this gate with a single stray byte.
 */
const BINARY_SIGNATURES = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF8
  [0x77, 0x4f, 0x46, 0x46], // wOFF
  [0x77, 0x4f, 0x46, 0x32], // wOF2
];
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
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '', zwj: '', zwnj: '',
  period: '.', full: '.', excl: '!', quest: '?', semi: ';', colon: ':',
  comma: ',', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', sol: '/', bsol: '\\',
  ndash: '-', mdash: '-', hyphen: '-', bull: '*', middot: '*',
};
const renderRefs = (s) =>
  s.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g,
    (_m, dec, hex, name) => {
      if (dec !== undefined || hex !== undefined) {
        const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : '';
      }
      return Object.prototype.hasOwnProperty.call(NAMED_REFS, name.toLowerCase())
        ? NAMED_REFS[name.toLowerCase()]
        : '';
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
  [".github/scripts/README.md", [2, "TOOLING — documents this gate and quotes the dead names as examples", "5d7c21a1ff7a"]],
  [".github/scripts/check-excision-residue.selftest.mjs", [5, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "e9a7f28bcb80"]],
  ["AGENTS.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "79390720e2fe"]],
  ["CLAUDE.md", [13, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "3edc0988a8d9"]],
  ["SECURITY.md", [7, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "09e46e416b30"]],
  ["apps/agent/README.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "0ef57050c5e9"]],
  ["apps/agent/src/env.ts", [5, "RETRACTION — the RPC-breadth note explaining #687-A removed the watchdog that justified it", "8f35eec08f83"]],
  ["apps/agent/src/index.ts", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "09f233130776"]],
  ["apps/agent/wrangler.jsonc", [3, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "16989d142f84"]],
  ["apps/defi/src/App.tsx", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "92806307bc51"]],
  ["apps/defi/src/contracts/config.ts", [3, "RETRACTION — removed-key notes on the deployment config shape", "604f8b92d10a"]],
  ["apps/defi/src/hooks/useAdminKnobValues.ts", [1, "RETRACTION — notes the standalone receiver is gone and knobs moved", "ab0d7d7351d4"]],
  ["apps/defi/src/hooks/useTimelockPendingChanges.ts", [1, "RETRACTION — replaces a receiver-specific skip that no longer applies", "9d0dfae177a2"]],
  ["apps/defi/src/i18n/glossary.ts", [2, "HISTORICAL — do-not-translate entry retained for historical copy", "d6f75676c2c4"]],
  ["apps/defi/src/lib/logIndex.ts", [3, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "84abd6ec14c8"]],
  ["apps/defi/src/pages/AdminDashboard.tsx", [1, "RETRACTION — notes why the mirror-chain receiver knobs are gone", "233ed60a2fbe"]],
  ["apps/indexer/migrations/0024_purge_retired_vpfi_events.sql", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "d8782675d6b1"]],
  ["apps/www/src/content/whitepaper/Whitepaper.en.md", [3, "LIVE-TEXT — user-facing; verify against the §8 supersede banner before raising", "a5e91edf7614"]],
  ["apps/www/src/pages/BuyVPFIMarketing.tsx", [1, "LIVE-TEXT — user-facing marketing surface; the most legally sensitive entry here", "b59bd95c0660"]],
  ["contracts/.env.example", [3, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "dfa880f61164"]],
  ["contracts/.gas-snapshot", [17, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "cd5853c00406"]],
  ["contracts/RUNBOOK.md", [18, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "2c1b9d4c142c"]],
  ["contracts/deployments/CCIP-INFRA-ADDRESSES.md", [4, "HISTORICAL — deployed-address record", "673eeaa8357a"]],
  ["contracts/foundry.toml", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "f4c66b17ce66"]],
  ["contracts/script/AnvilNewPositiveFlows.s.sol", [1, "RETRACTION — removed-step note", "05abc1c31c8e"]],
  ["contracts/script/ConfigureCcip.s.sol", [3, "RETRACTION — removed-step note", "3e71b78fbcf8"]],
  ["contracts/script/DeployCrosschain.s.sol", [6, "RETRACTION — removed-deploy-target notes", "40a135c2bf8f"]],
  ["contracts/script/DeployDiamond.s.sol", [8, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "478444039e75"]],
  ["contracts/script/Handover.s.sol", [2, "RETRACTION — removed-ownership-target note", "d09e23b3cc9c"]],
  ["contracts/script/SetInteractionLaunch.s.sol", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "b52d6cd78b2d"]],
  ["contracts/script/deploy-chain.sh", [5, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "53cdc742fba2"]],
  ["contracts/script/deploy-mainnet.sh", [5, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "2da387e0242c"]],
  ["contracts/script/deploy-testnet.sh", [6, "RETRACTION — removed-step note", "f55404938701"]],
  ["contracts/script/lint-event-categories.js", [2, "RETRACTION — removed-event note", "e20e16731165"]],
  ["contracts/script/predeploy-check.sh", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "83ef9c13d3f3"]],
  ["contracts/src/crosschain/CcipMessenger.sol", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "8b891b7af78f"]],
  ["contracts/src/crosschain/GuardianPausable.sol", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "c3fcb0bba813"]],
  ["contracts/src/crosschain/ICrossChainMessenger.sol", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "c013114dcc36"]],
  ["contracts/src/facets/OracleAdminFacet.sol", [2, "RETRACTION — #1726 corrected the natspec that cited the adapter as a safety enforcer", "939a20d446da"]],
  ["contracts/src/facets/VPFIDiscountFacet.sol", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "cb58d1ed5076"]],
  ["contracts/src/interfaces/IVaipakamErrors.sol", [3, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "115f722e4422"]],
  ["contracts/src/libraries/LibKeeperReward.sol", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "486f15068cdb"]],
  ["contracts/src/libraries/LibVaipakam.sol", [2, "RETRACTION — replaces the dangling storage-struct header that labelled sequencer slots", "1819ae773c70"]],
  ["contracts/test/CcipDeploymentRehearsalTest.t.sol", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "8ec41b19f570"]],
  ["contracts/test/mocks/MockCrossChainMessenger.sol", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "54536afa88ba"]],
  ["docs/DesignsAndPlans/BorrowerPlatformFeeResearch.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "0b2df05b7d0a"]],
  ["docs/DesignsAndPlans/CloudflareStagingDeployPlan.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "076e023c2c47"]],
  ["docs/DesignsAndPlans/CrossChainRewardSystem.md", [8, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "db8ac858db48"]],
  ["docs/DesignsAndPlans/DecentralizedPlatformArchitecture.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "c9a9c8c91d2e"]],
  ["docs/DesignsAndPlans/EventSourcingAudit.md", [14, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "b2356be9cbf0"]],
  ["docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md", [31, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "6e989a58d349"]],
  ["docs/DesignsAndPlans/OfferFillModesDesign.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "d1f7403606be"]],
  ["docs/DesignsAndPlans/OssificationRoadmap.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "82079362333a"]],
  ["docs/DesignsAndPlans/Research-404-OssificationRoadmap.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "19f52bf4b075"]],
  ["docs/DesignsAndPlans/Stage3WorkerSplitPlan.md", [5, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "a5754fbe447c"]],
  ["docs/DesignsAndPlans/TreasuryBuyback.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "866f16a74d4e"]],
  ["docs/DesignsAndPlans/VPFITokenomicsRedesignResearch.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "7f0a68b88a8c"]],
  ["docs/FunctionalSpecs/ProjectDetailsREADME.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "f83fcfb6b2ad"]],
  ["docs/FunctionalSpecs/README.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "242c30f2f5e3"]],
  ["docs/FunctionalSpecs/TokenomicsTechSpec.md", [2, "RETRACTION — the §8 supersede banner", "6cc03561eae9"]],
  ["docs/GLOSSARY.md", [6, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "857792c509dd"]],
  ["docs/ReleaseNotes/unreleased/1651-excision-residue-ratchet.md", [1, "RETRACTION — this gate's own fragment, quoting the dead phrase as the example of what now fails", "fba24ce27446"]],
  ["docs/ReleaseNotes/unreleased/1672-layerzero-residue-removal.md", [3, "RETRACTION — describes text that WRONGLY implied the surface was live, and its removal", "a49a87d89dbb"]],
  ["docs/TestScopes/AdvancedUserGuideTestMatrix.md", [3, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "83bed4aa55e1"]],
  ["docs/ToDo.md", [31, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "065b1272f94c"]],
  ["docs/internal/ContractFollowupsFromRehearsal-2026-05-06.md", [10, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "c1d15d0eef44"]],
  ["docs/internal/DeployOnTestnet.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "55563580671a"]],
  ["docs/internal/Issue687A-FrontendExcisionScout.md", [16, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "5e5014a10efb"]],
  ["docs/internal/PendingTasks-2026-05-14.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "60d70d431e51"]],
  ["docs/internal/RiskCommitteeSignOffQuestionnaire.md", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "48e800ec4569"]],
  ["docs/internal/SecurityScanQuestionnaire.md", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "316ee7c95853"]],
  ["docs/internal/WethChainSafetyAudit-2026-05-14.md", [16, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "52844cf3a903"]],
  ["docs/internal/batch5-unsafe-typecast-triage.csv", [2, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "023e9b4fd22a"]],
  ["docs/ops/AnalyticsLabelRegistration.md", [3, "HISTORICAL — label registry rows", "0284187b3cbb"]],
  ["docs/ops/BNBTestnetDeploy.md", [24, "LIVE-TEXT — known debt; largest unswept operator runbook after DeploymentRunbook", "c86fd4428005"]],
  ["docs/ops/BaseSepoliaDeploy.md", [26, "LIVE-TEXT — known debt", "64debf6185f2"]],
  ["docs/ops/CcipCutoverRunbook.md", [6, "RETRACTION — #1719 swept the dead steps and left the notes", "ab9aa52ffbe1"]],
  ["docs/ops/ChainByChainChecks.md", [6, "LIVE-TEXT — known debt", "874f9b73f212"]],
  ["docs/ops/DeploymentRunbook.md", [47, "LIVE-TEXT — known debt; §\"VPFIBuyAdapter — payment-token mode\" still carries an actionable pre-flight checklist under a Historical banner", "07fef3834731"]],
  ["docs/ops/IncidentRunbook.md", [4, "HISTORICAL — past-incident record", "f83457ef2f6e"]],
  ["docs/ops/VPFITokenRotationRunbook.md", [1, "HISTORICAL — rotation-scope note", "7fe351cf758b"]],
  ["docs/ops/tenderly-paste/Diamond-full.json", [45, "HISTORICAL — a captured ABI artifact; regenerate rather than hand-edit", "9256252cfcc1"]],
  ["ops/offchain-data-warm/wrangler.jsonc", [1, "RETRACTION — notes the excised surface in a coverage comment", "5f91cb0ab0b5"]],
  ["ops/subgraph/abis/Diamond.json", [24, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "af0f882df245"]],
  ["packages/contracts/src/abis/AddCollateralFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/AdminFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/ClaimFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/ConsolidationFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/DefaultedFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/EarlyWithdrawalFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/FeeEntitlementFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/InteractionRewardsFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/LoanFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/NFTPrepayDutchListingFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/NFTPrepayListingFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/OfferAcceptFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/OfferCancelFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/OfferCreateFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/OfferMutateFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/OfferParallelSaleFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/OracleFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/PartialWithdrawalFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/PayrollFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/PrecloseFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/PrepayListingFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/ProfileFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/RefinanceFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/RepayFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/RepayPeriodicFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/RewardAggregatorFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/RewardClaimFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/RewardCommitmentFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/RewardCompensationDispatchFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/RewardRemittanceFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/RewardReporterFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/RiskFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/RiskSplitLiquidationFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/SwapToRepayFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/SwapToRepayIntentFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/TreasuryFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/VPFIDiscountFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/VPFITokenFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/VaultFactoryFacet.json", [1, "UNTRIAGED (#1728) — admitted by a widened scope; classify on first movement", "815e05cffa32"]],
  ["packages/contracts/src/abis/index.ts", [2, "RETRACTION — removed-ABI notes in the barrel", "4358e3667e43"]],
  ["packages/contracts/src/chain-config.ts", [2, "RETRACTION — removed-key note", "b0b59696db74"]],
  ["packages/contracts/src/deployments.ts", [1, "RETRACTION — removed-key note on the typed loader", "4dac8a4cde88"]],
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
  // ACTIVE TOOLING, not a dated record. The directory exclusion exists because
  // an assembled note is history; `assemble.sh` is a script an operator runs
  // today, and a live instruction added to it would have been exempt purely
  // because of where it sits.
  'docs/ReleaseNotes/assemble.sh',
];

function isExcluded(file) {
  if (EXCLUSION_CARVEOUTS.some((p) => file.startsWith(p))) return false;
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
  const skipTags = MARKUP_EXTENSIONS.test(sourcePath || '');
  const isMdSource = /\.mdx?$/i.test(sourcePath || '');
  const isJsonSource = /\.jsonc?$/i.test(sourcePath || '');
  const decodeRefs = skipTags || sourcePath === TAG_INTERIOR;
  const TAG = /^<\/?[a-zA-Z][^<>]*>/;
  const tagSpans = [];
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
      !(fencedOffsets && fencedOffsets(i))
    ) {
      const open = text[i + 1];
      const close = open === '(' ? ')' : ']';
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === open) depth++;
        else if (text[j] === close) {
          depth--;
          if (depth === 0) break;
        } else if (text[j] === '\n' && text[j + 1] === '\n') break; // unterminated
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
    // JSON STRING ESCAPES. `{"operatorMessage":"Deploy the buy\u0020adapter"}`
    // renders as one phrase naming the dead surface, but the raw source spells
    // the space as the letters `u0020`, which the normalizer kept — wedging
    // text between the words instead of separating them. Decode to what the
    // consumer sees; a non-\u escape emits nothing, which separates rather than
    // joins, the conservative direction.
    if (isJsonSource && text[i] === '\\' && i + 1 < text.length) {
      const u = /^\\u([0-9a-fA-F]{4})/.exec(text.slice(i, i + 6));
      if (u) {
        for (const c of String.fromCharCode(parseInt(u[1], 16)).toLowerCase()) {
          if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
            out.push(c);
            if (withMap) map.push(i);
          }
        }
        i += 5;
        continue;
      }
      i += 1;
      continue;
    }
    if (skipTags && text[i] === '<' && !(fencedOffsets && fencedOffsets(i))) {
      // HTML comments FIRST — they are invisible markup too, and the tag shape
      // below does not recognize them (`!` is not a letter). A reader of
      // `deploy the buy <!-- note --> adapter` sees one phrase; leaving the
      // comment in the stream kept the two words from fusing and the gate
      // green. Invisible-to-the-reader is the property that matters here, not
      // element-shaped.
      if (text.startsWith('<!--', i)) {
        const close = text.indexOf('-->', i + 4);
        // An unterminated comment swallows the rest of the file in a real
        // renderer; do the same rather than resuming mid-comment.
        const stop = close === -1 ? text.length : close + 3;
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
      if (/^<\/?[a-zA-Z]/.test(text.slice(i, i + 3))) {
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
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (m) {
      const marker = m[1][0];
      const len = m[1].length;
      if (!openMarker) {
        openMarker = marker;
        openLen = len;
        flags[i] = true;
        delimiter[i] = true;
        continue;
      }
      if (marker === openMarker && len >= openLen && !lines[i].slice(m[0].length).trim()) {
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
/**
 * Reader-visible text from a PDF.
 *
 * Removing the `%PDF` exemption made PDFs *look* covered while only
 * uncompressed content was ever readable: real PDFs Flate-compress their
 * content streams, so a runbook whose page says "deploy the buy adapter"
 * decoded, as UTF-8, to compressed bytes with no such phrase in them. The gate
 * reported success on a document that plainly names a removed surface.
 *
 * Inflates each `/FlateDecode` stream and keeps the string literals a page
 * actually draws — `(...)` for literal strings, `<...>` for hex ones. The
 * drawing OPERATORS around them are dropped: `BT`, `Tj`, `ET` and friends are
 * not words a reader sees, and letting them into the stream would fuse them
 * with real text and manufacture matches.
 *
 * Best-effort by design. A stream that will not inflate is skipped rather than
 * failing the run — a damaged or unusually-encoded PDF must not take CI down —
 * and object streams / non-Flate filters are not decoded, so this raises
 * coverage without claiming to be a PDF parser. See #1734 for the standing
 * question of whether this gate should target prose only.
 */
/** Per-stream inflation budget. Generous for real page text, far below what a
 *  decompression bomb needs to exhaust a runner. */
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;

function extractPdfText(buf) {
  const out = [];
  const marker = Buffer.from('stream');
  const endMarker = Buffer.from('endstream');
  let at = 0;
  while (at < buf.length) {
    const s0 = buf.indexOf(marker, at);
    if (s0 === -1) break;
    const e0 = buf.indexOf(endMarker, s0);
    if (e0 === -1) break;
    // Dictionary immediately before the stream keyword declares the filter.
    const dict = buf.subarray(Math.max(0, s0 - 400), s0).toString('latin1');
    let body = buf.subarray(s0 + marker.length, e0);
    // Skip the EOL that must follow the `stream` keyword.
    let b = 0;
    while (b < body.length && (body[b] === 0x0d || body[b] === 0x0a)) b++;
    body = body.subarray(b);
    if (/\/FlateDecode/.test(dict)) {
      try {
        // BOUNDED. `inflateSync` with no limit lets a small, highly compressible
        // stream expand without end — a few KB of tracked PDF could allocate
        // hundreds of megabytes and kill the runner, taking a BLOCKING workflow
        // down rather than taking the best-effort skip this path intends. Node
        // rejects the stream once it exceeds the budget, which lands in the
        // catch below like any other undecodable stream.
        body = inflateSync(body, { maxOutputLength: MAX_INFLATED_BYTES });
      } catch {
        at = e0 + endMarker.length;
        continue;
      }
    }
    const content = body.toString('latin1');
    for (const m of content.matchAll(/\(((?:\\.|[^\\)])*)\)/g)) out.push(m[1]);
    for (const m of content.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
      const hex = m[1].replace(/\s+/g, '');
      if (hex.length % 2 === 0 && hex.length >= 2) {
        out.push(Buffer.from(hex, 'hex').toString('latin1'));
      }
    }
    at = e0 + endMarker.length;
  }
  return out.join(' ');
}

function isRecognizedBinary(path) {
  let head;
  try {
    head = readFileSync(join(REPO_ROOT, path)).subarray(0, 8);
  } catch {
    // Unreadable is handled by scanFile's fail-closed path; never claim binary.
    return false;
  }
  // Signature AND extension. A prefix alone is claimable by any file: a tracked
  // `.md` beginning with `GIF8` took the exemption and skipped the scan
  // entirely, which turns this performance shortcut into a bypass anyone can
  // opt into. Requiring the extension to agree means a document cannot dress
  // itself as an image.
  if (!/\.(png|jpe?g|gif|woff2?)$/i.test(path)) return false;
  return BINARY_SIGNATURES.some((sig) => sig.every((byte, i) => head[i] === byte));
}

function scanFile(path) {
  let text;
  try {
    // Resolved against REPO_ROOT, not the process CWD — `path` is a
    // repo-root-relative ledger key.
    const raw = readFileSync(join(REPO_ROOT, path));
    // A PDF's bytes are a container, not prose — decode what it draws.
    text = raw.subarray(0, 4).toString('latin1') === '%PDF'
      ? extractPdfText(raw)
      : raw.toString('utf8');
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

  // Recognized BINARY FORMATS, by signature. An image's bytes are not prose:
  // a PNG whose `tEXt` chunk happens to hold `buy` as a keyword and `adapter`
  // as its value had the NUL field separator discarded like any other
  // non-alphanumeric byte, fused into the dead token, and failed an asset-only
  // change on a field no reader ever sees.
  //
  // Keyed on the FORMAT SIGNATURE, deliberately NOT on "contains a NUL" — that
  // rule is the total bypass described below, and reintroducing it is exactly
  // what this must not do. A file that really is a PNG cannot also be the
  // documentation this gate reads, so the exemption cannot be claimed by text.
  // The signature is read from the RAW BYTES: `text` has already been decoded
  // as UTF-8, which mangles the very bytes being tested.
  if (isRecognizedBinary(path)) return { hits: 0, digest: '' };

  // NO binary early-return ON NUL BYTES. An earlier version bailed out on the first NUL
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
  const { inFence, delimiter: fenceDelimiter } = computeFences(lines);
  // Fences, inline code spans and indented code blocks are MARKDOWN
  // constructs. `.tsx`, `.jsx`, `.html` and `.svg` are in MARKUP_EXTENSIONS
  // because inline tags can split a phrase there, not because they parse
  // Markdown — a backtick in TSX is a template literal or plain text. Applying
  // the code-span exemption to them meant a staged TSX file rendering
  // `` `<p>`buy <strong>adapter</strong>`</p>` `` kept its inner tags out of the
  // stripper, so the phrase a user sees never fused and the gate stayed green.
  const isMarkdown = /\.mdx?$/i.test(path);
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
    const re = /(?<![\\`])(`+)(?!`)([\s\S]*?)(?<![\\`])\1(?!`)/g;
    let m;
    while ((m = re.exec(text))) {
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
    for (let i = 0; i < lines.length; i++) {
      const blank = !lines[i].trim();
      if (inFence[i]) {
        prevBlank = false;
        continue;
      }
      if (!blank && /^(?: {4}|\t)/.test(lines[i]) && (prevBlank || flags[i - 1])) {
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
    // JSON takes the per-character loop too, not the fast regex. The regex is
    // only "provably identical" for formats where the loop does nothing extra,
    // and that stopped being true once the loop learned to decode JSON string
    // escapes: `"buy\u0020adapter"` renders as one phrase, but the regex path
    // keeps the literal letters `u0020` between the words, finds no token, and
    // returns before the decode can run. The file is then never scanned at all.
    //
    // This is the drift this pre-filter's own comments warn about — a second
    // implementation of the transform that silently stops matching the first.
    // Whenever the loop learns to render something, this condition has to let
    // the affected format reach it.
    if (!MARKUP_EXTENSIONS.test(path) && !/\.jsonc?$/i.test(path))
      return normalize(text);
    // The pre-filter must see everything the full scan can match, or it
    // short-circuits a file the scan would have flagged. Tag interiors are now
    // a second stream (see below), and a document that carries a dead
    // identifier ONLY inside tags — `<vpfi-buy-adapter>` in an HTML file —
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
    const gap = renderRefs(text.slice(map[end - 1] + 1, map[end]));
    if (!/^[-_]*$/.test(gap)) return false;
    return /^[A-Za-z0-9_-]+$/.test(
      renderRefs(text.slice(map[end], identifierSpanEnd(map[end + suffixLength - 1]))),
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
  const stripRecognizedTags = (from, to) => {
    let out = '';
    let at = from;
    for (const [s0, e0] of tagSpans) {
      if (e0 <= from) continue;
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
      !inTagInterior && MARKUP_EXTENSIONS.test(path) && !literalAt(from)
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
    return lastOffset + (ref ? ref[0].length : 1);
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
   * Newlines alone are never boundaries: `GuardianPausable.sol:16` wraps
   * "the buy\n *         adapter/receiver" and is a real mention.
   *
   * The structural rules apply to `.mdx` as well as `.md`. MDX is in
   * MARKUP_EXTENSIONS and is Markdown, but the flag here tested `.md` only, so
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
      for (const [s0, e0] of tagSpans) {
        if (e0 <= from) continue;
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
    // In JSON, separate string values are separate pieces of text and never
    // render as one phrase. The normalizer drops the punctuation between them,
    // so `["Decide what to buy", "Adapter selection follows"]` fused into
    // `buyadapter` and failed a clean file. A span lying inside ONE string
    // literal cannot contain an UNESCAPED quote; one that does has crossed out
    // of it. The escape matters: `"…buy \"adapter\" before cutover."` is a
    // single valid value that renders as one phrase naming the dead surface,
    // and counting its escaped quotes as boundaries discarded a real mention.
    // Drop backslash escapes before looking, so only structural quotes remain.
    if (/\.jsonc?$/i.test(path) && span.replace(/\\[\s\S]/g, '').includes('"'))
      return true;
    if (MARKUP_EXTENSIONS.test(path) && !literalAt(from)) {
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
    // CJK terminators alongside their ASCII equivalents. `apps/alpha02/src/
    // i18n/locales/{ja,ko}.json` are tracked and scanned, and a full-width `。`
    // ends a sentence exactly as `.` does — normalization drops it, so a
    // rendered "…buy。Adapter…" would fuse into a mention and block a clean
    // localized file. No such adjacency exists in those bundles today (they
    // carry none of the tokens), so this is future-proofing rather than a live
    // fix — but it can only ever PREVENT a false block, never hide a mention.
    if (/[.!?;:|]/.test(span)) return true;
    if (/[。！？；：]/.test(span)) return true;
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
        // A fence delimiter is itself the boundary: the span jumped over a
        // code block. `inFence` marks delimiters, so this test has to come
        // BEFORE the skip below or an empty fenced block — whose two
        // delimiters are its only lines — would be invisible here and fuse
        // the prose either side of it into a mention that no reader sees.
        if (fenceDelimiter[i]) return true;
        if (inFence[i]) continue;
        if (/^\s{0,3}#{1,6}\s/.test(lines[i])) return true;
        if (/^\s{0,3}(?:[-*+]\s|\d+[.)]\s)/.test(lines[i])) return true;
        // Blockquote marker. Markdown renders `> …` as its own quote block, so
        // the line before it and the line after it are not one sentence — but
        // only headings and list markers were recognized, so a sentence ending
        // at a quote fused with the quote's first words and failed a clean
        // file. Same class as the heading and list rules: an explicit block
        // delimiter, not a guess about English.
        if (/^\s{0,3}>/.test(lines[i])) return true;
        // Thematic breaks — `***`, `---`, `___`, optionally spaced. A reader
        // sees a horizontal rule dividing two blocks; the walk saw nothing and
        // fused the sentence before it with the one after. Note the overlap
        // with the Setext rule above: a `---` line is a heading underline when
        // text sits directly above it and a thematic break otherwise, so the
        // Setext check runs FIRST and this only sees the leftovers.
        if (/^\s{0,3}(?:\*[ \t]*){3,}$|^\s{0,3}(?:-[ \t]*){3,}$|^\s{0,3}(?:_[ \t]*){3,}$/.test(lines[i]))
          return true;
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
      const atx = /^\s{0,3}(#{1,6})\s/.exec(lines[i]);
      const bold = /^\s{0,3}\*\*[^*]+\*\*/.test(lines[i]);
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
      // and `---` is a document separator in YAML — so `status: historical`
      // above one was read as a level-2 heading governing a mention further
      // down the file, and editing an unrelated earlier document moved the
      // digest. That direction is worse than the miss it fixes: a false BLOCK
      // on an ordinary edit trains people to re-pin without reading, which is
      // the one habit that would make this whole gate worthless.
      const setext =
        isMarkdown && i + 1 < lines.length && !inFence[i + 1] && lines[i].trim() !== ''
          ? /^\s{0,3}(=|-)\1{2,}\s*$/.exec(lines[i + 1])
          : null;
      if (!atx && !bold && !setext) continue;
      // A `**Bold lead-in**` sits below any ATX heading; level 7 orders it so.
      // A Setext heading takes the ATX level its underline corresponds to, so
      // the two syntaxes interleave in one ancestry rather than forming
      // separate ladders.
      const level = atx ? atx[1].length : setext ? (setext[1] === '=' ? 1 : 2) : 7;
      if (level >= deepest) continue;
      deepest = level;
      chain.push(lines[i]);
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
