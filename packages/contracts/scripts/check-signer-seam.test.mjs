// Tests for contracts/script/check-signer-seam.mjs (#3891, deploy rehearsal design §12, test 5).

import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import {
  CONTRACTS_DIR,
  EXEMPT,
  HOME,
  KEY_NAME,
  SHELL_SCRIPTS,
  shellFindingsIn,
  findingsIn,
  scriptSources,
  staleExemptions,
  verdict,
} from '../../../contracts/script/check-signer-seam.mjs';

const lit = (value) => ({ nodeType: 'Literal', kind: 'string', value, src: '0:1:0' });
const member = (memberName) => ({ nodeType: 'MemberAccess', memberName, expression: { nodeType: 'Identifier', name: 'vm' } });
const call = (expression, args = []) => ({ nodeType: 'FunctionCall', expression, arguments: args, src: '0:1:0' });
const unit = (...statements) => ({ nodeType: 'SourceUnit', nodes: [{ nodeType: 'Block', statements }] });

test('a key read outside the library is a finding', () => {
  const f = findingsIn('script/X.s.sol', unit(call(member('envUint'), [lit('ADMIN_PRIVATE_KEY')])));
  assert.equal(f.length, 1);
  assert.match(f[0].what, /ADMIN_PRIVATE_KEY/);
});

test('a key name built from pieces is a finding', () => {
  const f = findingsIn('script/X.s.sol', unit(call(member('concat'), [lit('ADMIN'), lit('_PRIVATE_KEY')])));
  assert.equal(f.length, 1);
});

test('every signing cheatcode outside the library is a finding', () => {
  for (const name of ['startBroadcast', 'broadcast', 'rememberKey', 'rememberKeys', 'signDelegation']) {
    const f = findingsIn('script/X.s.sol', unit(call(member(name), [])));
    assert.equal(f.length, 1, name);
  }
});

test('prose naming a key variable (a revert message) is not a finding', () => {
  assert.equal(KEY_NAME.test('Launch: neither the admin key (ADMIN_PRIVATE_KEY) nor the Timelock holds UNPAUSER_ROLE'), false);
  assert.equal(findingsIn('script/X.s.sol', unit(lit('X: ADMIN_PRIVATE_KEY does not hold ADMIN_ROLE'))).length, 0);
});

test('stopBroadcast and ordinary env reads are not findings', () => {
  const f = findingsIn('script/X.s.sol', unit(call(member('stopBroadcast')), call(member('envAddress'), [lit('ADMIN_ADDRESS')])));
  assert.equal(f.length, 0);
});

test('the library itself and exempt paths are skipped', () => {
  const bad = unit(call(member('startBroadcast'), [lit('DEPLOYER_PRIVATE_KEY')]));
  const asts = new Map([
    [HOME, bad],
    ['script/e2e/DeployE2EFixture.s.sol', bad],
    ['script/positive-flows/PositiveFlowsBase.sol', bad],
    ['script/Launch.s.sol', bad],
  ]);
  const f = verdict(asts);
  assert.deepEqual([...new Set(f.map((x) => x.path))], ['script/Launch.s.sol']);
});

test('every exemption carries a reason and names a file that exists', () => {
  for (const e of EXEMPT) assert.ok(e.reason && e.reason.length > 20, e.path);
  assert.deepEqual(staleExemptions(scriptSources()), []);
  assert.equal(staleExemptions(['script/Other.s.sol']).length, EXEMPT.length);
});

test('the signer library is not exempted by folder (only by being the library)', () => {
  assert.ok(!EXEMPT.some((e) => HOME.startsWith(e.path) || e.path === HOME));
});

test('a shell send with --private-key is a finding; a comment is not', () => {
  const text = ['# cast send --private-key "$K" is how it used to be', 'cast send "$D" "f()" --private-key "$K" --rpc-url "$RPC"', 'vk_cast_send ADMIN "$D" "f()"'].join('\n');
  const f = shellFindingsIn('script/deploy-testnet.sh', text);
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 2);
});

test('the deploy scripts the shell rule covers exist', () => {
  assert.ok(SHELL_SCRIPTS.length >= 2);
  for (const sh of SHELL_SCRIPTS) assert.ok(existsSync(join(CONTRACTS_DIR, sh)), sh);
});
