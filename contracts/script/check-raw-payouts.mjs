#!/usr/bin/env node
/**
 * check-raw-payouts.mjs — the Diamond pays users only through the outflow
 * policy or the delivery helper (#3710 §3.8, #3568).
 *
 * The protected-payout rule: no route pays the wallet of a protected account
 * except through the outflow policy (`VaultOutflowFacet`, reached through
 * `LibVaultOutflow`) or `LibDelivery` (whose credit-if-protected step pays a
 * protected account into its vault). A token or native-value transfer written
 * anywhere else in the Diamond's code would skip both, so this check fails on
 * any such transfer in src/facets/ or src/libraries/ that is not LISTED below
 * with its reason. Every listed site goes to a protocol contract, the keeper,
 * or back to the caller as the refund of its own unspent fee.
 *
 * A transfer is, as the compiler resolved it:
 *   - a call of a member named transfer, safeTransfer, transferFrom,
 *     safeTransferFrom or safeBatchTransferFrom (an ERC-20, ERC-721 or
 *     ERC-1155 move, or a native `transfer`);
 *   - a call carrying a `value` option (a native payment); and
 *   - the `.selector` of such a member, or the member passed to
 *     `abi.encodeCall` (a transfer encoded for a low-level call); and
 *   - a call of `LibDelivery.pushMeasured` from outside LibDelivery. It is
 *     the library's raw measured push, WITHOUT the credit-if-protected step
 *     that `pushExact` and `pushOut` take, so a facet calling it with a
 *     wallet would pay a protected account's wallet directly while the
 *     transfer itself sits inside a home. Every caller pays a vault, the
 *     treasury or the Diamond, and is listed below (2026-11-20).
 *
 * Each listed site is keyed by file, contract and function with its count, so
 * a second transfer added to a listed function fails as well, and a listed
 * site that no longer transfers fails too. It reads the same AST artifacts as
 * the loan-terms writer check.
 *
 * CLI: node contracts/script/check-raw-payouts.mjs [--out <dir>]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS_DIR, loadBuild } from './storage-layout-guard.mjs';
import { BUILD_OUT_DIR } from './check-measured-delivery.mjs';
import { walk, enclosingName, lineOf } from './check-loan-terms-writer.mjs';

/** The two places a user payout may be made, and the policy's library door. */
export const HOMES = new Set([
  'src/facets/VaultOutflowFacet.sol',
  'src/libraries/LibVaultOutflow.sol',
  'src/libraries/LibDelivery.sol',
]);

const SCOPE = /^src\/(facets|libraries)\//;
const NAMES = new Set(['transfer', 'safeTransfer', 'transferFrom', 'safeTransferFrom', 'safeBatchTransferFrom']);
/** LibDelivery's raw measured push: a home's transfer, reachable without the protected-wallet step. */
const RAW_PUSH = 'pushMeasured';

const CALLER_REFUND = 'Refunds the caller its own unspent fee, sent with this call; not a payout of anything the protocol holds for anyone.';
const MESSENGER_FEE = 'Pays the cross-chain messenger (a protocol contract) its fee for a send.';

/** The sites outside {HOMES} that may transfer, with why. */
export const ALLOWED = [
  { site: 'src/facets/RewardReporterFacet.sol:RewardReporterFacet.closeDay', count: 2, reason: `${MESSENGER_FEE} ${CALLER_REFUND}` },
  { site: 'src/facets/TreasuryFacet.sol:TreasuryFacet.remitBuyback', count: 2, reason: `${MESSENGER_FEE} ${CALLER_REFUND}` },
  { site: 'src/facets/ProtocolBroadcastFacet.sol:ProtocolBroadcastFacet.deliverTierPush', count: 1, reason: CALLER_REFUND },
  { site: 'src/facets/ProtocolBroadcastFacet.sol:ProtocolBroadcastFacet._deliverLane', count: 1, reason: MESSENGER_FEE },
  { site: 'src/facets/ProtocolBroadcastFacet.sol:ProtocolBroadcastFacet.broadcastTierTableVersionTo', count: 1, reason: MESSENGER_FEE },
  { site: 'src/facets/ProtocolBroadcastFacet.sol:ProtocolBroadcastFacet.withdrawBudget', count: 1, reason: 'Admin withdrawal of the protocol broadcast budget (native gas the protocol funded itself), to an address the admin names; no user funds.' },
  { site: 'src/facets/VaultFactoryFacet.sol:VaultFactoryFacet.vaultCreditFromDiamondERC20', count: 1, reason: 'Into a user VAULT (the credit path the policy and LibDelivery use), never a wallet.' },
  { site: 'src/facets/VaultFactoryFacet.sol:VaultFactoryFacet.vaultDepositERC721', count: 1, reason: 'A deposit INTO the user\'s own vault, never out of the protocol.' },
  { site: 'src/facets/VaultFactoryFacet.sol:VaultFactoryFacet.vaultDepositERC1155', count: 1, reason: 'A deposit INTO the user\'s own vault, never out of the protocol.' },
  { site: 'src/facets/RewardBroadcastFacet.sol:RewardBroadcastFacet.broadcastGlobal', count: 1, reason: MESSENGER_FEE },
  { site: 'src/facets/RewardBroadcastFacet.sol:RewardBroadcastFacet.broadcastGlobalTo', count: 1, reason: MESSENGER_FEE },
  { site: 'src/facets/RewardRemittanceFacet.sol:RewardRemittanceFacet.remitRewardBudget', count: 1, reason: CALLER_REFUND },
  { site: 'src/facets/RewardRemittanceFacet.sol:RewardRemittanceFacet.sendRemitAck', count: 1, reason: MESSENGER_FEE },
  { site: 'src/facets/RepatriationFacet.sol:RepatriationFacet.sendStrandedReturn', count: 2, reason: `Returns stranded VPFI to the cross-chain return sender (a protocol contract on the reward mesh), not to a user wallet. ${MESSENGER_FEE}` },
  { site: 'src/facets/RepatriationFacet.sol:RepatriationFacet.sendRepatriationInstruction', count: 1, reason: MESSENGER_FEE },
  { site: 'src/facets/RepatriationFacet.sol:RepatriationFacet.requestRepatriationCancel', count: 1, reason: MESSENGER_FEE },
  { site: 'src/facets/RepatriationFacet.sol:RepatriationFacet.executeRepatriation', count: 1, reason: MESSENGER_FEE },
  { site: 'src/facets/RepatriationFacet.sol:RepatriationFacet.sendRepatriationCancelAck', count: 1, reason: MESSENGER_FEE },
  { site: 'src/facets/RepatriationFacet.sol:RepatriationFacet.sendRetiredSurplusReturn', count: 1, reason: MESSENGER_FEE },
  { site: 'src/facets/RepatriationFacet.sol:RepatriationFacet._dispatchUntypedReturn', count: 1, reason: MESSENGER_FEE },
  { site: 'src/facets/RewardCommitmentFacet.sol:RewardCommitmentFacet.sendCommitmentReport', count: 1, reason: MESSENGER_FEE },
  { site: 'src/facets/RewardCommitmentFacet.sol:RewardCommitmentFacet.quoteZeroedDayCompensation', count: 1, reason: MESSENGER_FEE },
  { site: 'src/libraries/LibKeeperReward.sol:LibKeeperReward._safeTransfer', count: 1, reason: 'The keeper reward, paid to the keeper that ran the step from the keeper budget; no user funds.' },
  { site: 'src/libraries/LibServiceCapacity.sol:LibServiceCapacity._chargeArmingFee', count: 1, reason: 'Pulls an operator\'s arming fee INTO the Diamond.' },
  { site: 'src/libraries/LibServiceCapacity.sol:LibServiceCapacity._pull', count: 1, reason: 'Moves an operator\'s own capacity deposit between the operator and its escrow; operator funds under the capacity rules, measured.' },
  { site: 'src/libraries/LibRewardCustody.sol:LibRewardCustody.relocateToHolderUncredited', count: 1, reason: 'To the reward custody holder (a protocol contract).' },
  { site: 'src/libraries/LibRewardCustody.sol:LibRewardCustody.pullFromCaller', count: 1, reason: 'Pulls a funder\'s VPFI INTO the reward custody holder.' },
  { site: 'src/libraries/LibRewardRemitDispatch.sol:LibRewardRemitDispatch.dispatchRemitTail', count: 2, reason: `${MESSENGER_FEE} ${CALLER_REFUND}` },
  { site: 'src/libraries/LibConsolidation.sol:LibConsolidation._moveNFT', count: 2, reason: 'A consolidation leg into the current holder\'s VAULT, under the side\'s lien; never a wallet.' },
  { site: 'src/libraries/LibVpfiRecycle.sol:LibVpfiRecycle.debitRepatriationSurplus', count: 1, reason: 'Releases recycled VPFI to a protocol destination (the reward pool or the return transport), on the pre-custody path.' },
  // LibDelivery.pushMeasured callers: each pays a vault, the treasury or the Diamond, never a wallet.
  { site: 'src/facets/BackstopFacet.sol:BackstopFacet.seedBackstopOrigination', count: 1, reason: 'Treasury capital into the backstop VAULT for an origination; no wallet.' },
  { site: 'src/facets/BackstopFacet.sol:BackstopFacet.seedBackstopAbsorb', count: 1, reason: 'Treasury capital into the backstop VAULT for an absorb; no wallet.' },
  { site: 'src/facets/RefinanceFacet.sol:RefinanceFacet._settlePayoff', count: 1, reason: 'The borrower\'s payoff share into the OLD LENDER\'S VAULT (vault-to-vault settlement, #3042); no wallet.' },
  { site: 'src/facets/PrepayListingFacet.sol:PrepayListingFacet.recordOfferSaleProceeds', count: 1, reason: 'A sale\'s proceeds into the seller\'s VAULT; no wallet.' },
  { site: 'src/facets/VaultPayoutFacet.sol:VaultPayoutFacet.creditOwnerVault', count: 1, reason: 'The credit-if-protected step itself: pays a protected wallet\'s VAULT instead of the wallet.' },
  { site: 'src/libraries/LibFacet.sol:LibFacet.creditOwnVault', count: 1, reason: 'Credits the owner\'s OWN VAULT as free balance (#3629: no loan step pays a wallet; the owner withdraws through the outflow policy and its protected delay).' },
  { site: 'src/libraries/LibSanctionedLock.sol:LibSanctionedLock.depositLocked', count: 1, reason: 'A forced flow\'s proceeds into the owner\'s VAULT (locked when the owner is sanctioned); no wallet.' },
  { site: 'src/facets/TreasuryFeeFacet.sol:TreasuryFeeFacet.collectFeeFromDiamond', count: 1, reason: 'A treasury share to the TREASURY (a protocol address), measured; no user wallet.' },
];

const typeOf = (n) => n?.typeDescriptions?.typeString ?? '';

/** What `node` is, when it is a transfer; undefined otherwise. */
export function transferKind(node) {
  if (node.nodeType === 'FunctionCall') {
    const e = node.expression;
    if (e?.nodeType === 'MemberAccess' && NAMES.has(e.memberName)) return `${e.memberName}()`;
    if (e?.nodeType === 'MemberAccess' && e.memberName === RAW_PUSH && e.expression?.name === 'LibDelivery') {
      return `LibDelivery.${RAW_PUSH}()`;
    }
    if (e?.nodeType === 'FunctionCallOptions' && (e.names ?? []).includes('value')) return 'native value';
    const first = node.arguments?.[0];
    if (
      e?.nodeType === 'MemberAccess' && e.memberName === 'encodeCall' && e.expression?.name === 'abi'
        && first?.nodeType === 'MemberAccess' && NAMES.has(first.memberName)
    ) return `encodeCall(${first.memberName})`;
    return undefined;
  }
  if (node.nodeType === 'MemberAccess' && node.memberName === 'selector') {
    const inner = node.expression;
    if (inner?.nodeType === 'MemberAccess' && NAMES.has(inner.memberName)) return `${inner.memberName}.selector`;
  }
  return undefined;
}

/** Every transfer in the Diamond's code outside {HOMES}. Pure. */
export function transferSites(units, { sourceText = () => undefined } = {}) {
  const sites = new Map();
  for (const unit of units) {
    const path = unit.absolutePath;
    if (typeof path !== 'string' || !SCOPE.test(path) || HOMES.has(path)) continue;
    const text = sourceText(path);
    walk(unit, (node, ancestors) => {
      const label = transferKind(node);
      if (!label) return;
      // A member call nested in its own options node is counted once.
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
      problems.push(`${key}: ${site.count} raw transfer(s) outside the outflow policy and LibDelivery (${where}) — pay through LibVaultOutflow, or LibDelivery.pushExact / pushOut (which credit a protected wallet's vault), or list the site with its reason`);
    } else if (entry.count !== site.count) {
      problems.push(`${key}: listed with ${entry.count} transfer(s), found ${site.count} (${where}) — a changed count is a new transfer to justify`);
    }
  }
  for (const e of allowed) {
    if (!sites.has(e.site)) problems.push(`${e.site}: listed, but transfers nothing any more — remove the entry`);
  }
  return problems;
}

export function main(argv = process.argv.slice(2)) {
  let outDir = BUILD_OUT_DIR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) outDir = argv[++i];
    else {
      console.error(`check-raw-payouts: unknown argument ${argv[i]}`);
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
  for (const h of HOMES) {
    if (!units.some((u) => u.absolutePath === h)) {
      console.error(`  ✗ ${h} is not among the compiled sources — the check would see nothing`);
      return 1;
    }
  }
  const sites = transferSites(units, {
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
  const total = [...sites.values()].reduce((n, s) => n + s.count, 0);
  console.log(`  ✓ the Diamond moves value only through the outflow policy and LibDelivery, or at a listed site (${sites.size} listed, ${total} transfers)`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
