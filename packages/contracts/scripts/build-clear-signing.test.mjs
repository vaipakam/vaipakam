/**
 * @file Tests for the clear-signing descriptor build (#3348, #3718 step 1).
 *       The first test is the CI check: the committed descriptors must be
 *       exactly what the generator builds from the current ABIs, sources and
 *       deployments.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { toFunctionSelector } from 'viem';

import * as display from '../clear-signing/display.mjs';
import {
  abiLeaves,
  build,
  formatKey,
  loadInputs,
  parseEncodeType,
  readTypeString,
  selectorOfKey,
  serialize,
  typedLeaves,
  validate,
} from './build-clear-signing.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESCRIPTORS = path.join(PKG, 'clear-signing/descriptors');

const inputs = loadInputs();
const result = await build(inputs, display);
const clone = (o) => structuredClone(o);

test('the committed descriptors are current and valid', async () => {
  assert.deepEqual(result.problems, []);
  assert.deepEqual(await validate(result.files), []);
  const committed = fs.readdirSync(DESCRIPTORS).filter((n) => n.endsWith('.json')).sort();
  assert.deepEqual(committed, Object.keys(result.files).sort(), 'descriptor set differs; run node packages/contracts/scripts/build-clear-signing.mjs');
  for (const [name, obj] of Object.entries(result.files)) {
    assert.equal(fs.readFileSync(path.join(DESCRIPTORS, name), 'utf8'), serialize(obj), `${name} is stale; run node packages/contracts/scripts/build-clear-signing.mjs`);
  }
});

test('every user function has exactly one calldata format, keyed by its own selector', () => {
  const formats = result.files['calldata-VaipakamDiamond.json'].display.formats;
  const users = Object.entries(inputs.scope.functions).filter(([, c]) => c === 'user').map(([k]) => k);
  assert.equal(Object.keys(formats).length, users.length);
  for (const key of users) {
    const [facet, name] = key.split('.');
    const fn = inputs.abis[facet].find((x) => x.type === 'function' && x.name === name);
    const fk = formatKey(fn);
    assert.ok(formats[fk], `${key} has no format`);
    assert.equal(formats[fk].$id, key);
    assert.equal(selectorOfKey(fk), toFunctionSelector(fn), `${key}: the format key does not hash to the function's selector`);
  }
});

test('every input of every user function is covered once, and every token path names an address in the same call', () => {
  const formats = result.files['calldata-VaipakamDiamond.json'].display.formats;
  for (const [key, cls] of Object.entries(inputs.scope.functions)) {
    if (cls !== 'user') continue;
    const [facet, name] = key.split('.');
    const fn = inputs.abis[facet].find((x) => x.type === 'function' && x.name === name);
    const leaves = abiLeaves(fn.inputs);
    const fields = formats[formatKey(fn)].fields.filter((f) => !f.path.startsWith('@.'));
    assert.deepEqual(fields.map((f) => f.path), leaves.map((l) => l.path), `${key}: fields do not match the inputs one to one`);
    const types = Object.fromEntries(leaves.map((l) => [l.path, l.type]));
    for (const f of fields) {
      if (f.params?.tokenPath) assert.equal(types[f.params.tokenPath], 'address', `${key} ${f.path}: tokenPath ${f.params.tokenPath} is not an address input`);
    }
  }
});

test('every EIP-712 format is keyed by its type string, read from the Solidity source', () => {
  for (const group of display.TYPED) {
    const file = result.files[`${group.file}.json`];
    for (const msg of group.messages) {
      const encodeType = (msg.prefix ?? '') + readTypeString(inputs.sources, msg.source[0], msg.source[1]);
      const fmt = file.display.formats[encodeType];
      assert.ok(fmt, `${group.file}: no format for ${msg.source[1]}`);
      const { primary, types } = parseEncodeType(encodeType);
      // Re-serialising the parsed type gives the key back: nothing was dropped.
      const again = Object.entries(types).map(([n, ms]) => `${n}(${ms.map((m) => `${m.type} ${m.name}`).join(',')})`).join('');
      assert.equal(again, encodeType);
      assert.deepEqual(fmt.fields.map((f) => f.path), typedLeaves(types, primary).map((l) => l.path));
    }
  }
});

test('the Permit2 witness carries the same SignedOffer type the maker signs directly', () => {
  const direct = readTypeString(inputs.sources, 'contracts/src/libraries/LibSignedOffer.sol', 'SIGNED_OFFER_TYPEHASH');
  const witness = readTypeString(inputs.sources, 'contracts/src/libraries/LibSignedOffer.sol', 'WITNESS_TYPE_STRING');
  assert.ok(witness.includes(direct), 'the witness SignedOffer body differs from SIGNED_OFFER_TYPEHASH');
});

test('the Permit2 spender and the vault messages\' Diamond must be a Diamond', () => {
  const diamonds = result.files['calldata-VaipakamDiamond.json'].context.contract.deployments.map((d) => d.address);
  const permit = result.files['eip712-vaipakam-permit2.json'];
  for (const fmt of Object.values(permit.display.formats)) {
    assert.deepEqual(fmt.fields.find((f) => f.path === 'spender').visible, { mustMatch: diamonds });
  }
  const vault = result.files['eip712-vaipakam-vault.json'];
  for (const fmt of Object.values(vault.display.formats)) {
    const d = fmt.fields.find((f) => f.path === 'diamond');
    if (d) assert.deepEqual(d.visible, { mustMatch: diamonds });
  }
});

test('the copy stays inside the platform\'s wording rules', () => {
  const banned = /\b(yield|apy|apr|income|earnings?|safe|guarantee[ds]?|pool|kyc|sanction\w*|benchmark|market rate)\b/i;
  const texts = [];
  for (const f of Object.values(result.files)) {
    for (const fmt of Object.values(f.display.formats)) {
      texts.push(fmt.intent);
      for (const fld of fmt.fields) if (fld.label) texts.push(fld.label);
    }
    for (const e of Object.values(f.metadata.enums ?? {})) texts.push(...Object.values(e));
  }
  for (const t of texts) assert.doesNotMatch(t, banned, `"${t}"`);
});

// ── Refusals ────────────────────────────────────────────────────────────

const problemsOf = async (mutInputs, mutDisplay) => (await build(mutInputs ?? inputs, mutDisplay ?? display)).problems;

test('an unclassified function is refused by name', async () => {
  const i = { ...inputs, scope: clone(inputs.scope) };
  delete i.scope.functions['RepayFacet.repayLoan'];
  const p = await problemsOf(i);
  assert.ok(p.some((x) => x.includes('RepayFacet.repayLoan is not classified')), p.join('\n'));
});

test('a facet-wide default is refused', async () => {
  const i = { ...inputs, scope: { ...clone(inputs.scope), facets: { AdminFacet: 'admin' } } };
  assert.ok((await problemsOf(i)).some((x) => x.includes('facet-wide defaults')));
});

test('a ledger user step classified otherwise is refused', async () => {
  const i = { ...inputs, scope: clone(inputs.scope) };
  i.scope.functions['ClaimFacet.claimAsLender'] = 'upkeep';
  i.ledger = { ...inputs.ledger, 'ClaimFacet.claimAsLender(uint256)': { class: 'user' } };
  assert.ok((await problemsOf(i)).some((x) => x.includes('ClaimFacet.claimAsLender is a user step')));
});

test('a user function with no intent, or an input with no rule, is refused', async () => {
  const calls = clone(display.CALLS);
  delete calls['RepayFacet.repayLoan'];
  assert.ok((await problemsOf(null, { ...display, CALLS: calls })).some((x) => x.includes('RepayFacet.repayLoan has no intent')));
  const leaves = { ...display.LEAVES };
  delete leaves.loanId;
  assert.ok((await problemsOf(null, { ...display, LEAVES: leaves })).some((x) => x.includes('no rule for "loanId"')));
});

test('a hidden field needs a reason, and an enum cannot be shown raw', async () => {
  const leaves = { ...display.LEAVES, nonce: { hide: '' } };
  assert.ok((await problemsOf(null, { ...display, LEAVES: leaves })).some((x) => x.includes('needs its reason')));
  const raw = { ...display.LEAVES, deliverTo: display.raw('Deliver to') };
  assert.ok((await problemsOf(null, { ...display, LEAVES: raw })).some((x) => x.includes('enum LibVaipakam.RewardDelivery must be shown by name')));
});

test('enum labels must match the Solidity members exactly', async () => {
  const missing = { ...display.LEAVES, offerType: display.solEnum('Side', 'LibVaipakam.OfferType', { Lender: 'Lend' }) };
  assert.ok((await problemsOf(null, { ...display, LEAVES: missing })).some((x) => x.includes('OfferType.Borrower has no label')));
  const extra = { ...display.LEAVES, offerType: display.solEnum('Side', 'LibVaipakam.OfferType', { Lender: 'Lend', Borrower: 'Borrow', Third: 'x' }) };
  assert.ok((await problemsOf(null, { ...display, LEAVES: extra })).some((x) => x.includes('which the enum does not have')));
});

test('a rule for a path the call does not have is refused', async () => {
  const calls = clone(display.CALLS);
  calls['RepayFacet.repayLoan'].fields = { notAnInput: display.raw('x') };
  assert.ok((await problemsOf(null, { ...display, CALLS: calls })).some((x) => x.includes('"notAnInput", which this call does not have')));
});

test('a type string is read through string concatenation and comments', () => {
  const sources = [{ rel: 'x.sol', text: 'bytes32 constant T = keccak256(\n "A(uint256 a,"\n "B b)"\n "B(address c)");' }];
  assert.equal(readTypeString(sources, 'x.sol', 'T'), 'A(uint256 a,B b)B(address c)');
  assert.deepEqual(parseEncodeType('A(uint256 a,B[] b)B(address c)').types.A, [
    { type: 'uint256', name: 'a' },
    { type: 'B[]', name: 'b' },
  ]);
});
