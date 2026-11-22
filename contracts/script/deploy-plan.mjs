#!/usr/bin/env node
/**
 * deploy-plan.mjs — a deploy's desired state and the plan derived from it
 * (#3111; deploy rehearsal design sections 3 and 16).
 *
 *   check <desired.json>
 *       Validates the desired-state file: known chain slugs, exactly one
 *       canonical chain, every keeper flag one the keeper reads, every setting
 *       complete, the Terms version published by the site.
 *
 *   plan <desired.json> [--anchor <unix>|today] [--env-file <path>]
 *       Prints the ordered plan `script/rehearse.sh --plan` executes and the
 *       operator follows for the real deploy: every deploy-script phase in its
 *       order, then each step the scripts do not take, as its exact command
 *       text (`cmd`). A step that has no command yet is printed as `manual`,
 *       which a rehearsal reports as not covered (its verdict is then never
 *       green). The plan's first comment carries the desired file's hash, so
 *       the plan digest the verdict records covers the file too.
 *
 *       Lanes and the canonical chain's expected reward sources are DERIVED
 *       from the chain set. The operator `.env` still carries them (the deploy
 *       scripts read them there), so the plan refuses when an `.env` value is
 *       missing or disagrees with the derived one, naming the value to set.
 *
 * Hand steps run from `contracts/`, in a shell that has loaded `.env` and
 * sourced `script/lib/rehearsal.sh` (for `vk_cast_send`). In a rehearsal the
 * driver provides both and sets `RPC` to the fork; in the real deploy `RPC` is
 * unset and each command falls back to the chain's own RPC variable.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const CONTRACTS_DIR = join(HERE, '..');
export const REPO_ROOT = join(CONTRACTS_DIR, '..');

/** The chains deploy-testnet.sh / deploy-mainnet.sh know, by slug. */
/**
 * The chains the deploy scripts know. `canonicalReward` marks the chain
 * `Deployments.isCanonicalRewardChainId` names: the configure step makes it
 * the canonical reward chain whatever a desired-state file says, so the file's
 * role must agree (a test pins this set to that function).
 */
export const CHAINS = {
  'base-sepolia': { chainId: 84532, prefix: 'BASE_SEPOLIA', network: 'testnet', canonicalReward: true },
  sepolia: { chainId: 11155111, prefix: 'SEPOLIA', network: 'testnet' },
  'arb-sepolia': { chainId: 421614, prefix: 'ARB_SEPOLIA', network: 'testnet' },
  'op-sepolia': { chainId: 11155420, prefix: 'OP_SEPOLIA', network: 'testnet' },
  'bnb-testnet': { chainId: 97, prefix: 'BNB_TESTNET', network: 'testnet' },
  'polygon-amoy': { chainId: 80002, prefix: 'POLYGON_AMOY', network: 'testnet' },
};

/** The source of a testnet setting copied from the deployment being replaced (design ruling 2026-11-22, item 6b). */
export const CARRIED = 'carried from the deployment being replaced, not an owner decision';
const ROLE_RE = /^[A-Z][A-Z0-9_]*_ROLE$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const SIG_RE = /^[a-zA-Z_][a-zA-Z0-9_]*\([a-z0-9,\[\]]*\)$/;
const GETTER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*\([a-z0-9,\[\]]*\)\([a-z0-9,\[\]()]+\)$/;

/** Every `*_ENABLED` flag the keeper's environment type names. */
export function keeperFlags(root = REPO_ROOT) {
  const text = readFileSync(join(root, 'apps/keeper/src/env.ts'), 'utf8');
  return new Set([...text.matchAll(/^\s*([A-Z][A-Z0-9_]*_ENABLED)\?:\s*string;/gm)].map((m) => m[1]));
}

/** Published Terms versions → their keccak256 hash, from the site's list. */
export function termsVersions(root = REPO_ROOT) {
  const text = readFileSync(join(root, 'apps/www/src/pages/terms/versions.ts'), 'utf8');
  const out = new Map();
  for (const m of text.matchAll(/version:\s*(\d+),[\s\S]*?canonicalMdKeccak256:\s*'(0x[0-9a-f]{64})'/g)) {
    out.set(Number(m[1]), m[2]);
  }
  return out;
}

/** A setting's setter arguments, getter arguments and expected read-back words. */
export const settingArgs = (s) => s.args ?? (s.value === undefined ? [] : [s.value]);
export const settingExpect = (s) => s.expect ?? (s.value === undefined ? [] : [s.value]);

const canonicalOf = (d) => Object.entries(d.chains).find(([, c]) => c.role === 'canonical')?.[0];
const settingChains = (s, d) => (s.chains === 'all' ? Object.keys(d.chains) : s.chains);

/** Problems with a desired-state file, as strings. Pure over its inputs. */
export function validate(d, { flags, terms }) {
  const p = [];
  if (!d || typeof d !== 'object') return ['not a JSON object'];
  if (!['testnet', 'mainnet'].includes(d.network)) p.push(`network must be testnet or mainnet`);
  const slugs = Object.keys(d.chains ?? {});
  if (!slugs.length) p.push('no chains');
  for (const s of slugs) {
    if (!CHAINS[s]) p.push(`chain ${s}: not a chain the deploy scripts know`);
    else if (CHAINS[s].network !== d.network) p.push(`chain ${s}: not a ${d.network} chain`);
    if (!['canonical', 'mirror'].includes(d.chains[s]?.role)) p.push(`chain ${s}: role must be canonical or mirror`);
    else if (CHAINS[s] && (d.chains[s].role === 'canonical') !== Boolean(CHAINS[s].canonicalReward)) {
      p.push(`chain ${s}: role ${d.chains[s].role} disagrees with the deploy scripts, which make ${Object.keys(CHAINS).filter((c) => CHAINS[c].canonicalReward).join(', ')} the canonical reward chain`);
    }
  }
  const canon = slugs.filter((s) => d.chains[s]?.role === 'canonical');
  if (canon.length !== 1) p.push(`exactly one canonical chain is needed (found ${canon.length})`);

  const r = d.rewards ?? {};
  if (r.anchor !== null && r.anchor !== undefined && !(Number.isInteger(r.anchor) && r.anchor % 86400 === 0)) {
    p.push('rewards.anchor must be null or a unix time at 00:00 UTC');
  }
  if (!/^[1-9][0-9]*$/.test(String(r.baseRewardPoolVpfi ?? ''))) p.push('rewards.baseRewardPoolVpfi must be a whole number of VPFI');
  if (r.poolFundedFrom !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(r.poolFundedFrom)) p.push('rewards.poolFundedFrom must be a signing role name');

  const roles = d.roles ?? {};
  for (const k of ['admin', 'deployer', 'treasury']) {
    if (!/^[A-Z][A-Z0-9_]*_ADDRESS$/.test(roles[k] ?? '')) p.push(`roles.${k} must name the .env variable carrying the address`);
  }
  for (const [name, holder] of Object.entries(roles.bots ?? {})) {
    if (!ADDR_RE.test(holder?.address ?? '')) p.push(`roles.bots.${name}: address missing or malformed`);
    if (!Array.isArray(holder?.roles) || !holder.roles.length || holder.roles.some((x) => !ROLE_RE.test(x))) {
      p.push(`roles.bots.${name}: roles must be a list of *_ROLE names`);
    }
  }
  if (d.records?.keeperAddress !== undefined && !Object.prototype.hasOwnProperty.call(roles.bots ?? {}, d.records.keeperAddress)) {
    p.push(`records.keeperAddress names ${d.records.keeperAddress}, which is not under roles.bots`);
  }

  if (d.terms !== undefined) {
    if (!terms.has(d.terms.version)) p.push(`terms.version ${d.terms.version} is not published in apps/www/src/pages/terms/versions.ts`);
  }

  for (const [i, s] of (d.settings ?? []).entries()) {
    const where = `settings[${i}] ${s.setter ?? ''}`;
    if (!SIG_RE.test(s.setter ?? '')) p.push(`${where}: setter must be a signature like setX(bool)`);
    if (!GETTER_RE.test(s.getter ?? '')) p.push(`${where}: getter must be a signature with its return, like getX()(bool)`);
    const words = [...settingArgs(s), ...(s.getterArgs ?? []), ...settingExpect(s)];
    if (!settingArgs(s).length || !settingExpect(s).length) p.push(`${where}: needs value, or args and expect`);
    if (words.some((w) => typeof w !== 'string' || !w || /[#'"`$\\\s(),]/.test(w))) p.push(`${where}: each value must be one plain word`);
    if (typeof s.source !== 'string' || s.source.length < 10) p.push(`${where}: source must say where the value comes from (an owner decision, or "${CARRIED}")`);
    else if (s.source === CARRIED && d.network === 'mainnet') p.push(`${where}: a mainnet value is the owner's to decide; a carried row is refused`);
    const on = s.chains === 'all' ? slugs : s.chains;
    if (!Array.isArray(on) || !on.length || on.some((c) => !slugs.includes(c))) p.push(`${where}: chains must be "all" or a list of the file's chains`);
  }

  const armed = d.keeper?.armed ?? {};
  for (const s of slugs) if (!Array.isArray(armed[s])) p.push(`keeper.armed: no list for ${s}`);
  for (const [s, list] of Object.entries(armed)) {
    if (!slugs.includes(s)) p.push(`keeper.armed: ${s} is not one of the file's chains`);
    for (const f of list ?? []) if (!flags.has(f)) p.push(`keeper.armed.${s}: ${f} is not a flag the keeper reads (apps/keeper/src/env.ts)`);
    if ((list ?? []).length && !(list ?? []).includes('KEEPER_ENABLED')) p.push(`keeper.armed.${s}: KEEPER_ENABLED is needed for any pass to run`);
  }

  if (d.serviceCapacityEscrow !== undefined) {
    const e = d.serviceCapacityEscrow;
    if (e !== 'all' && !(Array.isArray(e) && e.every((c) => slugs.includes(c)))) p.push('serviceCapacityEscrow must be "all" or a list of the file\'s chains');
  }
  if (d.sanctionsClearance !== undefined) {
    const { attestor, timelocks } = d.sanctionsClearance ?? {};
    if (!slugs.includes(attestor)) p.push('sanctionsClearance.attestor must be one of the file\'s chains');
    if (!Array.isArray(timelocks) || !timelocks.length || timelocks.some((t) => !slugs.includes(t) || t === attestor) || new Set(timelocks).size !== timelocks.length) {
      p.push('sanctionsClearance.timelocks must list other chains of the file, each once');
    }
  }
  for (const [i, m] of (d.manual ?? []).entries()) {
    if (!m.after || !['configure', 'launch'].includes(m.after)) p.push(`manual[${i}]: after must be configure or launch`);
    if (!m.what || m.what.length < 20) p.push(`manual[${i}]: needs a description (what)`);
  }
  return p;
}

/** Lanes per chain: the canonical chain reaches every mirror, a mirror only the canonical. Pure. */
export function derivedLanes(d) {
  const canon = canonicalOf(d);
  const out = {};
  for (const s of Object.keys(d.chains)) {
    const ids = s === canon ? Object.keys(d.chains).filter((x) => x !== canon).map((x) => CHAINS[x].chainId) : [CHAINS[canon].chainId];
    out[s] = ids.sort((a, b) => a - b);
  }
  return out;
}

/** The canonical chain's expected reward sources: every chain, itself included. Pure. */
export function derivedRewardSources(d) {
  return Object.keys(d.chains).map((s) => CHAINS[s].chainId).sort((a, b) => a - b);
}

const idSet = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean).map(Number).sort((a, b) => a - b).join(',');

/**
 * Values of the named variables as the deploy resolves them: the env file is
 * read by the deploy scripts' own loader (`lib/load-env.sh`), in a child
 * shell, over this process's environment, with key variables dropped. One
 * parser, so quoting, inline comments and an exported value the file
 * replaces are taken exactly as the deploy takes them. Returns
 * `{ values }`, or `{ error }` when the loader refuses the file.
 */
export function loaderValues(envFile, names, env = process.env) {
  // A committed script reads the file; the path and the names reach it only
  // as arguments, never as command text. The path is still resolved and
  // required to be a regular file, and every name to be UPPER_SNAKE.
  const file = resolve(envFile);
  let st;
  try { st = statSync(file); } catch { return { error: `${envFile}: no such file` }; }
  if (!st.isFile()) return { error: `${envFile}: not a regular file` };
  if (!names.every((n) => /^[A-Z_][A-Z0-9_]*$/.test(n))) return { error: 'a variable name is not UPPER_SNAKE' };
  const r = spawnSync('bash', [join(HERE, 'lib', 'env-values.sh'), file, ...names], { encoding: 'utf8', env });
  if (r.status !== 0) return { error: (r.stderr || '').trim().split('\n').filter((l) => /^Error/.test(l)).join('; ') || `the loader refused ${envFile}` };
  const parts = r.stdout.split('\0');
  const values = {};
  for (let i = 0; i + 1 < parts.length; i += 2) values[parts[i]] = parts[i + 1];
  return { values };
}

/** Disagreements between the derived topology and the operator's env. Pure. */
export function envDisagreements(d, env) {
  const p = [];
  const lanes = derivedLanes(d);
  for (const [s, ids] of Object.entries(lanes)) {
    const v = `CCIP_LANE_CHAIN_IDS_${CHAINS[s].prefix}`;
    if (!env[v]) p.push(`${v} is not set; the chain set gives ${ids.join(',')}`);
    else if (idSet(env[v]) !== ids.join(',')) p.push(`${v}=${env[v]}, but the chain set gives ${ids.join(',')}`);
  }
  if (env.CCIP_LANE_CHAIN_IDS) p.push('CCIP_LANE_CHAIN_IDS (the one-run override) is set; a planned deploy uses the per-chain values only');
  const src = derivedRewardSources(d).join(',');
  if (!env.REWARD_EXPECTED_SOURCE_CHAIN_IDS) p.push(`REWARD_EXPECTED_SOURCE_CHAIN_IDS is not set; the chain set gives ${src}`);
  else if (idSet(env.REWARD_EXPECTED_SOURCE_CHAIN_IDS) !== src) p.push(`REWARD_EXPECTED_SOURCE_CHAIN_IDS=${env.REWARD_EXPECTED_SOURCE_CHAIN_IDS}, but the chain set gives ${src}`);
  return p;
}

const PAUSABLE_SLOT = '0x2160e84a745d8897ad2778886d40d3563c8bc30c059c5f2173e21e9d47057400';
const VPFI_DECIMALS = 18n;

/** The prefix every hand step on a chain starts with: its Diamond and its RPC. */
function on(slug) {
  return `D=$(jq -r .diamond "\${VAIPAKAM_REHEARSAL_ROOT:-deployments}/${slug}/addresses.json"); R="\${RPC:-$${CHAINS[slug].prefix}_RPC_URL}";`;
}

/** The ordered plan as text. Pure over its arguments. */
export function buildPlan(d, { anchor, terms, desiredDigest, desiredPath }) {
  const slugs = Object.keys(d.chains);
  const canon = canonicalOf(d);
  const mirrors = slugs.filter((s) => s !== canon);
  const ordered = [canon, ...mirrors];
  const L = [];
  const step = (s, phase, ...flags) => L.push(`step ${s} ${phase}${flags.length ? ` ${flags.join(' ')}` : ''}`);
  const cmd = (s, text) => {
    if (text.includes('#')) throw new Error(`a hand step may not contain '#': ${text}`);
    L.push(`cmd ${s} -- ${text}`);
  };
  const manual = (s, text) => L.push(`manual ${s} -- ${text.replace(/#/g, 'no.')}`);
  const say = (t) => L.push(`# ${t}`);

  L.push(`# desired ${desiredPath} sha256 ${desiredDigest}`);
  L.push(`# generated by script/deploy-plan.mjs; do not edit by hand.`);
  L.push(`# Hand steps run from contracts/ with .env loaded and script/lib/rehearsal.sh sourced.`);
  L.push(`chains ${ordered.join(' ')}`);
  say('Deploy-script phases (docs/ops/TestnetFreshDeployGuide.md section 3).');
  for (const s of ordered) step(s, 'preflight');
  for (const s of ordered) step(s, 'contracts', '--confirm-i-have-multisig-ready', '--fresh');
  for (const s of ordered) step(s, 'ccip-wire');
  for (const s of ordered) if (d.chains[s].swapAdapters) step(s, 'swap-adapters');
  for (const s of ordered) step(s, 'testnet-mocks');
  for (const s of ordered) step(s, 'configure');

  say('Reward custody activation, under the born-paused state (guide 5.4).');
  for (const s of ordered) {
    cmd(s, `${on(s)} E=$(cast to-dec $(cast shr $(cast storage "$D" ${PAUSABLE_SLOT} --rpc-url "$R") 136)); REWARD_CUSTODY_PAUSE_EPOCH="$E" forge script script/ActivateRewardCustody.s.sol --rpc-url "$R" --broadcast --slow`);
    cmd(s, `${on(s)} forge script script/ActivateRewardCustody.s.sol --sig 'record()' --rpc-url "$R"`);
  }

  say('Bot roles, and the keeper address record the app reads (guide 5.2).');
  for (const s of ordered) {
    for (const [, holder] of Object.entries(d.roles.bots ?? {})) {
      for (const role of holder.roles) {
        cmd(s, `${on(s)} vk_cast_send ADMIN "$D" 'grantRole(bytes32,address)' $(cast keccak ${role}) ${holder.address} --rpc-url "$R"`);
        cmd(s, `${on(s)} test "$(cast call "$D" 'hasRole(bytes32,address)(bool)' $(cast keccak ${role}) ${holder.address} --rpc-url "$R")" = true`);
      }
    }
    if (d.records?.keeperAddress) {
      const a = d.roles.bots[d.records.keeperAddress].address;
      const f = `"\${VAIPAKAM_REHEARSAL_ROOT:-deployments}/${s}/addresses.json"`;
      cmd(s, `jq --arg k ${a} '.keeperAddress = $k' ${f} > ${f}.tmp && mv ${f}.tmp ${f}`);
    }
  }

  if (d.terms) {
    const hash = terms.get(d.terms.version);
    say(`Terms version ${d.terms.version} (guide 5.3).`);
    for (const s of ordered) {
      cmd(s, `${on(s)} vk_cast_send ADMIN "$D" 'publishTos(uint32,bytes32)' ${d.terms.version} ${hash} --rpc-url "$R"`);
      cmd(s, `${on(s)} test "$(cast call "$D" 'getCurrentTos()(uint32,bytes32)' --rpc-url "$R" | tr '\\n' ' ')" = "${d.terms.version} ${hash} "`);
    }
  }

  const escrowOn = d.serviceCapacityEscrow === 'all' ? ordered : d.serviceCapacityEscrow ?? [];
  if (escrowOn.length) say('Bind the service capacity deposit escrow, record it, read it back (guide 5.6).');
  for (const s of escrowOn) {
    cmd(s, `${on(s)} forge script script/BindServiceCapacityEscrow.s.sol --rpc-url "$R" --broadcast`);
    cmd(s, `${on(s)} forge script script/BindServiceCapacityEscrow.s.sol --sig 'record()' --rpc-url "$R"`);
    cmd(s, `${on(s)} test "$(cast call "$D" 'getServiceCapacityEscrow()(address,uint64,uint256)' --rpc-url "$R" | head -1)" != 0x0000000000000000000000000000000000000000`);
  }

  say('Settings profile: applied, then read back (guide 5.6).');
  for (const s of ordered) {
    for (const st of d.settings ?? []) {
      if (!settingChains(st, d).includes(s)) continue;
      const exp = settingExpect(st);
      const gargs = (st.getterArgs ?? []).map((a) => ` ${a}`).join('');
      cmd(s, `${on(s)} vk_cast_send ADMIN "$D" '${st.setter}' ${settingArgs(st).join(' ')} --rpc-url "$R"`);
      // The read-back compares the first words of the getter's output, with
      // cast's [1e18] annotations, tuple brackets and commas removed.
      cmd(s, `${on(s)} test "$(cast call "$D" '${st.getter}'${gargs} --rpc-url "$R" | sed 's/ \\[[^]]*\\]//g' | tr -d '(),' | tr -s ' \\n' '  ' | cut -d' ' -f1-${exp.length} | tr 'A-F' 'a-f')" = "${exp.join(' ').toLowerCase()}"`);
    }
  }

  const sc = d.sanctionsClearance;
  if (sc) {
    const ids = sc.timelocks.map((x) => CHAINS[x].chainId).join(',');
    say(`Rewire the sanctions delisting clearance: the attestor on ${sc.attestor} first, then each timelock chain (guide 5.1).`);
    for (const s of [sc.attestor, ...sc.timelocks]) {
      cmd(s, `${on(s)} SANCTIONS_CLEARANCE_ATTESTOR_CHAIN_ID=${CHAINS[sc.attestor].chainId} SANCTIONS_CLEARANCE_TIMELOCK_CHAIN_IDS=${ids} forge script script/ConfigureSanctionsClearance.s.sol --rpc-url "$R" --broadcast --slow`);
    }
  }

  for (const m of (d.manual ?? []).filter((x) => x.after === 'configure')) {
    for (const s of m.chains === 'all' ? ordered : m.chains) m.run ? cmd(s, `${on(s)} ${m.run}`) : manual(s, m.what);
  }

  const wei = (BigInt(d.rewards.baseRewardPoolVpfi) * 10n ** VPFI_DECIMALS).toString();
  const from = d.rewards.poolFundedFrom ?? 'ADMIN';
  say(`Fund the canonical reward pool with ${d.rewards.baseRewardPoolVpfi} VPFI before its anchor (guide 5.5 step 1).`);
  const V = `V=$(jq -r .vpfiToken "\${VAIPAKAM_REHEARSAL_ROOT:-deployments}/${canon}/addresses.json");`;
  if (from !== 'ADMIN') cmd(canon, `${on(canon)} ${V} vk_cast_send ${from} "$V" 'transfer(address,uint256)' "$(vk_role_address ADMIN)" ${wei} --rpc-url "$R"`);
  cmd(canon, `${on(canon)} ${V} vk_cast_send ADMIN "$V" 'approve(address,uint256)' "$D" ${wei} --rpc-url "$R"`);
  cmd(canon, `${on(canon)} vk_cast_send ADMIN "$D" 'fundRewardPool(uint256)' ${wei} --rpc-url "$R"`);

  say(`Rewards anchor ${anchor}, the canonical chain first, one value everywhere (guide 5.5 step 2).`);
  for (const s of ordered) cmd(s, `${on(s)} INTERACTION_LAUNCH_TIMESTAMP=${anchor} forge script script/SetInteractionLaunch.s.sol --rpc-url "$R" --broadcast`);

  say('Arm the first capped day on the canonical chain: tomorrow by the reward clock (guide 5.5 step 3).');
  cmd(canon, `${on(canon)} T=$(cast call "$D" 'getInteractionCurrentDay()(uint256,bool)' --rpc-url "$R" | head -1 | cut -d' ' -f1); vk_cast_send ADMIN "$D" 'setGovernorCommitArmedFromDay(uint256)' $((T + 1)) --rpc-url "$R"`);

  say('Move to the start of the armed day, then launch (guide 5.5 steps 4 and 5).');
  // The armed day's start is read from the chain (anchor + armed day x 1 day),
  // never a fixed distance: a future anchor or a late-day arming would miss it.
  L.push(`clock armed ${canon}`);
  step(canon, 'launch');
  for (const m of (d.manual ?? []).filter((x) => x.after === 'launch')) {
    for (const s of m.chains === 'all' ? ordered : m.chains) m.run ? cmd(s, `${on(s)} ${m.run}`) : manual(s, m.what);
  }
  if (mirrors.length) {
    // A mirror launches only once the canonical chain's broadcast carrying the
    // armed day has landed. The mirrors are still paused, so they send no
    // report, and the canonical chain finalizes the closed day only after the
    // reward grace has run from its own report (guide 5.5 step 5).
    say(`Close, finalize and broadcast the day before the armed day on ${canon}, so the mirrors learn it (guide 5.5 step 5).`);
    // The closed day is the day before the ARMED day, read from the chain's
    // commit state each time: the current day can move on during the grace
    // wait, the armed day cannot.
    const prev = `P=$(( $(cast call "$D" 'getGovernorCommitState()(uint256,uint256,uint256,uint256)' --rpc-url "$R" | head -1 | cut -d' ' -f1) - 1 ));`;
    cmd(canon, `${on(canon)} ${prev} vk_cast_send ADMIN "$D" 'closeDay(uint256)' "$P" --rpc-url "$R"`);
    // The grace is read from the chain when the wait starts, so whatever
    // installed it (a desired-state row in either form, REWARD_GRACE_SECONDS
    // or the configure default) is the figure waited for.
    L.push(`clock grace ${canon}`);
    cmd(canon, `${on(canon)} ${prev} vk_cast_send ADMIN "$D" 'finalizeDay(uint256)' "$P" --rpc-url "$R"`);
    cmd(canon, `${on(canon)} ${prev} F=$(cast call "$D" 'quoteBroadcastGlobal(uint256)(uint256)' "$P" --rpc-url "$R" | cut -d' ' -f1); vk_cast_send ADMIN "$D" 'broadcastGlobal(uint256)' "$P" --value "$F" --rpc-url "$R"`);
  }
  for (const s of mirrors) L.push(`relay ${canon} ${s}`);
  for (const s of mirrors) step(s, 'launch');
  for (const s of ordered) step(s, 'verify');
  step(canon, 'abi-sync');

  say('Keeper passes to arm on each chain after the deploy (applied on the keeper machine, not here):');
  for (const s of ordered) say(`  ${s}: ${(d.keeper.armed[s] ?? []).join(' ')}`);
  return `${L.join('\n')}\n`;
}

/** 00:00 UTC of the day `nowSec` falls in. */
export const todayAnchor = (nowSec) => nowSec - (nowSec % 86400);

function readDesired(path) {
  const text = readFileSync(path, 'utf8');
  return { d: JSON.parse(text), digest: createHash('sha256').update(text).digest('hex') };
}

export function main(argv = process.argv.slice(2), { now = () => Math.floor(Date.now() / 1000), env = process.env } = {}) {
  const [cmdName, file, ...rest] = argv;
  if (!['check', 'plan'].includes(cmdName) || !file) {
    console.error('usage: deploy-plan.mjs check <desired.json> | plan <desired.json> [--anchor <unix>|today] [--env-file <path>]');
    return 2;
  }
  let d;
  let digest;
  try {
    ({ d, digest } = readDesired(file));
  } catch (e) {
    console.error(`  ✗ cannot read ${file}: ${e.message}`);
    return 1;
  }
  const terms = termsVersions();
  const problems = validate(d, { flags: keeperFlags(), terms });
  for (const p of problems) console.error(`  ✗ ${p}`);
  if (problems.length) return 1;
  if (cmdName === 'check') {
    console.log(`  ✓ ${file}: ${Object.keys(d.chains).length} chains, ${(d.settings ?? []).length} settings, keeper flags known`);
    return 0;
  }

  const ai = rest.indexOf('--anchor');
  let anchor = d.rewards.anchor ?? null;
  if (ai >= 0) {
    const a = rest[ai + 1];
    const v = a === 'today' ? todayAnchor(now()) : Number(a);
    if (!Number.isInteger(v) || v % 86400 !== 0) {
      console.error('  ✗ --anchor must be today or a unix time at 00:00 UTC');
      return 1;
    }
    if (anchor !== null && anchor !== v) {
      console.error(`  ✗ --anchor ${v} disagrees with rewards.anchor ${anchor} in the file`);
      return 1;
    }
    anchor = v;
  }
  if (anchor === null) {
    console.error('  ✗ the rewards anchor is not set: pass --anchor today (or a unix time at 00:00 UTC), or set rewards.anchor');
    return 1;
  }

  const names = [...Object.values(CHAINS).map((c) => `CCIP_LANE_CHAIN_IDS_${c.prefix}`), 'CCIP_LANE_CHAIN_IDS', 'REWARD_EXPECTED_SOURCE_CHAIN_IDS'];
  const ei = rest.indexOf('--env-file');
  let values = Object.fromEntries(names.map((n) => [n, env[n]]));
  if (ei >= 0) {
    const r = loaderValues(rest[ei + 1], names, env);
    if (r.error) {
      console.error(`  ✗ ${rest[ei + 1]}: ${r.error}`);
      return 1;
    }
    values = r.values;
  }
  const dis = envDisagreements(d, values);
  for (const p of dis) console.error(`  ✗ ${p}`);
  if (dis.length) return 1;

  try {
    process.stdout.write(buildPlan(d, { anchor, terms, desiredDigest: digest, desiredPath: relative(CONTRACTS_DIR, resolve(file)) || file }));
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
