#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
//
// lint-event-categories.js — CI lint enforcing EventSourcingAudit §1.6.
//
// Every external-emitted Solidity event in `contracts/src/**` MUST carry a
// `@custom:event-category` natspec tag whose value is exactly two levels
// (`<top>/<leaf>`). Validates against the closed allow-list defined in
// §1.5.1 of `docs/DesignsAndPlans/EventSourcingAudit.md` and emits a consolidated
// `contracts/out/event-categories.json` keyed by event signature for
// downstream consumers (watcher D1 dispatcher, frontend cache-merge,
// subgraph handler) to load directly.
//
// Run after `forge build`. Reads `contracts/out/<Facet>.sol/<Facet>.json`
// artifacts directly — no foundry CLI invocations from inside this script.
//
// Failure modes (non-zero exit + diagnostic):
//   - MISSING_TAG    event in ABI without `@custom:event-category` in devdoc
//   - MALFORMED_TAG  tag value not matching `^(state-change|informational)/[a-z][a-z-]*$`
//   - UNKNOWN_LEAF   leaf not in §1.5.1 allow-list
//
// Usage:
//   node contracts/script/lint-event-categories.js
//       # exit 0 + writes contracts/out/event-categories.json on success
//       # exit 1 + prints diagnostics on any violation
//
// CI integration:
//   - Pre-commit hook (husky) on staged `contracts/src/**/*.sol` changes.
//   - GitHub Actions step after the `forge build` job.

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'contracts', 'out');
const SOURCE_DIR = path.join(REPO_ROOT, 'contracts', 'src');
const OUTPUT_FILE = path.join(ARTIFACTS_DIR, 'event-categories.json');

// §1.5.1 — closed allow-list. Adding a new leaf REQUIRES updating both
// EventSourcingAudit.md §1.5.1 AND this list in the same PR. The closed
// shape is deliberate: prevents accidental category proliferation that
// would re-fragment the consumer dispatch logic the taxonomy is meant
// to consolidate.
// OZ-inherited events whose source declarations live outside `contracts/src/`
// (so we cannot put a `@custom:event-category` natspec tag on them). These
// are events we know exist in our deployed ABI surface via inheritance from
// OpenZeppelin / Diamond-3 / etc. — categorised here as the canonical
// taxonomy assignment. Add a new key when a new third-party-inherited
// event surfaces in our compiled ABIs.
const INHERITED_EVENT_OVERRIDES = {
  // OZ AccessControl
  'RoleAdminChanged(bytes32,bytes32,bytes32)': 'informational/admin',
  'RoleGranted(bytes32,address,address)': 'informational/admin',
  'RoleRevoked(bytes32,address,address)': 'informational/admin',
  // OZ Pausable
  'Paused(address)': 'informational/admin',
  'Unpaused(address)': 'informational/admin',
  // OZ Ownable / IERC173
  'OwnershipTransferred(address,address)': 'informational/admin',
  // OZ ERC1967 / UUPS
  'Upgraded(address)': 'state-change/escrow-mutation',
  'AdminChanged(address,address)': 'informational/admin',
  'BeaconUpgraded(address)': 'informational/admin',
  // OZ Initializable
  'Initialized(uint8)': 'informational/admin',
  'Initialized(uint64)': 'informational/admin',
  // OZ Ownable2Step
  'OwnershipTransferStarted(address,address)': 'informational/admin',
  // Diamond-3 / EIP-2535
  'DiamondCut((address,uint8,bytes4[])[],address,bytes)': 'informational/admin',
  // LayerZero V2 OApp / OAppCore — inherited via VaipakamRewardOApp,
  // VPFIBuyAdapter, VPFIBuyReceiver, VPFIMirror, VPFIOFTAdapter.
  'PeerSet(uint32,bytes32)': 'informational/lz-plumbing',
  'EnforcedOptionSet((uint32,uint16,bytes)[])': 'informational/lz-plumbing',
  'DelegateSet(address)': 'informational/lz-plumbing',
  'MsgInspectorSet(address)': 'informational/lz-plumbing',
  'PreCrimeSet(address)': 'informational/lz-plumbing',
  // LayerZero V2 OFT (Sent / Received are token-flow events; treat as
  // escrow mutations since they reflect cross-chain VPFI moves).
  'OFTSent(bytes32,uint32,address,uint256,uint256)': 'state-change/escrow-mutation',
  'OFTReceived(bytes32,uint32,address,uint256)': 'state-change/escrow-mutation',
};

const ALLOWED_CATEGORIES = new Set([
  // state-change/* — every event whose firing reflects a storage mutation
  // the cache layer MUST merge into the row keyed by (chainId, primaryKey).
  'state-change/loan-mutation',
  'state-change/offer-mutation',
  'state-change/escrow-mutation',
  'state-change/nft-mutation',
  'state-change/treasury-mutation',
  'state-change/claim-mutation',
  'state-change/reward-claim',
  // informational/* — analytics + ops surfaces; cache MUST NOT merge.
  'informational/admin',
  'informational/config',
  'informational/liquidation',
  'informational/claim',
  'informational/settlement',
  'informational/lz-plumbing',
  'informational/reward-transport',
  'informational/governance',
]);

const TAG_PATTERN = /^(state-change|informational)\/[a-z][a-z-]*$/;

// Errors collected then reported in one pass — better DX than fail-fast
// for repos with many violations on first run.
const violations = [];

/**
 * Recursively walk a directory and yield every file matching `predicate`.
 * Plain JS — keeps the script dep-free for CI sandboxes that don't run
 * `npm install` ahead of lint.
 */
function* walk(dir, predicate) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full, predicate);
    } else if (entry.isFile() && predicate(full)) {
      yield full;
    }
  }
}

/**
 * Build the canonical event signature `Name(type1,type2,...)` from a
 * Solidity ABI fragment. Tuple types collapse to `(t1,t2,...)`. Used as
 * the keccak256 pre-image for the topic-0 hash, so consumers can map
 * received logs → category by hashing this string.
 */
function abiEventSignature(eventAbi) {
  function typeFragment(input) {
    if (input.type === 'tuple') {
      const inner = input.components.map(typeFragment).join(',');
      return `(${inner})`;
    }
    if (input.type === 'tuple[]') {
      const inner = input.components.map(typeFragment).join(',');
      return `(${inner})[]`;
    }
    return input.type;
  }
  const params = (eventAbi.inputs || []).map(typeFragment).join(',');
  return `${eventAbi.name}(${params})`;
}

/**
 * Scan `contracts/src/**\/*.sol` for `event Foo(...)` declarations + their
 * preceding natspec block. Returns { sourceFile, contractName, eventName,
 * categoryTag } records. We parse source rather than relying solely on
 * the compiler's `devdoc` because Foundry's natspec emission for
 * `@custom:` event tags has been historically inconsistent across solc
 * minor versions; reading the source string is robust.
 */
function scanSourceEvents() {
  const events = [];
  const eventDeclRegex =
    /(\/\*\*[\s\S]*?\*\/|(?:\/\/\/[^\n]*\n[ \t]*)+)\s*event\s+([A-Za-z_]\w*)\s*\(/g;
  const customTagRegex =
    /@custom:event-category\s+([^\s*]+)/;
  const contractDeclRegex =
    /(?:contract|library|interface)\s+([A-Za-z_]\w*)/;

  for (const file of walk(SOURCE_DIR, (f) => f.endsWith('.sol'))) {
    const src = fs.readFileSync(file, 'utf8');
    const contractMatch = src.match(contractDeclRegex);
    const contractName = contractMatch ? contractMatch[1] : path.basename(file, '.sol');

    let m;
    eventDeclRegex.lastIndex = 0;
    while ((m = eventDeclRegex.exec(src)) !== null) {
      const docBlock = m[1] || '';
      const eventName = m[2];
      const tagMatch = docBlock.match(customTagRegex);
      events.push({
        sourceFile: path.relative(REPO_ROOT, file),
        contractName,
        eventName,
        categoryTag: tagMatch ? tagMatch[1].trim() : null,
      });
    }
  }
  return events;
}

/**
 * Walk `contracts/out/**\/*.json` and collect every ABI event fragment.
 * Returns { contractName, eventName, signature } records — used to
 * build the consolidated topic-0 → category mapping after validation.
 *
 * Skips artifacts whose primary source isn't under `contracts/src/`
 * (test contracts, OpenZeppelin, forge-std, Diamond-3, etc.). Those
 * compile but their events aren't part of our deployed surface; tagging
 * them is impossible and the lint should not block on them.
 */
function scanArtifactEvents() {
  const events = [];
  for (const file of walk(ARTIFACTS_DIR, (f) => f.endsWith('.json'))) {
    let artifact;
    try {
      artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      // Some artifacts (e.g. cache files) aren't valid JSON; skip silently.
      continue;
    }
    if (!Array.isArray(artifact.abi)) continue;

    // Only lint artifacts whose primary source file lives under
    // `contracts/src/`. The Solidity compiler embeds the source path
    // → contract name map in metadata.settings.compilationTarget; one
    // entry per artifact.
    let primarySource = null;
    try {
      const meta = typeof artifact.metadata === 'string'
        ? JSON.parse(artifact.metadata)
        : artifact.metadata;
      const target = meta?.settings?.compilationTarget || {};
      primarySource = Object.keys(target)[0] || null;
    } catch (e) {
      // Malformed metadata → skip.
      continue;
    }
    if (!primarySource || !primarySource.startsWith('src/')) continue;

    const contractName = path.basename(file, '.json');
    for (const fragment of artifact.abi) {
      if (fragment.type !== 'event') continue;
      events.push({
        contractName,
        eventName: fragment.name,
        signature: abiEventSignature(fragment),
      });
    }
  }
  return events;
}

function main() {
  if (!fs.existsSync(ARTIFACTS_DIR)) {
    console.error(
      `lint-event-categories: contracts/out/ missing — run 'forge build' first.`
    );
    process.exit(2);
  }

  const sourceEvents = scanSourceEvents();
  const artifactEvents = scanArtifactEvents();

  // Map (contractName, eventName) → category tag from source.
  const tagBySrcKey = new Map();
  for (const ev of sourceEvents) {
    const key = `${ev.contractName}::${ev.eventName}`;
    if (!tagBySrcKey.has(key)) {
      tagBySrcKey.set(key, ev);
    }
  }

  // Validate every artifact event has a tag in source AND the tag is
  // well-formed. Build the topic-0 → category table only for events
  // that pass validation.
  const categoriesBySignature = {};

  // Track which signatures have been emitted to the output map so we
  // don't double-write when the same event surfaces in multiple
  // artifacts (e.g. RoleGranted via AccessControlFacet AND any other
  // facet that inherits AccessControl).
  const seenSignatures = new Set();

  for (const ev of artifactEvents) {
    if (seenSignatures.has(ev.signature)) continue;

    // 1. Inherited-from-third-party override (OZ AccessControl, OZ
    //    Pausable, etc.) — these events live in source we don't own,
    //    so we categorise them statically here.
    if (INHERITED_EVENT_OVERRIDES[ev.signature] !== undefined) {
      const overrideTag = INHERITED_EVENT_OVERRIDES[ev.signature];
      if (!ALLOWED_CATEGORIES.has(overrideTag)) {
        violations.push({
          kind: 'OVERRIDE_INVALID',
          event: ev.signature,
          tag: overrideTag,
          message:
            `inherited override for ${ev.signature} uses leaf '${overrideTag}' ` +
            `not in allow-list — fix INHERITED_EVENT_OVERRIDES in this script`,
        });
        continue;
      }
      categoriesBySignature[ev.signature] = overrideTag;
      seenSignatures.add(ev.signature);
      continue;
    }

    // 2. Primary lookup by (contractName, eventName).
    const key = `${ev.contractName}::${ev.eventName}`;
    const srcEvent = tagBySrcKey.get(key);

    // 3. Fallback: event declared in another `contracts/src/` file
    //    (library, base contract) and inherited into this artifact.
    let categoryTag = srcEvent ? srcEvent.categoryTag : null;
    if (!categoryTag) {
      const fallback = sourceEvents.find((s) => s.eventName === ev.eventName);
      categoryTag = fallback ? fallback.categoryTag : null;
    }

    if (!categoryTag) {
      violations.push({
        kind: 'MISSING_TAG',
        contract: ev.contractName,
        event: ev.signature,
        message: `event ${ev.signature} in ${ev.contractName} has no @custom:event-category tag`,
      });
      continue;
    }

    if (!TAG_PATTERN.test(categoryTag)) {
      violations.push({
        kind: 'MALFORMED_TAG',
        contract: ev.contractName,
        event: ev.signature,
        tag: categoryTag,
        message:
          `event ${ev.signature} in ${ev.contractName} has malformed tag '${categoryTag}' ` +
          `(expected ^(state-change|informational)/[a-z][a-z-]*$)`,
      });
      continue;
    }

    if (!ALLOWED_CATEGORIES.has(categoryTag)) {
      violations.push({
        kind: 'UNKNOWN_LEAF',
        contract: ev.contractName,
        event: ev.signature,
        tag: categoryTag,
        message:
          `event ${ev.signature} in ${ev.contractName} uses unknown leaf '${categoryTag}' ` +
          `— extend ALLOWED_CATEGORIES in this script AND ` +
          `docs/DesignsAndPlans/EventSourcingAudit.md §1.5.1 in the same PR`,
      });
      continue;
    }

    categoriesBySignature[ev.signature] = categoryTag;
    seenSignatures.add(ev.signature);
  }

  if (violations.length > 0) {
    console.error('lint-event-categories: FAILED — fix the violations below.\n');
    for (const v of violations) {
      console.error(`  [${v.kind}] ${v.message}`);
    }
    console.error(`\n${violations.length} violation(s).`);
    process.exit(1);
  }

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(categoriesBySignature, null, 2) + '\n',
    'utf8'
  );

  const eventCount = Object.keys(categoriesBySignature).length;
  console.log(
    `lint-event-categories: OK — ${eventCount} events validated, ` +
      `wrote ${path.relative(REPO_ROOT, OUTPUT_FILE)}`
  );
}

main();
