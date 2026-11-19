#!/usr/bin/env node
/**
 * check-wallet-payouts.mjs — the payout rule's build check (owner decision
 * 2026-11-19, PayoutDestinationRuleDesign.md §4.5).
 *
 * Everything a loan or an open offer owes a party is paid into that party's
 * VAULT as free balance; only the account's own Withdraw reaches a wallet.
 * The outflow policy pays a wallet through exactly two classes, `Owner` and
 * `OwnerAllowlisted`, reached through `LibVaultOutflow.toOwner` /
 * `toAllowlisted` (or the host entry `vaultOutflowToOwner`). This check
 * refuses any caller of those doors, or any naming of those two classes,
 * outside the one Withdraw (`LibVaultWithdraw`) and the protected payout
 * queue's release (`VaultPayoutFacet`).
 *
 * It also lists, with its reason, every caller of the delivery helper's
 * direct pushes (`LibDelivery.pushOut`, `pushExact`, `pushMeasured`): those
 * move value the Diamond holds to an address the caller names. A push to a
 * non-party wallet (a liquidator's or keeper's bonus, the admin's treasury
 * claim) or into a vault is legitimate; a new push must say which it is.
 *
 * Each site is keyed by file, contract and function with its count, like
 * check-raw-payouts.mjs, so a second call in a listed function fails, and a
 * listed site that no longer calls fails too. It reads the same AST
 * artifacts (run check-measured-delivery.mjs first).
 *
 * CLI: node contracts/script/check-wallet-payouts.mjs [--out <dir>]
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACTS_DIR, loadBuild } from './storage-layout-guard.mjs';
import { BUILD_OUT_DIR } from './check-measured-delivery.mjs';
import { walk, enclosingName, lineOf } from './check-loan-terms-writer.mjs';

/** Where the doors themselves live; calls inside them are the doors. */
export const HOMES = new Set([
  'src/facets/VaultOutflowFacet.sol',
  'src/libraries/LibVaultOutflow.sol',
  'src/libraries/LibDelivery.sol',
]);

const SCOPE = /^src\//;

/** Library members that pay a wallet or push value out, by library. */
const DOORS = {
  LibVaultOutflow: new Set(['toOwner', 'toAllowlisted']),
  LibDelivery: new Set(['pushOut', 'pushExact', 'pushMeasured']),
};
/** The wallet-paying policy classes and the host entry that takes `Owner`. */
const WALLET_CLASSES = new Set(['Owner', 'OwnerAllowlisted']);
const HOST_ENTRIES = new Set(['vaultOutflowToOwner']);

const WITHDRAW = 'THE one Withdraw: the account\'s own asset to its own wallet (or queued behind the delay).';
const QUEUE = 'The protected payout queue\'s release, after the delay, to the manager or an allowlisted address.';
const INTO_VAULT = 'Into a user\'s VAULT, credited there; never a wallet.';
const NON_PARTY = 'A non-party\'s own payment, to its wallet (the payout rule pays only parties into vaults).';

/** Every allowed site, with why. */
export const ALLOWED = [
  { site: 'src/libraries/LibVaultWithdraw.sol:LibVaultWithdraw.withdraw', count: 1, reason: WITHDRAW },
  { site: 'src/facets/VaultPayoutFacet.sol:VaultPayoutFacet._pay', count: 2, reason: QUEUE },
  { site: 'src/facets/VaultPayoutFacet.sol:VaultPayoutFacet.creditOwnerVault', count: 1, reason: INTO_VAULT },
  { site: 'src/facets/RiskFacet.sol:RiskFacet.triggerPartialLiquidation', count: 1, reason: `${NON_PARTY} The partial liquidator's bonus.` },
  { site: 'src/facets/ForcedSaleFacet.sol:ForcedSaleFacet._settle', count: 1, reason: `${NON_PARTY} The keeper's bonus.` },
  { site: 'src/facets/TreasuryFacet.sol:TreasuryFacet.claimTreasuryFees', count: 1, reason: 'The admin\'s claim of the protocol\'s own fees to the treasury claimant; no user funds.' },
  { site: 'src/facets/TreasuryFeeFacet.sol:TreasuryFeeFacet.collectFeeFromDiamond', count: 1, reason: 'A fee to the treasury (a protocol address); no user payout.' },
  { site: 'src/libraries/LibSanctionedLock.sol:LibSanctionedLock.depositLocked', count: 1, reason: INTO_VAULT },
  { site: 'src/libraries/LibFacet.sol:LibFacet.creditOwnVault', count: 1, reason: INTO_VAULT },
  { site: 'src/libraries/LibFacet.sol:LibFacet.depositForNewLender', count: 1, reason: INTO_VAULT },
  { site: 'src/facets/RefinanceFacet.sol:RefinanceFacet._settlePayoff', count: 1, reason: `${INTO_VAULT} The old lender's vault.` },
  { site: 'src/facets/SwapToRepayFacet.sol:SwapToRepayFacet.swapToRepayFull', count: 1, reason: `${INTO_VAULT} A swap's unused collateral back to the borrower's vault.` },
  { site: 'src/facets/SwapToRepayPartialFacet.sol:SwapToRepayPartialFacet.swapToRepayPartial', count: 1, reason: `${INTO_VAULT} A swap's unused collateral back to the borrower's vault.` },
  { site: 'src/facets/PrepayListingFacet.sol:PrepayListingFacet.recordOfferSaleProceeds', count: 1, reason: `${INTO_VAULT} A collateral sale's proceeds.` },
  { site: 'src/facets/BackstopFacet.sol:BackstopFacet.seedBackstopOrigination', count: 1, reason: 'Treasury capital into the backstop vault (a protocol vault).' },
  { site: 'src/facets/BackstopFacet.sol:BackstopFacet.seedBackstopAbsorb', count: 1, reason: 'Treasury capital into the backstop vault (a protocol vault).' },
  { site: 'src/facets/AutoLifecycleFacet.sol:AutoLifecycleFacet._routeInterest', count: 1, reason: `${INTO_VAULT} The lender's share of an extension.` },
  { site: 'src/facets/EarlyWithdrawalDirectFacet.sol:EarlyWithdrawalDirectFacet._sellLoanViaBuyOfferImpl', count: 1, reason: `${INTO_VAULT} The held-for-lender amount into the buyer's vault.` },
  { site: 'src/BackstopVaultImplementation.sol:BackstopVaultImplementation.executeClaim', count: 2, reason: 'The backstop vault returning recovered value to the Diamond.' },
  { site: 'src/BackstopVaultImplementation.sol:BackstopVaultImplementation.withdrawIdleToDiamond', count: 1, reason: 'The backstop vault returning value to the Diamond.' },
  { site: 'src/BackstopVaultImplementation.sol:BackstopVaultImplementation.sweepToken', count: 1, reason: 'The backstop vault sweeping a token to its governed destination (protocol funds, no user payout).' },
  { site: 'src/VaipakamVaultImplementation.sol:VaipakamVaultImplementation._destinationAllowed', count: 2, reason: 'The vault\'s own second check of where an outflow of each class may go; it pays nothing.' },
];

const typeOf = (n) => n?.typeDescriptions?.typeString ?? '';

/** What `node` is, when it is a wallet door or a push; undefined otherwise. */
export function doorKind(node) {
  if (node.nodeType === 'MemberAccess') {
    const inner = node.expression;
    // `LibX.member` as the compiler resolved it: a library type expression.
    for (const [lib, members] of Object.entries(DOORS)) {
      if (members.has(node.memberName) && typeOf(inner) === `type(library ${lib})`) return `${lib}.${node.memberName}`;
    }
    if (WALLET_CLASSES.has(node.memberName) && /^type\(enum VaultOutflowTypes\.OutflowClass\)$/.test(typeOf(inner))) {
      return `OutflowClass.${node.memberName}`;
    }
    if (HOST_ENTRIES.has(node.memberName)) return node.memberName;
  }
  return undefined;
}

/** Every door use in src/ outside {HOMES}. Pure. */
export function doorSites(units, { sourceText = () => undefined } = {}) {
  const sites = new Map();
  for (const unit of units) {
    const path = unit.absolutePath;
    if (typeof path !== 'string' || !SCOPE.test(path) || HOMES.has(path)) continue;
    const text = sourceText(path);
    walk(unit, (node, ancestors) => {
      const label = doorKind(node);
      if (!label) return;
      const key = `${path}:${enclosingName(ancestors)}`;
      const site = sites.get(key) ?? { count: 0, refs: [] };
      site.count += 1;
      site.refs.push({ label, line: lineOf(node.src, text) });
      sites.set(key, site);
    });
  }
  return sites;
}

/** Problems with `sites` against `allowed`. Pure. */
export function verdict(sites, allowed = ALLOWED) {
  const problems = [];
  const listed = new Map(allowed.map((e) => [e.site, e]));
  for (const [key, site] of [...sites].sort(([a], [b]) => a.localeCompare(b))) {
    const where = site.refs.map((r) => `${r.label}${r.line ? ` @${r.line}` : ''}`).join(', ');
    const entry = listed.get(key);
    if (!entry) {
      problems.push(`${key}: ${site.count} wallet door or push(es) (${where}) — a party is paid into its vault (payout rule); list a non-party or vault push with its reason`);
    } else if (entry.count !== site.count) {
      problems.push(`${key}: listed with ${entry.count}, found ${site.count} (${where}) — a changed count is a new payout to justify`);
    }
  }
  for (const e of allowed) {
    if (!sites.has(e.site)) problems.push(`${e.site}: listed, but uses no door any more — remove the entry`);
  }
  return problems;
}

export function main(argv = process.argv.slice(2)) {
  let outDir = BUILD_OUT_DIR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) outDir = argv[++i];
    else {
      console.error(`check-wallet-payouts: unknown argument ${argv[i]}`);
      return 2;
    }
  }
  let build;
  try {
    build = loadBuild(outDir);
  } catch (e) {
    console.error(`  ✗ cannot read ${outDir}: ${e.message} — run check-measured-delivery.mjs first, or pass --out`);
    return 1;
  }
  if (build.problems.length) {
    for (const p of build.problems) console.error(`  ✗ ${p}`);
    return 1;
  }
  const units = [...build.units.values()];
  for (const h of [...HOMES, 'src/libraries/LibVaultWithdraw.sol', 'src/facets/VaultPayoutFacet.sol']) {
    if (!units.some((u) => u.absolutePath === h)) {
      console.error(`  ✗ ${h} is not among the compiled sources — the check would see nothing`);
      return 1;
    }
  }
  const sites = doorSites(units, {
    sourceText: (p) => {
      try {
        return readFileSync(join(CONTRACTS_DIR, p));
      } catch {
        return undefined;
      }
    },
  });
  const problems = verdict(sites);
  if (problems.length) {
    for (const p of problems) console.error(`  ✗ ${p}`);
    return 1;
  }
  console.log(`  ✓ only the one Withdraw and the payout queue pay a party's wallet; ${sites.size} listed push site(s)`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
