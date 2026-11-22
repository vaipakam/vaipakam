// Tests for contracts/script/deploy-plan.mjs (#3111, deploy rehearsal design sections 3 and 16).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CARRIED,
  CONTRACTS_DIR,
  buildPlan,
  derivedLanes,
  derivedRewardSources,
  envDisagreements,
  envValues,
  keeperFlags,
  termsVersions,
  todayAnchor,
  validate,
} from '../../../contracts/script/deploy-plan.mjs';

const DESIRED = join(CONTRACTS_DIR, 'deployments/testnets.desired.json');
const real = () => JSON.parse(readFileSync(DESIRED, 'utf8'));
const ctx = { flags: keeperFlags(), terms: termsVersions() };
const goodEnv = {
  CCIP_LANE_CHAIN_IDS_BASE_SEPOLIA: '97,421614',
  CCIP_LANE_CHAIN_IDS_ARB_SEPOLIA: '84532',
  CCIP_LANE_CHAIN_IDS_BNB_TESTNET: '84532',
  REWARD_EXPECTED_SOURCE_CHAIN_IDS: '84532,421614,97',
};
const plan = (d = real()) => buildPlan(d, { anchor: 1795305600, terms: ctx.terms, desiredDigest: 'f'.repeat(64), desiredPath: 'x.json' });

test('the committed testnet desired state is valid', () => {
  assert.deepEqual(validate(real(), ctx), []);
});

test('lanes and expected reward sources are derived from the chain set', () => {
  assert.deepEqual(derivedLanes(real()), { 'base-sepolia': [97, 421614], 'arb-sepolia': [84532], 'bnb-testnet': [84532] });
  assert.deepEqual(derivedRewardSources(real()), [97, 84532, 421614]);
});

test('an env that disagrees with the derived topology is named', () => {
  assert.deepEqual(envDisagreements(real(), goodEnv), []);
  const p = envDisagreements(real(), { ...goodEnv, CCIP_LANE_CHAIN_IDS_ARB_SEPOLIA: '84532,97', REWARD_EXPECTED_SOURCE_CHAIN_IDS: undefined, CCIP_LANE_CHAIN_IDS: '1' });
  assert.equal(p.length, 3);
  assert.match(p.join('\n'), /CCIP_LANE_CHAIN_IDS_ARB_SEPOLIA=84532,97, but the chain set gives 84532/);
  assert.match(p.join('\n'), /REWARD_EXPECTED_SOURCE_CHAIN_IDS is not set; the chain set gives 97,84532,421614/);
  assert.match(p.join('\n'), /one-run override/);
});

test('env values: later lines win, quotes and export are stripped, other names ignored', () => {
  const v = envValues('export A="1,2"\nB=3\n# A=9\nA=\'4\'\nC_PRIVATE_KEY=0xsecret\n', ['A', 'B']);
  assert.deepEqual(v, { A: '4', B: '3' });
});

test('validation refuses the mistakes the file invites', () => {
  const cases = [
    [(d) => { d.chains['arb-sepolia'].role = 'canonical'; }, /exactly one canonical/],
    [(d) => { d.chains.mars = { role: 'mirror' }; d.keeper.armed.mars = []; }, /mars: not a chain/],
    [(d) => { d.keeper.armed['bnb-testnet'].push('NOT_A_FLAG_ENABLED'); }, /NOT_A_FLAG_ENABLED is not a flag the keeper reads/],
    [(d) => { delete d.keeper.armed['arb-sepolia']; }, /no list for arb-sepolia/],
    [(d) => { d.terms.version = 99; }, /terms.version 99 is not published/],
    [(d) => { d.settings[0].value = 'true; rm'; }, /value must be one plain word/],
    [(d) => { d.settings[0].getter = 'getX()'; }, /getter must be a signature with its return/],
    [(d) => { d.settings[0].chains = ['sepolia']; }, /chains must be "all" or a list of the file's chains/],
    [(d) => { d.rewards.anchor = 1795305601; }, /00:00 UTC/],
    [(d) => { d.roles.bots.keeper.roles = ['keeper']; }, /\*_ROLE names/],
    [(d) => { d.records.keeperAddress = 'nobody'; }, /not under roles.bots/],
    [(d) => { d.sanctionsClearance.timelocks = ['bnb-testnet']; }, /sanctionsClearance.timelocks/],
    [(d) => { delete d.settings[0].source; }, /source must say where the value comes from/],
    [(d) => { d.network = 'mainnet'; d.settings[0].source = CARRIED; }, /a carried row is refused/],
    [(d) => { d.settings[4].expect = []; }, /needs value, or args and expect/],
    [(d) => { d.settings[4].args[1] = '1,2'; }, /each value must be one plain word/],
  ];
  for (const [mutate, re] of cases) {
    const d = real();
    mutate(d);
    assert.match(validate(d, ctx).join('\n'), re);
  }
});

test('the plan runs every phase in order, canonical chain first', () => {
  const lines = plan().split('\n');
  assert.equal(lines.find((l) => l.startsWith('chains')), 'chains base-sepolia arb-sepolia bnb-testnet');
  const steps = lines.filter((l) => l.startsWith('step '));
  const phases = steps.map((l) => l.split(' ')[2]);
  const first = (p) => phases.indexOf(p);
  for (const [a, b] of [['preflight', 'contracts'], ['contracts', 'ccip-wire'], ['ccip-wire', 'swap-adapters'], ['swap-adapters', 'testnet-mocks'], ['testnet-mocks', 'configure'], ['configure', 'launch'], ['launch', 'verify'], ['verify', 'abi-sync']]) {
    assert.ok(first(a) < first(b), `${a} before ${b}`);
  }
  assert.deepEqual(steps.filter((l) => l.includes(' swap-adapters')), ['step bnb-testnet swap-adapters']);
  assert.ok(steps.every((l) => !/ cf-/.test(l)), 'no Cloudflare phase');
  assert.equal(steps.filter((l) => l.includes(' contracts ')).every((l) => l.endsWith('--confirm-i-have-multisig-ready --fresh')), true);
});

test('the reward steps run in the guide order: fund, anchor canonical first, arm, clock, launch, relay, mirror launch', () => {
  const lines = plan().split('\n');
  const at = (re) => lines.findIndex((l) => re.test(l));
  const fund = at(/fundRewardPool/);
  const anchors = lines.map((l, i) => (/SetInteractionLaunch/.test(l) ? i : -1)).filter((i) => i >= 0);
  assert.equal(anchors.length, 3);
  assert.match(lines[anchors[0]], /^cmd base-sepolia /);
  assert.ok(anchors.every((i) => /INTERACTION_LAUNCH_TIMESTAMP=1795305600 /.test(lines[i])), 'one anchor everywhere');
  const arm = at(/setGovernorCommitArmedFromDay/);
  const clock = at(/^clock /);
  const launchBase = at(/^step base-sepolia launch/);
  const relay = at(/^relay base-sepolia arb-sepolia/);
  const launchArb = at(/^step arb-sepolia launch/);
  assert.ok(at(/^step bnb-testnet configure/) < fund && fund < anchors[0] && anchors[2] < arm && arm < clock && clock < launchBase && launchBase < relay && relay < launchArb);
  assert.match(lines[fund - 2], /TREASURY "\$V" 'transfer\(address,uint256\)' "\$\(vk_role_address ADMIN\)" 100000000000000000000000 /);
});

test('the canonical chain closes, finalizes and broadcasts the day before the armed day, after the reward grace', () => {
  const lines = plan().split('\n');
  const at = (re) => lines.findIndex((l) => re.test(l));
  const close = at(/'closeDay\(uint256\)'/);
  const wait = at(/^clock \+43201$/);
  const fin = at(/'finalizeDay\(uint256\)'/);
  const bc = at(/'broadcastGlobal\(uint256\)' "\$P" --value "\$F"/);
  assert.ok(at(/^step base-sepolia launch/) < close && close < wait && wait < fin && fin < bc && bc < at(/^relay /));
  assert.ok([close, fin, bc].every((i) => lines[i].startsWith('cmd base-sepolia ')));
});

test('the sanctions clearance is rewired attestor first, after every chain is configured', () => {
  const lines = plan().split('\n');
  const runs = lines.map((l, i) => [l, i]).filter(([l]) => l.includes('ConfigureSanctionsClearance'));
  assert.deepEqual(runs.map(([l]) => l.split(' ')[1]), ['bnb-testnet', 'base-sepolia', 'arb-sepolia']);
  assert.ok(runs.every(([l]) => /SANCTIONS_CLEARANCE_ATTESTOR_CHAIN_ID=97 SANCTIONS_CLEARANCE_TIMELOCK_CHAIN_IDS=84532,421614 /.test(l)));
  assert.ok(runs[0][1] > lines.indexOf('step bnb-testnet configure'));
});

test('a setting with several arguments is sent whole and read back by its first words', () => {
  const lines = plan().split('\n').filter((l) => l.startsWith('cmd arb-sepolia ') && l.includes('CapacityCurve'));
  assert.equal(lines.length, 4);
  assert.match(lines[2], /'setCapacityCurve\(uint8,uint256,uint256,uint256,uint256\)' 1 60000000000000000000 16666666666666667 10000000000000000000000 1000000000000000000 /);
  assert.match(lines[3], /'getCapacityCurve\(uint8\)\(\(uint256,uint256,uint256,uint256,uint64,uint64\)\)' 1 --rpc-url/);
  assert.match(lines[3], /cut -d' ' -f1-4 \| tr 'A-F' 'a-f'\)" = "60000000000000000000 16666666666666667 10000000000000000000000 1000000000000000000"$/);
});

test('the service capacity escrow is bound and recorded before the settings switch the channel on', () => {
  const lines = plan().split('\n');
  const bind = lines.findIndex((l) => l.startsWith('cmd bnb-testnet ') && l.includes('BindServiceCapacityEscrow.s.sol --rpc-url'));
  const enable = lines.findIndex((l) => l.startsWith('cmd bnb-testnet ') && l.includes("'setServiceCapacityEnabled(bool)' true"));
  assert.ok(bind > 0 && bind < enable);
});

test('every setting is applied and read back on its own chains only', () => {
  const lines = plan().split('\n');
  const grace = lines.filter((l) => l.includes('RewardGraceSeconds'));
  assert.equal(grace.length, 2);
  assert.ok(grace.every((l) => l.startsWith('cmd base-sepolia ')));
  const gate = lines.filter((l) => l.includes('RiskAccessGateEnabled'));
  assert.equal(gate.length, 6);
  assert.ok(lines.some((l) => /test "\$\(cast call "\$D" 'getRiskAccessGateEnabled\(\)\(bool\)'/.test(l)));
});

test('hand steps sign through vk_cast_send and never carry a key or a literal RPC', () => {
  const cmds = plan().split('\n').filter((l) => l.startsWith('cmd '));
  assert.ok(cmds.length > 30);
  for (const l of cmds) {
    assert.doesNotMatch(l, /--private-key|PRIVATE_KEY|cast send /);
    assert.doesNotMatch(l, /https?:\/\//);
    assert.doesNotMatch(l, /#/);
  }
  assert.ok(cmds.filter((l) => / R=/.test(l)).every((l) => /R="\$\{RPC:-\$[A-Z_]+_RPC_URL\}"/.test(l)));
});

test('a manual step without a command is printed as manual, one with a command as cmd', () => {
  const d0 = real();
  d0.manual = [{ after: 'launch', chains: ['base-sepolia'], what: 'a step nobody has written a command for yet' }];
  assert.ok(plan(d0).split('\n').some((l) => /^manual base-sepolia -- a step nobody has written/.test(l)));
  const d = real();
  d.manual = [{ after: 'configure', chains: 'all', what: 'top up the broadcast budget on each chain', run: "vk_cast_send ADMIN \"$D\" 'f()' --rpc-url \"$R\"" }];
  const l2 = plan(d).split('\n').filter((l) => l.includes("'f()'"));
  assert.equal(l2.length, 3);
  assert.ok(l2.every((l) => l.startsWith('cmd ')));
});

test('the keeper arming list is printed per chain', () => {
  assert.match(plan(), /# {3}arb-sepolia: KEEPER_ENABLED GRACE_DEFAULT_ENABLED/);
});

test('the plan names the desired file and its hash, so the plan digest covers it', () => {
  assert.match(plan().split('\n')[0], /^# desired x\.json sha256 f{64}$/);
});

test('today anchor is 00:00 UTC', () => {
  assert.equal(todayAnchor(1795305600 + 3599), 1795305600);
});
