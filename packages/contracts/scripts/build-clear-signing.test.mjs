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
import { toEventSelector, toFunctionSelector } from 'viem';

import * as display from '../clear-signing/display.mjs';
import {
  abiLeaves,
  build,
  deployEventSignature,
  formatKey,
  loadInputs,
  parseEncodeType,
  readTypeString,
  selectorOfKey,
  serialize,
  typedLeaves,
  validate,
  VAULT_CONTRACTS,
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

// ── The person's own vault (#3818) ──────────────────────────────────────

const VAULT_FILE = 'calldata-VaipakamVault.json';
const vaultFn = (key) => {
  const [contract, name] = key.split('.');
  return inputs.vaultAbis[contract].find((x) => x.type === 'function' && x.name === name);
};

test('every vault user function has one format, keyed by its own selector, covering its inputs one to one', () => {
  const formats = result.files[VAULT_FILE].display.formats;
  const users = Object.entries(inputs.scope.vaultFunctions).filter(([, c]) => c === 'user').map(([k]) => k);
  assert.equal(Object.keys(formats).length, users.length);
  for (const key of users) {
    const fn = vaultFn(key);
    const fk = formatKey(fn);
    assert.ok(formats[fk], `${key} has no format`);
    assert.equal(formats[fk].$id, key);
    assert.equal(selectorOfKey(fk), toFunctionSelector(fn), `${key}: the format key does not hash to the function's selector`);
    const fields = formats[fk].fields.filter((f) => !f.path.startsWith('@.'));
    assert.deepEqual(fields.map((f) => f.path), abiLeaves(fn.inputs).map((l) => l.path), `${key}: fields do not match the inputs`);
  }
});

test('protect(bytes) shows its data as calldata the vault itself runs', () => {
  const fmt = result.files[VAULT_FILE].display.formats['protect(bytes data)'];
  assert.deepEqual(fmt.fields, [{ path: 'data', label: 'Change', format: 'calldata', params: { calleePath: '@.to' } }]);
  // The inner call runs AS the vault (a delegatecall), so every function it
  // can name must be described in this same file, and none may share a
  // selector with the vault's own surface (the vault would run its own).
  const own = new Set(inputs.vaultAbis.VaipakamVaultImplementation.filter((x) => x.type === 'function').map((f) => toFunctionSelector(f)));
  for (const c of ['VaultProtection', 'VaultRecovery']) {
    for (const f of inputs.vaultAbis[c].filter((x) => x.type === 'function')) {
      assert.ok(!own.has(toFunctionSelector(f)), `${c}.${f.name} shares a selector with the vault itself`);
    }
  }
});

test('the vault descriptor binds every vault through the Diamond\'s vault-creation event', () => {
  const ctx = result.files[VAULT_FILE].context.contract;
  assert.equal(ctx.deployments, undefined, 'a vault address is not known ahead of time');
  const diamonds = result.files['calldata-VaipakamDiamond.json'].context.contract.deployments;
  assert.deepEqual(ctx.factory.deployments, diamonds);
  assert.equal(ctx.factory.deployEvent, 'UserVaultCreated(address indexed user,address proxy)');
  assert.equal(ctx.factory.deployEvent, deployEventSignature(inputs.abis));
  const ev = inputs.abis.VaultFactoryFacet.find((x) => x.type === 'event' && x.name === 'UserVaultCreated');
  assert.equal(toEventSelector(ctx.factory.deployEvent.replace(' indexed', '')), toEventSelector(ev));
  assert.deepEqual(Object.keys(inputs.vaultAbis).sort(), [...VAULT_CONTRACTS].sort());
});

test('a vault Diamond field must be a Diamond, and a direct call hides only the signature', () => {
  const diamonds = result.files['calldata-VaipakamDiamond.json'].context.contract.deployments.map((d) => d.address);
  for (const fmt of Object.values(result.files[VAULT_FILE].display.formats)) {
    const d = fmt.fields.find((f) => f.path === 'diamond');
    if (d) assert.deepEqual(d.visible, { mustMatch: diamonds });
    for (const f of fmt.fields) {
      if (f.visible === 'never') assert.match(f.path, /(^|\.)sig$/, `${fmt.$id}: ${f.path} is hidden`);
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

test('an unclassified vault function is refused by name, and the ledger binds the vault too', async () => {
  const i = { ...inputs, scope: clone(inputs.scope) };
  delete i.scope.vaultFunctions['VaultProtection.lock'];
  const p = await problemsOf(i);
  assert.ok(p.some((x) => x.includes('VaultProtection.lock is not classified')), p.join('\n'));
  const j = { ...inputs, scope: clone(inputs.scope) };
  j.scope.vaultFunctions['VaultRecovery.settleRecoveryAddress'] = 'internal';
  assert.ok((await problemsOf(j)).some((x) => x.includes('VaultRecovery.settleRecoveryAddress is a user step')));
  const calls = clone(display.VAULT_CALLS);
  delete calls['VaultProtection.lock'];
  assert.ok((await problemsOf(null, { ...display, VAULT_CALLS: calls })).some((x) => x.includes('VaultProtection.lock has no intent in VAULT_CALLS')));
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
