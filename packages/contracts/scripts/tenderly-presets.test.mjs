// Tests for the Tenderly preset check (#2869, #2979).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DIAMOND_PLACEHOLDER,
  TIMELOCK_PLACEHOLDER,
  abiSignatures,
  canonicalType,
  checkPresets,
} from './tenderly-presets.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const TEMPLATE = readFileSync(here('../../../ops/tenderly/alerts.yaml'), 'utf8');
const ABI = JSON.parse(readFileSync(here('../src/diamondAbi.json'), 'utf8'));
const TIMELOCK_ABI = JSON.parse(readFileSync(here('../src/abis/VaipakamTimelock.json'), 'utf8'));
const ABIS = { [DIAMOND_PLACEHOLDER]: ABI, [TIMELOCK_PLACEHOLDER]: TIMELOCK_ABI };

const preset = (fields, indent = '  ') =>
  Object.entries(fields)
    .map(([k, v], i) => `${indent}${i === 0 ? '- ' : '  '}${k}: ${v}`)
    .join('\n');
const doc = (presets, indent) => `version: 1\nalerts:\n${presets.map((p) => preset(p, indent)).join('\n')}\n`;
const diamond = (id, kind, sig) => ({ id, contract: '"${DIAMOND_ADDRESS}"', [kind]: sig });

test('the committed template passes with every preset checked, the timelock one included', () => {
  const { bad, unchecked, count } = checkPresets(TEMPLATE, ABIS);
  assert.deepEqual(bad, []);
  assert.ok(count > 0);
  assert.deepEqual(unchecked, []);
});

test('a timelock preset is checked against the timelock ABI, not the Diamond one (#2650)', () => {
  const timelock = (sig) => ({ id: 't', contract: '"${TIMELOCK_ADDRESS}"', event: sig });
  const sig = 'CallScheduled(bytes32,uint256,address,uint256,bytes,bytes32,uint256)';
  assert.deepEqual(checkPresets(doc([timelock(sig)]), ABIS).bad, []);
  assert.ok(checkPresets(doc([timelock('CallScheduled(bytes32,uint256)')]), ABIS).bad.length > 0);
  // The Diamond does not emit the timelock's event, so the same preset on the
  // Diamond is refused: each placeholder is checked against its own contract.
  const onDiamond = checkPresets(doc([{ id: 'd', contract: '"${DIAMOND_ADDRESS}"', event: sig }]), ABIS);
  assert.ok(onDiamond.bad.length > 0);
});

test('a preset on a contract with no committed ABI is returned as unchecked', () => {
  const r = checkPresets(doc([{ id: 'o', contract: '"0x0000000000000000000000000000000000000001"', event: 'X()' }]), ABIS);
  assert.deepEqual(r.bad, []);
  assert.equal(r.unchecked.length, 1);
});

test('a struct parameter is written as its component tuple, array suffix kept', () => {
  assert.equal(
    canonicalType({
      type: 'tuple[2][]',
      components: [{ type: 'address' }, { type: 'tuple', components: [{ type: 'uint8' }, { type: 'bytes4[]' }] }],
    }),
    '(address,(uint8,bytes4[]))[2][]',
  );
  const sigs = abiSignatures(ABI);
  assert.ok(sigs.has('event DiamondCut((address,uint8,bytes4[])[],address,bytes)'));
  assert.ok(![...sigs].some((s) => s.includes('tuple')));
});

test('the canonical struct signature is accepted and the raw `tuple` form refused', () => {
  const ok = checkPresets(doc([diamond('cut', 'event', 'DiamondCut((address,uint8,bytes4[])[],address,bytes)')]), ABIS);
  assert.deepEqual(ok.bad, []);
  const raw = checkPresets(doc([diamond('cut', 'event', 'DiamondCut(tuple[],address,bytes)')]), ABIS);
  assert.equal(raw.bad.length, 1);
});

test('a re-indented list is parsed, not skipped: a wrong signature is still refused', () => {
  const r = checkPresets(doc([diamond('x', 'event', 'DoesNotExist(uint256)')], '    '), ABIS);
  assert.deepEqual(r.bad, ['x (event DoesNotExist(uint256) is not in the Diamond ABI)']);
});

test('a flow-style preset is parsed too', () => {
  const r = checkPresets('alerts: [{id: x, contract: "${DIAMOND_ADDRESS}", event: "DoesNotExist(uint256)"}]\n', ABIS);
  assert.equal(r.bad.length, 1);
});

test('an error signature is checked against errors, not events', () => {
  assert.deepEqual(checkPresets(doc([diamond('e', 'error', 'StalePriceData()')]), ABIS).bad, []);
  assert.equal(checkPresets(doc([diamond('e', 'event', 'StalePriceData()')]), ABIS).bad.length, 1);
});

test('a template with no presets fails closed', () => {
  for (const text of ['version: 1\n', 'alerts: []\n', 'alerts: {}\n', 'alerts: [\n']) {
    assert.ok(checkPresets(text, ABIS).bad.length > 0, text);
  }
});

test('a preset missing a field, or naming both kinds, is refused', () => {
  const cases = [
    [{ id: 'a', event: 'LiquidationFallback(uint256)' }, /names no contract/],
    [{ id: 'b', contract: '"${DIAMOND_ADDRESS}"' }, /exactly one event or error/],
    [{ id: 'c', contract: '"${DIAMOND_ADDRESS}"', event: 'LiquidationFallback(uint256)', error: 'StalePriceData()' }, /exactly one/],
    [{ contract: '"${DIAMOND_ADDRESS}"', event: 'LiquidationFallback(uint256)' }, /has no id/],
  ];
  for (const [fields, re] of cases) {
    const { bad } = checkPresets(doc([fields]), ABIS);
    assert.ok(bad.some((b) => re.test(b)), JSON.stringify({ fields, bad }));
  }
  assert.ok(checkPresets('alerts:\n  - just-a-string\n', ABIS).bad.some((b) => /not a mapping/.test(b)));
});

test('a duplicated id is refused', () => {
  const p = diamond('dup', 'event', 'LiquidationFallback(uint256)');
  assert.ok(checkPresets(doc([p, p]), ABIS).bad.some((b) => /listed twice/.test(b)));
});
