// Tests for contracts/script/readback.mjs (#3893, deploy rehearsal design
// sections 6, 17 and 20 item 9): the readback passes on a chain set that
// matches the desired file and fails on each kind of row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAINS, CONTRACTS_DIR, derivedRewardSources, settingExpect, termsVersions, validate, keeperFlags, addressGetters } from '../../../contracts/script/deploy-plan.mjs';
import { AWAITING, MET, NOT_MET, UNREADABLE, createdAddresses, failed, grantableRoles, readback, words } from '../../../contracts/script/readback.mjs';

// The committed file, with the rate model's entry taken out so each test
// states the getter rule it exercises on its own.
const desired = () => {
  const d = JSON.parse(readFileSync(join(CONTRACTS_DIR, 'deployments/testnets.desired.json'), 'utf8'));
  delete d.notDeployedHere?.['getRateModel()'];
  delete d.awaitingRuling;
  return d;
};
const terms = termsVersions();
const A = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const ADMIN = A(0xa1);
const DEPLOYER = A(0xde);
const TREASURY = A(0x7e);
const ANCHOR = 1794873600;
const SEL = ['0x11111111', '0x22222222'];
const GETTERS = ['getPriceGuard()', 'getRateModel()'];

/** A deployment that matches `d` on every chain, as a mutable world the fake cast reads. */
function world(d) {
  const slugs = Object.keys(d.chains);
  const w = { roles: {}, owner: {}, paused: {}, settings: {}, getters: {}, selectors: {}, peers: {}, records: {}, prior: {}, files: {}, created: new Map(), manifest: [] };
  slugs.forEach((s, i) => {
    const D = A(0x1000 + i);
    w.records[s] = { diamond: D, ccipMessenger: A(0x2000 + i), priceGuard: A(0x3000 + i), keeperAddress: A(0x4000) };
    w.prior[s] = { diamond: A(0x9000 + i), ccipMessenger: A(0x9100 + i), priceGuard: A(0x9200 + i), keeperAddress: A(0x4000) };
    w.manifest.push({ slug: s, diamond: w.prior[s].diamond });
    w.files[s] = new Set(['storage-layout.json', 'storage-layout.anchor.json']);
    w.created.set(CHAINS[s].chainId, [{ address: D, name: 'VaipakamDiamond' }, { address: A(0x2000 + i), name: 'ERC1967Proxy' }]);
    w.paused[s] = 'false';
    w.owner[s] = ADMIN;
    w.roles[s] = new Set([...grantableRoles().map((r) => `${r}|${ADMIN}`), ...Object.values(d.roles.bots).flatMap((b) => b.roles.map((r) => `${r}|${b.address.toLowerCase()}`))]);
    w.settings[s] = {};
    w.getters[s] = { 'getPriceGuard()': A(0x3000 + i), 'getRateModel()': A(0x5000 + i) };
    w.selectors[s] = [...SEL];
  });
  return w;
}

function fakeCtx(d, w, over = {}) {
  const slugs = Object.keys(d.chains);
  const byDiamond = (s, to) => to.toLowerCase() === w.records[s].diamond.toLowerCase();
  const call = (s, to, sig, args) => {
    const msgIdx = slugs.indexOf(s);
    if (to.toLowerCase() === w.records[s].ccipMessenger.toLowerCase()) {
      const t = slugs.find((x) => CHAINS[x].chainId === Number(args[0]));
      if (sig.startsWith('chainSelectorOf')) return w.selectorsOf?.[`${s}>${t}`] ?? CHAINS[t].ccipSelector;
      if (sig.startsWith('remoteMessengerOf')) return w.peers[`${s}>${t}`] ?? w.records[t].ccipMessenger;
    }
    if (to === A(0x6000 + msgIdx) && sig.startsWith('isSanctioned')) return 'false';
    if (!byDiamond(s, to)) throw new Error(`call to unknown ${to}`);
    // Several rows can read one getter (a switch and a figure of one tuple):
    // the chain answers the whole tuple, the longest expectation of them.
    const st = d.settings
      .filter((x) => x.getter === sig && (x.getterArgs ?? []).join(' ') === args.join(' '))
      .sort((a, b) => settingExpect(b).length - settingExpect(a).length)[0];
    if (st) return w.settings[s][sig] ?? settingExpect(st).join(' ');
    switch (sig) {
      case 'paused()(bool)': return w.paused[s];
      case 'getCurrentTos()(uint32,bytes32)': return `${d.terms.version}\n${terms.get(d.terms.version)}`;
      case 'getMinTermsAgeSec()(uint256)': return '5';
      case 'hasRole(bytes32,address)(bool)': {
        const name = grantableRoles().concat(['KEEPER_ROLE', 'WATCHER_ROLE', 'NOTIF_BILLER_ROLE']).find((r) => fakeKeccak(r) === args[0]) ?? 'DEFAULT_ADMIN_ROLE';
        return String(w.roles[s].has(`${name}|${args[1].toLowerCase()}`));
      }
      case 'owner()(address)': return w.owner[s];
      case 'getTreasury()(address)': return TREASURY;
      case 'getRewardRole()(uint8)': return d.chains[s].role === 'canonical' ? '0' : '1';
      case 'rewardCustodyActivated()(bool)': return 'true';
      case 'getInteractionLaunchTimestamp()(uint256)': return String(w.anchor?.[s] ?? ANCHOR);
      case 'armedFreshLedger()(uint256,uint256)': return `${BigInt(d.rewards.baseRewardPoolVpfi) * 10n ** 18n} [1e23]\n0`;
      case 'getGovernorCommitState()(uint256,uint256,uint256,uint256)': return '20774\n0\n0\n0';
      case 'getExpectedSourceChainIds()(uint32[])': return `[${derivedRewardSources(d).join(', ')}]`;
      case 'getSanctionsOracle()(address)': return A(0x6000 + msgIdx);
      case 'getSwapAdapters()(address[])': return `[${A(0x7000)}]`;
      case 'facets()((address,bytes4[])[])': return `[(${A(0x8000)}, [${w.selectors[s].join(', ')}])]`;
      default:
        if (sig.endsWith('()(address)') && w.getters[s][sig.slice(0, -9)] !== undefined) return w.getters[s][sig.slice(0, -9)];
        throw new Error(`unknown read ${sig}`);
    }
  };
  return {
    call,
    code: () => '0x6080',
    keccak: fakeKeccak,
    records: w.records,
    prior: w.prior,
    env: { ADMIN_ADDRESS: ADMIN, DEPLOYER_ADDRESS: DEPLOYER, TREASURY_ADDRESS: TREASURY },
    terms,
    roles: grantableRoles(),
    getters: GETTERS,
    selectors: { set: new Set(SEL), missing: [] },
    created: w.created,
    manifest: w.manifest,
    files: { exists: (s, f) => w.files[s].has(f) },
    anchor: ANCHOR,
    ...over,
  };
}
const fakeKeccak = (t) => `0x${Buffer.from(t).toString('hex').padEnd(64, '0').slice(0, 64)}`;

const bad = (rows) => failed(rows).map((r) => `${r.chain} ${r.id}`);

test('words strips cast annotations, brackets and commas', () => {
  assert.deepEqual(words('100 [1e2]\n(0xAb, 2)'), ['100', '0xab', '2']);
});

test('grantableRoles reads the eleven roles from LibAccessControl', () => {
  const r = grantableRoles();
  assert.equal(r.length, 11);
  assert.equal(r[0], 'DEFAULT_ADMIN_ROLE');
  assert.ok(r.includes('KEEPER_ROLE'));
});

test('a deployment that matches the file passes', () => {
  const d = desired();
  const rows = readback(d, fakeCtx(d, world(d)));
  assert.deepEqual(bad(rows), []);
  assert.ok(rows.some((r) => r.id === 'records.produced'));
});

test('a switch off fails its setting row', () => {
  const d = desired();
  const w = world(d);
  w.settings['arb-sepolia']['getPartialFillEnabled()(bool)'] = 'false';
  assert.deepEqual(bad(readback(d, fakeCtx(d, w))), ['arb-sepolia setting.getPartialFillEnabled']);
});

test('the Diamond still paused fails the launch row', () => {
  const d = desired();
  const w = world(d);
  w.paused['base-sepolia'] = 'true';
  assert.deepEqual(bad(readback(d, fakeCtx(d, w))), ['base-sepolia launch.paused']);
});

test('a role missing, a deployer left holding one, and a wrong owner each fail', () => {
  const d = desired();
  const w = world(d);
  w.roles['bnb-testnet'].delete(`KEEPER_ROLE|${d.roles.bots.keeper.address.toLowerCase()}`);
  w.roles['base-sepolia'].add(`PAUSER_ROLE|${DEPLOYER}`);
  w.owner['arb-sepolia'] = DEPLOYER;
  assert.deepEqual(bad(readback(d, fakeCtx(d, w))).sort(), [
    'arb-sepolia roles.owner',
    'base-sepolia roles.deployer.PAUSER_ROLE',
    'bnb-testnet roles.keeper.KEEPER_ROLE',
  ]);
});

test('an unset admin variable is unreadable, never met', () => {
  const d = desired();
  const rows = readback(d, fakeCtx(d, world(d), { env: { DEPLOYER_ADDRESS: DEPLOYER, TREASURY_ADDRESS: TREASURY } }));
  const r = rows.filter((x) => x.id === 'roles.admin');
  assert.equal(r.length, 3);
  assert.ok(r.every((x) => x.result === UNREADABLE));
});

test('anchors that differ between chains fail on every chain', () => {
  const d = desired();
  const w = world(d);
  w.anchor = { 'bnb-testnet': ANCHOR + 86400 };
  assert.deepEqual(bad(readback(d, fakeCtx(d, w))), ['base-sepolia rewards.anchor', 'arb-sepolia rewards.anchor', 'bnb-testnet rewards.anchor']);
});

test('a lane pointing at the wrong peer fails', () => {
  const d = desired();
  const w = world(d);
  w.peers['base-sepolia>arb-sepolia'] = A(0xbad);
  assert.deepEqual(bad(readback(d, fakeCtx(d, w))), ['base-sepolia lane.arb-sepolia.peer']);
});

test('a zero deployment getter fails unless the file lists it, with a reason, on that chain', () => {
  const d = desired();
  const w = world(d);
  delete d.awaitingRuling;
  for (const s of Object.keys(d.chains)) w.getters[s]['getRateModel()'] = A(0);
  assert.deepEqual(bad(readback(d, fakeCtx(d, w))).length, 3);
  d.notDeployedHere = { 'getRateModel()': { kind: 'byDesign', chains: ['base-sepolia', 'arb-sepolia'], reason: 'no rate model on testnets yet, decided by design' } };
  delete d.awaitingRuling;
  assert.deepEqual(validate(d, { flags: keeperFlags(), terms, getters: addressGetters() }), []);
  assert.deepEqual(bad(readback(d, fakeCtx(d, w))), ['bnb-testnet getter.getRateModel()']);
  // Listed as not deployed, but answering an address: the list is stale.
  w.getters['base-sepolia']['getRateModel()'] = A(0x55);
  assert.deepEqual(bad(readback(d, fakeCtx(d, w))), ['base-sepolia getter.getRateModel()', 'bnb-testnet getter.getRateModel()']);
});

test('validation refuses a not-deployed entry with no reason or naming no getter', () => {
  const d = desired();
  d.notDeployedHere = { 'getRateModel()': { kind: 'byDesign', chains: 'all', reason: 'short' }, 'notAGetter()': { kind: 'byDesign', chains: 'all', reason: 'a reason long enough to pass the length check' } };
  d.notRecorded = { MockThing: '' };
  const p = validate(d, { flags: keeperFlags(), terms, getters: addressGetters() });
  assert.ok(p.some((x) => x.startsWith('notDeployedHere.getRateModel(): needs a reason')));
  assert.ok(p.some((x) => x.startsWith('notDeployedHere.notAGetter(): not a Diamond getter')));
  assert.ok(p.some((x) => x.startsWith('notRecorded.MockThing: needs a reason')));
});

test('a sanctions source with no code, or that cannot answer a screen, fails', () => {
  const d = desired();
  const w = world(d);
  const base = fakeCtx(d, w);
  let rows = readback(d, { ...base, code: (s) => (s === 'arb-sepolia' ? '0x' : '0x6080') });
  assert.deepEqual(bad(rows), ['arb-sepolia sources.sanctions']);
  rows = readback(d, { ...base, call: (s, to, sig, args) => { if (sig.startsWith('isSanctioned') && s === 'bnb-testnet') throw new Error('reverted'); return base.call(s, to, sig, args); } });
  assert.deepEqual(bad(rows), ['bnb-testnet sources.sanctions']);
});

test('a routed selector missing or extra fails the code row', () => {
  const d = desired();
  const w = world(d);
  w.selectors['base-sepolia'] = ['0x11111111', '0x33333333'];
  const r = readback(d, fakeCtx(d, w)).find((x) => x.chain === 'base-sepolia' && x.id === 'code.selectors');
  assert.equal(r.result, NOT_MET);
  assert.match(r.found, /missing 0x22222222; extra 0x33333333/);
});

test('a record dropped, an address not recorded, and a missing layout record each fail', () => {
  const d = desired();
  const w = world(d);
  delete w.records['arb-sepolia'].priceGuard;
  w.created.get(CHAINS['base-sepolia'].chainId).push({ address: A(0xfeed), name: 'MockFeed' });
  w.files['bnb-testnet'].delete('storage-layout.anchor.json');
  assert.deepEqual(bad(readback(d, fakeCtx(d, w))).sort(), [
    'arb-sepolia records.carried',
    'base-sepolia records.created',
    'bnb-testnet records.storage-layout.anchor.json',
  ]);
  // Listed under notRecorded with its reason, the mock is accepted.
  d.notRecorded = { MockFeed: 'a rehearsal stand-in feed, never part of the deployment' };
  assert.ok(!bad(readback(d, fakeCtx(d, w))).includes('base-sepolia records.created'));
});

test('the archive manifest must name the retired Diamond, and the Diamond must be new', () => {
  const d = desired();
  const w = world(d);
  w.manifest = w.manifest.filter((e) => e.slug !== 'arb-sepolia');
  w.prior['bnb-testnet'].diamond = w.records['bnb-testnet'].diamond;
  assert.deepEqual(bad(readback(d, fakeCtx(d, w))).sort(), ['arb-sepolia records.archive', 'bnb-testnet records.archive']);
});

test('a chain outside the plan that received transactions fails', () => {
  const d = desired();
  const w = world(d);
  w.created.set(CHAINS.sepolia.chainId, [{ address: A(0x77), name: 'VaipakamDiamond' }]);
  assert.deepEqual(bad(readback(d, fakeCtx(d, w))), ['* records.chains']);
});

test('createdAddresses reads CREATE transactions and internal creations from run-latest journals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rb-'));
  mkdirSync(join(dir, 'DeployDiamond.s.sol', '84532'), { recursive: true });
  writeFileSync(join(dir, 'DeployDiamond.s.sol', '84532', 'run-latest.json'), JSON.stringify({
    transactions: [
      { transactionType: 'CREATE', contractName: 'VaipakamDiamond', contractAddress: A(1), additionalContracts: [] },
      { transactionType: 'CALL', contractName: 'Factory', contractAddress: A(2), additionalContracts: [{ contractName: 'Child', address: A(3) }] },
    ],
  }));
  const m = createdAddresses(dir);
  assert.deepEqual(m.get(84532).map((c) => c.name), ['VaipakamDiamond', 'Child']);
});

test("a venue entry needs the venue's published list and the date it was read; a default is refused", () => {
  const d = desired();
  const v = { getters: addressGetters(), flags: keeperFlags(), terms };
  d.notDeployedHere = { 'getPancakeswapV3Factory()': { kind: 'venue', chains: ['bnb-testnet'], reason: 'PancakeSwap v3 is not deployed on BNB testnet per its list' } };
  let p = validate(d, v);
  assert.ok(p.some((x) => x.includes('evidence.list')));
  assert.ok(p.some((x) => x.includes('evidence.checked')));
  d.notDeployedHere['getPancakeswapV3Factory()'].evidence = { list: 'https://developer.pancakeswap.finance/contracts/v3/addresses', checked: '2026-11-22' };
  assert.deepEqual(validate(d, v), []);
  d.notDeployedHere['getPancakeswapV3Factory()'].kind = 'default';
  assert.ok(validate(d, v).some((x) => x.includes('kind must be venue or byDesign')));
});

test('the venue evidence is shown on the readback row', () => {
  const d = desired();
  const w = world(d);
  delete d.awaitingRuling;
  d.notDeployedHere = { 'getRateModel()': { kind: 'venue', chains: 'all', reason: 'stands in for an outside venue absent on testnets', evidence: { list: 'https://example.org/deployments', checked: '2026-11-22' } } };
  for (const s of Object.keys(d.chains)) w.getters[s]['getRateModel()'] = A(0);
  const r = readback(d, fakeCtx(d, w)).find((x) => x.id === 'getter.getRateModel()');
  assert.equal(r.result, MET);
  assert.match(r.expected, /https:\/\/example\.org\/deployments, read 2026-11-22/);
});

test('on mainnet a zero needs the owner\'s recorded acceptance, and nothing may await a ruling', () => {
  const d = { network: 'mainnet', chains: {}, notDeployedHere: { 'getRateModel()': { kind: 'byDesign', chains: 'all', reason: 'a reason long enough to pass the length check' } }, awaitingRuling: { 'getPriceGuard()': { reason: 'a reason long enough to pass the length check' } } };
  const p = validate(d, { getters: addressGetters(), flags: keeperFlags(), terms });
  assert.ok(p.some((x) => x.includes("owner's recorded acceptance")));
  assert.ok(p.some((x) => x.includes('may hold no getter awaiting a ruling')));
});

test('a getter awaiting a ruling is shown, neither met nor failed, and a revert still fails', () => {
  const d = desired();
  d.awaitingRuling = { 'getRateModel()': { reason: 'waiting for the design thread to rule on this getter' } };
  const w = world(d);
  for (const s of Object.keys(d.chains)) w.getters[s]['getRateModel()'] = A(0);
  const rows = readback(d, fakeCtx(d, w));
  assert.deepEqual(bad(rows), []);
  assert.ok(rows.filter((x) => x.id === 'getter.getRateModel()').every((x) => x.result === AWAITING));
  const base = fakeCtx(d, w);
  const rows2 = readback(d, { ...base, call: (s, to, sig, args) => { if (sig === 'getRateModel()(address)') throw new Error('execution reverted: FunctionDoesNotExist'); return base.call(s, to, sig, args); } });
  assert.equal(bad(rows2).filter((x) => x.endsWith('getter.getRateModel()')).length, 3);
});

test('a lane whose selector names another chain fails, even when non-zero', () => {
  const d = desired();
  const w = world(d);
  w.selectorsOf = { 'arb-sepolia>base-sepolia': CHAINS['bnb-testnet'].ccipSelector };
  assert.deepEqual(bad(readback(d, fakeCtx(d, w))), ['arb-sepolia lane.base-sepolia.selector']);
});

test('the CCIP selectors are the ones Deployments.ccipSelectorForChainId maps', () => {
  const src = readFileSync(join(CONTRACTS_DIR, 'script/lib/Deployments.sol'), 'utf8');
  const body = src.match(/function ccipSelectorForChainId\(uint256 cid\)[^{]*\{([\s\S]*?)\n    \}/)[1];
  const map = new Map([...body.matchAll(/cid == (\d+)\)\s*return (\d+);/g)].map((m) => [Number(m[1]), m[2]]));
  for (const [slug, c] of Object.entries(CHAINS)) assert.equal(c.ccipSelector, map.get(c.chainId), slug);
});

test('an unidentified deployer is unreadable on every chain, never a silent pass', () => {
  const d = desired();
  const w = world(d);
  w.roles['base-sepolia'].add(`ADMIN_ROLE|${DEPLOYER}`);
  const rows = readback(d, fakeCtx(d, w, { env: { ADMIN_ADDRESS: ADMIN, TREASURY_ADDRESS: TREASURY } }));
  const r = rows.filter((x) => x.id === 'roles.deployer');
  assert.equal(r.length, 3);
  assert.ok(r.every((x) => x.result === UNREADABLE));
});

test("the committed file accounts for the mirrors' unset remittance keeper and the one-shot interface initializer", () => {
  const d = desired();
  const w = world(d);
  for (const s of Object.keys(d.chains)) {
    // The getter is also a Base setting's read-back, so the fake answers it from the settings.
    if (s !== 'base-sepolia') w.settings[s]['getRewardRemittanceKeeper()(address)'] = `0x${'0'.repeat(40)}`;
    w.created.get(CHAINS[s].chainId).push({ address: A(0xb000), name: 'DiamondInterfacesInit' });
  }
  assert.deepEqual(bad(readback(d, fakeCtx(d, w, { getters: [...GETTERS, 'getRewardRemittanceKeeper()'] }))), []);
});
