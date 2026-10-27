// Tests for the Tenderly preset check (#2869, #2979).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalType, checkPresets, diamondSignatures } from './tenderly-presets.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const TEMPLATE = readFileSync(here('../../../ops/tenderly/alerts.yaml'), 'utf8');
const ABI = JSON.parse(readFileSync(here('../src/diamondAbi.json'), 'utf8'));

const preset = (fields, indent = '  ') =>
  Object.entries(fields)
    .map(([k, v], i) => `${indent}${i === 0 ? '- ' : '  '}${k}: ${v}`)
    .join('\n');
const doc = (presets, indent) => `version: 1\nalerts:\n${presets.map((p) => preset(p, indent)).join('\n')}\n`;
const diamond = (id, kind, sig) => ({ id, contract: '"${DIAMOND_ADDRESS}"', [kind]: sig });

test('the committed template passes, and only the timelock preset is unchecked', () => {
  const { bad, unchecked, count } = checkPresets(TEMPLATE, ABI);
  assert.deepEqual(bad, []);
  assert.ok(count > 0);
  assert.equal(unchecked.length, 1);
  assert.match(unchecked[0], /^timelock-call-scheduled \(\$\{TIMELOCK_ADDRESS\}: event /);
});

test('a struct parameter is written as its component tuple, array suffix kept', () => {
  assert.equal(
    canonicalType({
      type: 'tuple[2][]',
      components: [{ type: 'address' }, { type: 'tuple', components: [{ type: 'uint8' }, { type: 'bytes4[]' }] }],
    }),
    '(address,(uint8,bytes4[]))[2][]',
  );
  const sigs = diamondSignatures(ABI);
  assert.ok(sigs.has('event DiamondCut((address,uint8,bytes4[])[],address,bytes)'));
  assert.ok(![...sigs].some((s) => s.includes('tuple')));
});

test('the canonical struct signature is accepted and the raw `tuple` form refused', () => {
  const ok = checkPresets(doc([diamond('cut', 'event', 'DiamondCut((address,uint8,bytes4[])[],address,bytes)')]), ABI);
  assert.deepEqual(ok.bad, []);
  const raw = checkPresets(doc([diamond('cut', 'event', 'DiamondCut(tuple[],address,bytes)')]), ABI);
  assert.equal(raw.bad.length, 1);
});

test('a re-indented list is parsed, not skipped: a wrong signature is still refused', () => {
  const r = checkPresets(doc([diamond('x', 'event', 'DoesNotExist(uint256)')], '    '), ABI);
  assert.deepEqual(r.bad, ['x (event DoesNotExist(uint256) is not in the Diamond ABI)']);
});

test('a flow-style preset is parsed too', () => {
  const r = checkPresets('alerts: [{id: x, contract: "${DIAMOND_ADDRESS}", event: "DoesNotExist(uint256)"}]\n', ABI);
  assert.equal(r.bad.length, 1);
});

test('an error signature is checked against errors, not events', () => {
  assert.deepEqual(checkPresets(doc([diamond('e', 'error', 'StalePriceData()')]), ABI).bad, []);
  assert.equal(checkPresets(doc([diamond('e', 'event', 'StalePriceData()')]), ABI).bad.length, 1);
});

test('a template with no presets fails closed', () => {
  for (const text of ['version: 1\n', 'alerts: []\n', 'alerts: {}\n', 'alerts: [\n']) {
    assert.ok(checkPresets(text, ABI).bad.length > 0, text);
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
    const { bad } = checkPresets(doc([fields]), ABI);
    assert.ok(bad.some((b) => re.test(b)), JSON.stringify({ fields, bad }));
  }
  assert.ok(checkPresets('alerts:\n  - just-a-string\n', ABI).bad.some((b) => /not a mapping/.test(b)));
});

test('a duplicated id is refused', () => {
  const p = diamond('dup', 'event', 'LiquidationFallback(uint256)');
  assert.ok(checkPresets(doc([p, p]), ABI).bad.some((b) => /listed twice/.test(b)));
});
