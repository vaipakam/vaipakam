// Tests for contracts/script/rehearsal-inputs.mjs (#3891, deploy rehearsal design §18, §20 test 10 in part).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReads, envFileNames, envReadsIn, envPrefixLiteralsIn, inputDigest, readInputs } from '../../../contracts/script/rehearsal-inputs.mjs';

const spec = readInputs();
const lit = (value) => ({ nodeType: 'Literal', kind: 'string', value });
const read = (arg, m = 'envOr') => ({ nodeType: 'FunctionCall', expression: { nodeType: 'MemberAccess', memberName: m }, arguments: [arg] });

const realEnv = {
  ADMIN_ADDRESS: '0xa', TREASURY_ADDRESS: '0xt', CCIP_LANE_CHAIN_IDS: '421614',
  ADMIN_PRIVATE_KEY: '0xsecret', DEPLOYER_PRIVATE_KEY: '0xsecret2', BASE_SEPOLIA_RPC_URL: 'https://p/v2/k',
};
const rehearsalEnv = {
  ADMIN_ADDRESS: '0xa', TREASURY_ADDRESS: '0xt', CCIP_LANE_CHAIN_IDS: '421614',
  ADMIN_PRIVATE_KEY: '0', DEPLOYER_PRIVATE_KEY: '0', BASE_SEPOLIA_RPC_URL: 'https://p/v2/k',
  VAIPAKAM_REHEARSAL: '1', VAIPAKAM_REHEARSAL_ROOT: 'deployments/.forge-test/rehearsal/r1',
  VAIPAKAM_REHEARSAL_RPC_URL: 'http://127.0.0.1:18545', FOUNDRY_BROADCAST: '/x', FOUNDRY_CACHE_PATH: '/y',
};
const fileNames = ['ADMIN_ADDRESS', 'TREASURY_ADDRESS', 'ADMIN_PRIVATE_KEY', 'DEPLOYER_PRIVATE_KEY', 'BASE_SEPOLIA_RPC_URL', 'CCIP_LANE_CHAIN_IDS'];

test('test 10: a rehearsal and a real run with the same inputs have one input digest', () => {
  assert.equal(inputDigest(rehearsalEnv, fileNames, spec).digest, inputDigest(realEnv, fileNames, spec).digest);
});

test('a changed input changes the digest; so does setting an unset one', () => {
  const base = inputDigest(realEnv, fileNames, spec).digest;
  assert.notEqual(inputDigest({ ...realEnv, CCIP_LANE_CHAIN_IDS: '421614,97' }, fileNames, spec).digest, base);
  assert.notEqual(inputDigest({ ...realEnv, PAUSER_ADDRESS: '0xp' }, fileNames, spec).digest, base);
});

test('a name only the .env file carries is in the set', () => {
  const a = inputDigest({ ...realEnv, MY_NEW_SETTING: '1' }, [...fileNames, 'MY_NEW_SETTING'], spec);
  const b = inputDigest({ ...realEnv, MY_NEW_SETTING: '2' }, [...fileNames, 'MY_NEW_SETTING'], spec);
  assert.ok(a.names.includes('MY_NEW_SETTING'));
  assert.notEqual(a.digest, b.digest);
});

test('no key, RPC value or declared difference is in the set', () => {
  const { names } = inputDigest(rehearsalEnv, fileNames, spec);
  for (const n of names) assert.doesNotMatch(n, /PRIVATE_KEY$|_RPC_URL$|^VAIPAKAM_REHEARSAL|^FOUNDRY_/);
});

test('test 10: a variable read outside the input set and the left-out list fails the check', () => {
  const asts = new Map([['script/X.s.sol', { nodeType: 'SourceUnit', nodes: [read(lit('A_BRAND_NEW_SETTING'))] }]]);
  const p = checkReads(asts, { ...spec, dynamicSites: [] });
  assert.equal(p.length, 1);
  assert.match(p[0], /A_BRAND_NEW_SETTING/);
});

test('a name built at run time fails unless its file is listed', () => {
  const ast = { nodeType: 'SourceUnit', nodes: [read({ nodeType: 'FunctionCall' })] };
  assert.equal(envReadsIn(ast).dynamic, 1);
  assert.equal(checkReads(new Map([['script/Y.s.sol', ast]]), { ...spec, dynamicSites: [] }).length, 1);
  const listed = { ...spec, dynamicSites: [{ path: 'script/Y.s.sol', patterns: ['*'], reason: 'r' }] };
  assert.equal(checkReads(new Map([['script/Y.s.sol', ast]]), listed).length, 0);
});

test('env file names are read without values', () => {
  assert.deepEqual(envFileNames('# c\nA=1\nexport B=2\n  C = 3\nnot a line\n'), ['A', 'B', 'C']);
});

test('every left-out pattern has a reason', () => {
  for (const e of spec.leftOut) assert.ok(e.reason.length > 20, e.pattern);
});

test('a name a script builds at run time is in the set when only exported', () => {
  const base = inputDigest(realEnv, fileNames, spec).digest;
  assert.notEqual(inputDigest({ ...realEnv, DEPLOYER_ADDRESS: '0xd' }, fileNames, spec).digest, base);
  assert.notEqual(inputDigest({ ...realEnv, BASE_SEPOLIA_ETH_USD_FEED: '0xf' }, fileNames, spec).digest, base);
  assert.notEqual(inputDigest({ ...realEnv, ARB_SEPOLIA_ZEROX_PROXY: '0xz' }, fileNames, spec).digest, base);
});

test('a key literal in a file that builds names must be covered', () => {
  const ast = { nodeType: 'SourceUnit', nodes: [read({ nodeType: 'FunctionCall' }), lit('SOME_NEW_KEY'), lit('KEEPER_ROLE')] };
  const listed = { ...spec, dynamicSites: [{ path: 'script/Y.s.sol', patterns: ['*_*'], reason: 'chain-prefixed keys' }] };
  const p = checkReads(new Map([['script/Y.s.sol', ast]]), listed);
  assert.equal(p.length, 1);
  assert.match(p[0], /SOME_NEW_KEY/);
});

test('chainPrefixes must be the prefixes envPrefix returns', () => {
  const dep = { nodeType: 'FunctionDefinition', name: 'envPrefix', body: [lit('BASE_SEPOLIA_'), lit('NEW_CHAIN_')] };
  assert.deepEqual([...envPrefixLiteralsIn(dep)].sort(), ['BASE_SEPOLIA_', 'NEW_CHAIN_']);
  const p = checkReads(new Map([['script/lib/Deployments.sol', { nodeType: 'SourceUnit', nodes: [dep] }]]), { ...spec, dynamicSites: [] });
  assert.ok(p.some((x) => /chainPrefixes/.test(x)), p.join('\n'));
});
