#!/usr/bin/env node
/**
 * readback.mjs — compares deployed chains with the desired-state file, row by
 * row (#3893, deploy rehearsal design sections 6 and 17).
 *
 *   node script/readback.mjs <desired.json> [--records <dir>] [--broadcast <dir>]
 *        [--prior-root <dir>] [--env-file <path>] [--rpc <slug>=<url>]...
 *        [--since <unix>] [--anchor <unix>] [--json <path>]
 *
 * One readback, used on the rehearsal's forks and on the live chains after the
 * real deploy. Each row is { id, chain, expected, found, result, by }, where
 * result is `met`, `not met`, `unreadable`, `info` or `awaiting ruling`. Any row
 * that is not met or unreadable fails the run (exit 1); an info row never does,
 * and neither does a row whose rule the design thread has not given yet.
 *
 * What it reads:
 *   - each chain through `cast call` against `--rpc <slug>=<url>`, or the
 *     chain's `<PREFIX>_RPC_URL` (RH_CAST names another cast, for tests);
 *   - the run's records under `--records` (default
 *     `$VAIPAKAM_REHEARSAL_ROOT`, else `deployments`): each chain's
 *     addresses.json, storage-layout record and the archive manifest;
 *   - the run's broadcast journals under `--broadcast` (default
 *     `<records>/.forge/broadcast` when that exists, else `broadcast`);
 *   - the records the run replaced: `--prior-root <dir>`, or by default each
 *     chain's addresses.json as committed at HEAD.
 *
 * Rows it does not cover yet, stated so a green run is not read as more:
 * the pool rate limits and their admin, the token's CCIP registration, the
 * delisting route's clearance source and the feed bindings. The keeper's
 * arming flags (`keeper.armed`) live on the keeper machine, not on a chain,
 * so this script does not read them either. The launch row
 * reads the pause bit; the launch decision itself (`Launch.s.sol
 * requireLaunched`) is the deploy's own launch phase.
 */
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CHAINS,
  CONTRACTS_DIR,
  REPO_ROOT,
  addressGetters,
  canonicalOf,
  derivedLanes,
  derivedRewardSources,
  keeperFlags,
  loaderValues,
  readDesired,
  settingChains,
  settingExpect,
  termsVersions,
  validate,
} from './deploy-plan.mjs';

export const MET = 'met';
export const NOT_MET = 'not met';
export const UNREADABLE = 'unreadable';
export const INFO = 'info';
/** A row whose rule is with the design thread: shown, never met and never a failure. */
export const AWAITING = 'awaiting ruling';

const ZERO = '0x0000000000000000000000000000000000000000';
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export const row = (id, chain, expected, found, result, by) => ({ id, chain, expected: String(expected), found: String(found), result, by });

/** A cast answer as lower-case words: annotations, brackets and commas removed. */
export function words(out) {
  return String(out)
    .replace(/ \[[^\]]*\]/g, '')
    .replace(/[()[\],]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** The roles `LibAccessControl.grantableRoles()` lists, by constant name, read from its source. */
export function grantableRoles(root = REPO_ROOT) {
  const text = readFileSync(join(root, 'contracts/src/libraries/LibAccessControl.sol'), 'utf8');
  const body = text.match(/function grantableRoles\(\)[\s\S]*?\{([\s\S]*?)\n\s*\}/);
  if (!body) throw new Error('LibAccessControl.grantableRoles() not found');
  return [...body[1].matchAll(/roles\[\d+\]\s*=\s*([A-Z_]+);/g)].map((m) => m[1]);
}

/** Every selector the facets in diamond-facets.json carry, from their compiled artifacts. */
export function expectedSelectors(root = REPO_ROOT, out = join(CONTRACTS_DIR, 'out')) {
  const manifest = JSON.parse(readFileSync(join(root, 'packages/contracts/scripts/diamond-facets.json'), 'utf8'));
  const set = new Set();
  const missing = [];
  // DiamondCutFacet is installed by the constructor and is not enumerated by
  // the loupe, so its selector is not part of the set the loupe reports.
  for (const f of manifest.facets.filter((x) => x !== 'DiamondCutFacet')) {
    const p = join(out, `${f}.sol`, `${f}.json`);
    if (!existsSync(p)) { missing.push(f); continue; }
    for (const sel of Object.values(JSON.parse(readFileSync(p, 'utf8')).methodIdentifiers ?? {})) set.add(`0x${sel.toLowerCase()}`);
  }
  return { set, missing };
}

/** keccak256('eip1967.proxy.implementation') - 1, where an ERC-1967 proxy keeps its code's address. */
export const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

/**
 * The peer each messenger names per channel, by the remote chain's record key
 * (ConfigureCcip._wireChannelPeers): Base names each mirror's contracts, a
 * mirror names Base's.
 */
export const CHANNEL_PEERS = {
  canonical: { 'vpfi-reward': 'rewardMessenger', 'vpfi-buyback': 'diamond', 'vpfi-reward-budget': 'rewardRemittanceReceiver', 'vpfi-return': 'vpfiReturnSender' },
  mirror: { 'vpfi-reward': 'rewardMessenger', 'vpfi-buyback': 'buybackRemittanceReceiver', 'vpfi-reward-budget': 'diamond', 'vpfi-return': 'vpfiReturnReceiver' },
};

/**
 * Every address a run created, by chain id, from forge's run-latest journals
 * under `dir`. With `since` (unix seconds), a journal forge stamped earlier
 * is a previous run's and is left out, as `deploy-testnet.sh`'s
 * `require_broadcast_ok` does.
 */
export function createdAddresses(dir, since) {
  const byChain = new Map();
  if (!dir || !existsSync(dir)) return byChain;
  for (const script of readdirSync(dir)) {
    const sdir = join(dir, script);
    if (!statSync(sdir).isDirectory()) continue;
    for (const chainId of readdirSync(sdir)) {
      const p = join(sdir, chainId, 'run-latest.json');
      if (!/^\d+$/.test(chainId) || !existsSync(p)) continue;
      const j = JSON.parse(readFileSync(p, 'utf8'));
      if (since !== undefined) {
        let t = Number(j.timestamp ?? 0);
        if (t > 100000000000) t = Math.floor(t / 1000); // forge stamps milliseconds
        if (t < since) continue;
      }
      const list = byChain.get(Number(chainId)) ?? [];
      for (const t of j.transactions ?? []) {
        if (/^CREATE2?$/.test(t.transactionType ?? '') && t.contractAddress) list.push({ address: t.contractAddress, name: t.contractName ?? '', script });
        for (const a of t.additionalContracts ?? []) if (a.address) list.push({ address: a.address, name: a.contractName ?? '', script });
      }
      byChain.set(Number(chainId), list);
    }
  }
  return byChain;
}

/** Every address string anywhere in a JSON value, lower-cased. */
export function addressesIn(v, out = new Set()) {
  if (typeof v === 'string' && ADDR_RE.test(v)) out.add(v.toLowerCase());
  else if (Array.isArray(v)) v.forEach((x) => addressesIn(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => addressesIn(x, out));
  return out;
}

/**
 * The rows. Pure over its inputs: `call(slug, to, sig, args)` returns cast's
 * answer or throws, `code(slug, addr)` returns the runtime code as hex.
 * `records[slug]` / `prior[slug]` are parsed addresses.json objects (or
 * undefined), `files` answers file questions about the records.
 */
export function readback(d, ctx) {
  const { call, code, records, prior, env, terms, roles, getters, selectors, created, manifest, files, anchor } = ctx;
  // `created` null: the journals cannot be told apart from earlier runs'.
  const unscoped = ctx.unscoped ?? 'the run start is unknown: pass --since <unix>';
  const R = [];
  const slugs = Object.keys(d.chains);
  const canon = canonicalOf(d);
  const ask = (s, to, sig, args = []) => {
    try { return { ok: true, w: words(call(s, to, sig, args)) }; } catch (e) { return { ok: false, err: String(e.message ?? e).split('\n')[0] }; }
  };
  // One comparison of a read with an expected list of words.
  const cmp = (id, s, by, to, sig, args, expected, { n = expected.length } = {}) => {
    const r = ask(s, to, sig, args);
    if (!r.ok) return R.push(row(id, s, expected.join(' '), r.err, UNREADABLE, by));
    const found = r.w.slice(0, n).join(' ');
    R.push(row(id, s, expected.join(' '), found, found === expected.join(' ').toLowerCase() ? MET : NOT_MET, by));
  };
  const addr = (k) => (ADDR_RE.test(env[k] ?? '') ? env[k].toLowerCase() : null);
  const admin = addr(d.roles.admin);
  const deployer = addr(d.roles.deployer);
  const treasury = addr(d.roles.treasury);
  const roleHash = (name) => (name === 'DEFAULT_ADMIN_ROLE' ? `0x${'0'.repeat(64)}` : ctx.keccak(name));

  const anchors = new Map();
  for (const s of slugs) {
    const rec = records[s];
    const D = rec?.diamond;
    if (!D || !ADDR_RE.test(D)) {
      R.push(row('records.diamond', s, 'a Diamond in addresses.json', rec ? 'none' : 'no addresses.json', NOT_MET, 'records'));
      continue;
    }

    let swapAdapters = [];

    // ── Settings and switches ───────────────────────────────────────────
    cmp('launch.paused', s, 'pause bit after launch', D, 'paused()(bool)', [], ['false']);
    if (d.terms) {
      cmp('terms.current', s, 'Terms version and hash', D, 'getCurrentTos()(uint32,bytes32)', [], [String(d.terms.version), terms.get(d.terms.version) ?? '(unpublished)']);
      if (d.terms.minAgeSec !== undefined) cmp('terms.minAge', s, 'Terms minimum age', D, 'getMinTermsAgeSec()(uint256)', [], [String(d.terms.minAgeSec)]);
      else {
        const r = ask(s, D, 'getMinTermsAgeSec()(uint256)');
        R.push(row('terms.minAge', s, 'not stated in the file', r.ok ? r.w[0] : r.err, r.ok ? INFO : UNREADABLE, 'Terms minimum age'));
      }
    }
    for (const st of d.settings ?? []) {
      if (!settingChains(st, d).includes(s)) continue;
      cmp(`setting.${st.getter.split('(')[0]}${st.getterArgs?.length ? `[${st.getterArgs.join(',')}]` : ''}`, s, `setting ${st.setter}`, D, st.getter, st.getterArgs ?? [], settingExpect(st));
    }

    // ── Roles ───────────────────────────────────────────────────────────
    if (!admin) R.push(row('roles.admin', s, `${d.roles.admin} set to an address`, env[d.roles.admin] ?? 'unset', UNREADABLE, 'roles'));
    else {
      for (const name of roles) cmp(`roles.admin.${name}`, s, 'admin holds every grantable role', D, 'hasRole(bytes32,address)(bool)', [roleHash(name), admin], ['true']);
      cmp('roles.owner', s, 'ERC-173 owner is the admin', D, 'owner()(address)', [], [admin]);
    }
    // A deployer that cannot be identified is a failure to read, never a pass:
    // otherwise a missing input would hide roles the deploy key kept.
    if (!deployer) R.push(row('roles.deployer', s, `${d.roles.deployer} set to an address`, env[d.roles.deployer] ?? 'unset', UNREADABLE, 'roles'));
    else if (deployer !== admin) {
      for (const name of roles) cmp(`roles.deployer.${name}`, s, 'deployer renounced every role', D, 'hasRole(bytes32,address)(bool)', [roleHash(name), deployer], ['false']);
    }
    for (const [bot, h] of Object.entries(d.roles.bots ?? {})) {
      for (const name of h.roles) cmp(`roles.${bot}.${name}`, s, `bot ${bot} holds its roles`, D, 'hasRole(bytes32,address)(bool)', [roleHash(name), h.address], ['true']);
    }
    if (treasury) cmp('roles.treasury', s, 'treasury the vault code names', D, 'getTreasury()(address)', [], [treasury]);
    else R.push(row('roles.treasury', s, `${d.roles.treasury} set to an address`, env[d.roles.treasury] ?? 'unset', UNREADABLE, 'roles'));

    // ── Rewards ─────────────────────────────────────────────────────────
    cmp('rewards.role', s, 'reward role (0 canonical, 1 mirror)', D, 'getRewardRole()(uint8)', [], [s === canon ? '0' : '1']);
    cmp('rewards.custody', s, 'reward custody activated', D, 'rewardCustodyActivated()(bool)', [], ['true']);
    {
      const r = ask(s, D, 'getInteractionLaunchTimestamp()(uint256)');
      if (!r.ok) R.push(row('rewards.anchor', s, anchor ?? 'equal on every chain', r.err, UNREADABLE, 'rewards anchor'));
      else anchors.set(s, r.w[0]);
    }
    if (s === canon) {
      const wei = (BigInt(d.rewards.baseRewardPoolVpfi) * 10n ** 18n).toString();
      cmp('rewards.pool', s, 'reward pool funded with the stated amount', D, 'armedFreshLedger()(uint256,uint256)', [], [wei], { n: 1 });
      const r = ask(s, D, 'getGovernorCommitState()(uint256,uint256,uint256,uint256)');
      R.push(r.ok
        ? row('rewards.firstCappedDay', s, 'armed (non-zero)', r.w[0], r.w[0] !== '0' ? MET : NOT_MET, 'first capped day')
        : row('rewards.firstCappedDay', s, 'armed (non-zero)', r.err, UNREADABLE, 'first capped day'));
      const src = ask(s, D, 'getExpectedSourceChainIds()(uint32[])');
      const want = derivedRewardSources(d).join(' ');
      R.push(src.ok
        ? row('rewards.sources', s, want, [...src.w].map(Number).sort((a, b) => a - b).join(' '), [...src.w].map(Number).sort((a, b) => a - b).join(' ') === want ? MET : NOT_MET, "Base's expected reward sources")
        : row('rewards.sources', s, want, src.err, UNREADABLE, "Base's expected reward sources"));
    }

    // ── Cross-chain lanes ───────────────────────────────────────────────
    const msg = rec.ccipMessenger;
    for (const id of derivedLanes(d)[s]) {
      const t = slugs.find((x) => CHAINS[x].chainId === id);
      if (!msg) { R.push(row(`lane.${t}`, s, 'a messenger in addresses.json', 'none', NOT_MET, 'cross-chain lane')); continue; }
      const sel = ask(s, msg, 'chainSelectorOf(uint256)(uint64)', [String(id)]);
      // The exact selector the configure step stores, never merely a non-zero
      // one: the messenger sends to whatever chain the stored selector names.
      const wantSel = CHAINS[t].ccipSelector;
      R.push(sel.ok
        ? row(`lane.${t}.selector`, s, `${t}'s CCIP selector ${wantSel}`, sel.w[0], sel.w[0] === wantSel ? MET : NOT_MET, 'cross-chain lane')
        : row(`lane.${t}.selector`, s, `${t}'s CCIP selector ${wantSel}`, sel.err, UNREADABLE, 'cross-chain lane'));
      const peer = records[t]?.ccipMessenger?.toLowerCase();
      if (!peer) R.push(row(`lane.${t}.peer`, s, `${t}'s messenger`, `no messenger recorded for ${t}`, NOT_MET, 'cross-chain lane'));
      else cmp(`lane.${t}.peer`, s, 'cross-chain lane', msg, 'remoteMessengerOf(uint256)(address)', [String(id)], [peer]);
      // The business peers on each channel, as ConfigureCcip._wireChannelPeers
      // sets them: a message on a channel is refused unless it comes from
      // that peer, so a right transport peer alone is not a working lane.
      for (const [ch, key] of Object.entries(s === canon ? CHANNEL_PEERS.canonical : CHANNEL_PEERS.mirror)) {
        const want = records[t]?.[key]?.toLowerCase();
        if (!want) R.push(row(`lane.${t}.channel.${ch}`, s, `${t}'s ${key}`, `no ${key} recorded for ${t}`, NOT_MET, 'channel peer'));
        else cmp(`lane.${t}.channel.${ch}`, s, `channel ${ch} peer is ${t}'s ${key}`, msg, 'channelPeerOf(bytes32,uint256)(address)', [ctx.keccak(`vaipakam.ccip.channel.${ch}`), String(id)], [want]);
      }
    }

    // ── Sources ─────────────────────────────────────────────────────────
    {
      const r = ask(s, D, 'getSanctionsOracle()(address)');
      const o = r.ok ? r.w[0] : null;
      if (!r.ok) R.push(row('sources.sanctions', s, 'a sanctions source with code', r.err, UNREADABLE, 'sanctions source'));
      else if (o === ZERO) R.push(row('sources.sanctions', s, 'a sanctions source with code', 'none set', NOT_MET, 'sanctions source'));
      else {
        let c;
        try { c = code(s, o); } catch (e) { c = null; }
        if (c === null) R.push(row('sources.sanctions', s, 'a sanctions source with code', `${o}: code unreadable`, UNREADABLE, 'sanctions source'));
        else if (c === '0x' || c === '') R.push(row('sources.sanctions', s, 'a sanctions source with code', `${o}: no code`, NOT_MET, 'sanctions source'));
        else {
          const q = ask(s, o, 'isSanctioned(address)(bool)', [admin ?? ZERO]);
          R.push(q.ok
            ? row('sources.sanctions', s, 'a sanctions source that answers a screen', `${o} answers ${q.w[0]}`, MET, 'sanctions source')
            : row('sources.sanctions', s, 'a sanctions source that answers a screen', `${o}: ${q.err}`, NOT_MET, 'sanctions source'));
        }
      }
    }
    {
      const r = ask(s, D, 'getSwapAdapters()(address[])');
      swapAdapters = r.ok ? r.w.filter((w) => ADDR_RE.test(w)) : [];
      const n = swapAdapters.length;
      if (!r.ok) R.push(row('sources.swap', s, 'swap routes', r.err, UNREADABLE, 'swap routes'));
      else if (d.chains[s].swapAdapters) R.push(row('sources.swap', s, 'at least one swap route', `${n} routes`, n ? MET : NOT_MET, 'swap routes'));
      else R.push(row('sources.swap', s, 'not stated in the file', `${n} routes`, INFO, 'swap routes'));
    }

    // ── Service capacity escrow: bound where the file asks, and recorded ─
    // Its getter returns a tuple, so the deployment-getter rows below do not
    // reach it; an unbound escrow refuses every capacity deposit.
    if (d.serviceCapacityEscrow === 'all' || (Array.isArray(d.serviceCapacityEscrow) && d.serviceCapacityEscrow.includes(s))) {
      const want = rec.serviceCapacityEscrow?.toLowerCase();
      if (!want) R.push(row('sources.capacityEscrow', s, 'the escrow recorded in addresses.json', 'none recorded', NOT_MET, 'service capacity escrow'));
      else cmp('sources.capacityEscrow', s, 'service capacity escrow bound to the recorded one', D, 'getServiceCapacityEscrow()(address,uint64,uint256)', [], [want]);
    }

    // ── Deployment getters: every contract the Diamond names is there ───
    for (const g of getters) {
      const nd = d.notDeployedHere?.[g];
      const allowed = nd && (nd.chains === 'all' || nd.chains.includes(s));
      const why = allowed ? `zero: ${nd.reason}${nd.kind === 'venue' ? ` (${nd.evidence.list}, read ${nd.evidence.checked})` : ''}` : 'an address';
      const r = ask(s, D, `${g}(address)`);
      // A revert is a failure, never a zero (design ruling 2026-11-22).
      if (!r.ok) { R.push(row(`getter.${g}`, s, why, r.err, UNREADABLE, 'deployment getter')); continue; }
      const a = r.w[0];
      if (d.awaitingRuling?.[g]) R.push(row(`getter.${g}`, s, `awaiting a ruling: ${d.awaitingRuling[g].reason}`, a, AWAITING, 'deployment getter'));
      else if (a !== ZERO) R.push(row(`getter.${g}`, s, why, a, allowed ? NOT_MET : MET, allowed ? 'deployment getter (listed as not deployed here, but answers)' : 'deployment getter'));
      else R.push(row(`getter.${g}`, s, why, a, allowed ? MET : NOT_MET, 'deployment getter'));
    }

    // ── Code: routed selectors equal this commit's facet set ────────────
    if (selectors.missing.length) R.push(row('code.selectors', s, 'artifacts for every facet', `missing: ${selectors.missing.join(' ')}`, UNREADABLE, 'routed selectors'));
    else {
      try {
        const out = call(s, D, 'facets()((address,bytes4[])[])', []);
        const routed = new Set([...String(out).matchAll(/\b0x[0-9a-fA-F]{8}\b/g)].map((m) => m[0].toLowerCase()));
        const missing = [...selectors.set].filter((x) => !routed.has(x));
        const extra = [...routed].filter((x) => !selectors.set.has(x));
        R.push(row('code.selectors', s, `${selectors.set.size} selectors`, missing.length || extra.length ? `missing ${missing.join(' ') || 'none'}; extra ${extra.join(' ') || 'none'}` : `${routed.size} selectors`, missing.length || extra.length ? NOT_MET : MET, 'routed selectors'));
      } catch (e) {
        R.push(row('code.selectors', s, `${selectors.set.size} selectors`, String(e.message ?? e).split('\n')[0], UNREADABLE, 'routed selectors'));
      }
    }

    // ── Records ─────────────────────────────────────────────────────────
    if (d.records?.keeperAddress) {
      const want = d.roles.bots?.[d.records.keeperAddress]?.address?.toLowerCase();
      const got = rec.keeperAddress?.toLowerCase();
      R.push(row('records.keeperAddress', s, `bot ${d.records.keeperAddress} ${want}`, got ?? 'none recorded', got && got === want ? MET : NOT_MET, 'addresses.json'));
    }
    // Accounted for: an address the records name, the implementation behind a
    // recorded proxy, one the Diamond's swap registry names (DeployUniV3Adapter
    // registers its adapter there and writes no record), or a contract the
    // file lists by name with a reason.
    const known = addressesIn(rec);
    for (const a of swapAdapters) known.add(a);
    if (!created) R.push(row('records.created', s, 'every created address recorded or listed', unscoped, UNREADABLE, 'broadcast journals'));
    else {
      const made = created.get(CHAINS[s].chainId) ?? [];
      const listed = (c) => known.has(c.address.toLowerCase()) || Object.prototype.hasOwnProperty.call(d.notRecorded ?? {}, c.name);
      let unrecorded = made.filter((c) => !listed(c));
      // An implementation behind a recorded ERC-1967 proxy is accounted for by
      // that proxy: the chain itself says which code the proxy runs, so no
      // second record is needed (read only when something is left over).
      if (unrecorded.length && ctx.storageAt) {
        for (const a of [...addressesIn(rec)]) {
          try {
            const w = String(ctx.storageAt(s, a, ERC1967_IMPLEMENTATION_SLOT)).trim().toLowerCase();
            if (/^0x[0-9a-f]{64}$/.test(w) && !/^0x0{64}$/.test(w)) known.add(`0x${w.slice(26)}`);
          } catch { /* not readable: the address stays unaccounted for */ }
        }
        unrecorded = made.filter((c) => !listed(c));
      }
      R.push(row('records.created', s, 'every created address recorded or listed', unrecorded.length ? unrecorded.map((c) => `${c.name || '?'} ${c.address}`).join('; ') : `${made.length} created, all accounted for`, unrecorded.length ? NOT_MET : MET, 'broadcast journals'));
    }
    for (const f of ['storage-layout.json', 'storage-layout.anchor.json']) {
      R.push(row(`records.${f}`, s, 'written', files.exists(s, f) ? 'present' : 'missing', files.exists(s, f) ? MET : NOT_MET, 'storage-layout record'));
    }
    const p = prior[s];
    if (p?.diamond && p.diamond.toLowerCase() !== D.toLowerCase()) {
      const named = (manifest ?? []).some((e) => e.slug === s && String(e.diamond).toLowerCase() === p.diamond.toLowerCase());
      R.push(row('records.archive', s, `manifest names ${p.diamond}`, named ? 'named' : 'not named', named ? MET : NOT_MET, 'archive manifest'));
    } else if (p?.diamond) {
      R.push(row('records.archive', s, 'a new Diamond', `the recorded Diamond ${D} is unchanged`, NOT_MET, 'archive manifest'));
    } else {
      R.push(row('records.archive', s, 'a prior deployment', 'none recorded', INFO, 'archive manifest'));
    }
    if (p) {
      const dropped = Object.keys(p).filter((k) => !(k in rec));
      R.push(row('records.carried', s, 'every prior key kept', dropped.length ? `dropped: ${dropped.join(' ')}` : `${Object.keys(p).length} keys kept`, dropped.length ? NOT_MET : MET, 'addresses.json'));
    }
    R.push(row('records.produced', s, 'the addresses this run produced', `diamond ${D}`, INFO, 'addresses.json'));
  }

  // ── Across chains ─────────────────────────────────────────────────────
  if (anchors.size) {
    const vals = new Set(anchors.values());
    const want = anchor !== undefined && anchor !== null ? String(anchor) : [...anchors.values()][0];
    for (const [s, v] of anchors) R.push(row('rewards.anchor', s, want, v, vals.size === 1 && v === want ? MET : NOT_MET, 'rewards anchor, equal on every chain'));
  }
  const planned = slugs.map((s) => CHAINS[s].chainId).sort((a, b) => a - b).join(' ');
  if (!created) R.push(row('records.chains', '*', planned, unscoped, UNREADABLE, 'chains that received transactions'));
  else {
    const sent = [...created.keys()].sort((a, b) => a - b).join(' ');
    R.push(row('records.chains', '*', planned, sent || 'no journals', sent === planned ? MET : NOT_MET, 'chains that received transactions'));
  }
  return R;
}

export const failed = (rows) => rows.filter((r) => r.result === NOT_MET || r.result === UNREADABLE);

function arg(rest, name) {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2), { env = process.env, log = console.log, err = console.error } = {}) {
  const [file, ...rest] = argv;
  if (!file || file.startsWith('--')) {
    err('usage: readback.mjs <desired.json> [--records <dir>] [--broadcast <dir>] [--prior-root <dir>] [--env-file <path>] [--rpc <slug>=<url>]... [--since <unix>] [--anchor <unix>] [--json <path>]');
    return 2;
  }
  let d;
  try { ({ d } = readDesired(file)); } catch (e) { err(`  ✗ cannot read ${file}: ${e.message}`); return 1; }
  const terms = termsVersions();
  const getters = addressGetters();
  const problems = validate(d, { flags: keeperFlags(), terms, getters });
  for (const p of problems) err(`  ✗ ${p}`);
  if (problems.length) return 1;

  const recordsRoot = resolve(CONTRACTS_DIR, arg(rest, '--records') ?? env.VAIPAKAM_REHEARSAL_ROOT ?? 'deployments');
  const bDefault = existsSync(join(recordsRoot, '.forge/broadcast')) ? join(recordsRoot, '.forge/broadcast') : join(CONTRACTS_DIR, 'broadcast');
  const broadcast = resolve(CONTRACTS_DIR, arg(rest, '--broadcast') ?? bDefault);
  const priorRoot = arg(rest, '--prior-root');
  // The shared contracts/broadcast holds every earlier run's journals too, so
  // its census needs the run's start; a records root's own .forge/broadcast
  // (the rehearsal's) holds only this run's.
  const sinceArg = arg(rest, '--since');
  const since = sinceArg === undefined ? undefined : Number(sinceArg);
  if (sinceArg !== undefined && !Number.isInteger(since)) { err(`  ✗ --since must be a unix time in seconds`); return 1; }
  const journalsScoped = since !== undefined || resolve(broadcast) !== resolve(CONTRACTS_DIR, 'broadcast');
  const rpcs = {};
  rest.forEach((a, i) => { if (a === '--rpc') { const [k, ...v] = String(rest[i + 1]).split('='); rpcs[k] = v.join('='); } });
  const slugs = Object.keys(d.chains);

  let values = env;
  const ef = arg(rest, '--env-file');
  const names = [d.roles.admin, d.roles.deployer, d.roles.treasury, ...slugs.map((s) => `${CHAINS[s].prefix}_RPC_URL`)];
  if (ef) {
    const r = loaderValues(ef, names, env);
    if (r.error) { err(`  ✗ ${ef}: ${r.error}`); return 1; }
    values = { ...env, ...r.values };
  }
  const rpcOf = (s) => rpcs[s] ?? values[`${CHAINS[s].prefix}_RPC_URL`];
  const cast = env.RH_CAST || 'cast';
  const run = (args) => {
    const r = spawnSync(cast, args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error((r.stderr || r.error?.message || `cast exited ${r.status}`).trim());
    return r.stdout.trim();
  };
  const call = (s, to, sig, args) => {
    if (!rpcOf(s)) throw new Error(`no RPC for ${s}: pass --rpc ${s}=<url> or set ${CHAINS[s].prefix}_RPC_URL`);
    return run(['call', to, sig, ...args, '--rpc-url', rpcOf(s)]);
  };
  const code = (s, a) => run(['code', a, '--rpc-url', rpcOf(s)]);
  const storageAt = (s, a, slot) => run(['storage', a, slot, '--rpc-url', rpcOf(s)]);
  const keccakCache = new Map();
  const keccak = (t) => {
    if (!keccakCache.has(t)) keccakCache.set(t, run(['keccak', t]).toLowerCase());
    return keccakCache.get(t);
  };

  const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined);
  const records = Object.fromEntries(slugs.map((s) => [s, readJson(join(recordsRoot, s, 'addresses.json'))]));
  const prior = Object.fromEntries(slugs.map((s) => {
    if (priorRoot) return [s, readJson(resolve(CONTRACTS_DIR, priorRoot, s, 'addresses.json'))];
    const r = spawnSync('git', ['show', `HEAD:contracts/deployments/${s}/addresses.json`], { cwd: REPO_ROOT, encoding: 'utf8' });
    return [s, r.status === 0 ? JSON.parse(r.stdout) : undefined];
  }));
  const m = readJson(join(recordsRoot, 'archive-manifest.json'));
  const manifest = Array.isArray(m) ? m : m?.entries ?? [];
  const a = arg(rest, '--anchor');

  const rows = readback(d, {
    call, code, storageAt, keccak, records, prior, env: values, terms,
    roles: grantableRoles(),
    getters: [...getters],
    selectors: expectedSelectors(),
    created: journalsScoped ? createdAddresses(broadcast, since) : null,
    manifest,
    files: { exists: (s, f) => existsSync(join(recordsRoot, s, f)) },
    anchor: a === undefined ? d.rewards.anchor ?? undefined : Number(a),
  });

  const pad = (t, n) => String(t).padEnd(n);
  for (const r of rows) log(`${pad(r.result, 10)} ${pad(r.chain, 13)} ${pad(r.id, 34)} expected ${r.expected} | found ${r.found}`);
  const bad = failed(rows);
  const waiting = rows.filter((r) => r.result === AWAITING).length;
  log(`\n  ${rows.length} rows: ${rows.length - bad.length - waiting} met or info, ${waiting} awaiting a ruling, ${bad.length} not met or unreadable`);
  const jp = arg(rest, '--json');
  if (jp) writeFileSync(jp, `${JSON.stringify({ desired: file, records: recordsRoot, rows, failed: bad.length }, null, 2)}\n`);
  return bad.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
