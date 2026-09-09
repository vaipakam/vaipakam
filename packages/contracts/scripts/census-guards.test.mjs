// census-guards.test.mjs — the census's replacement guard and finality picker
// are PURE functions (Codex #2070 r23); every rule they carry is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFinalitySample, snapshotRegression, blockRef, assertSampledHashesAgree, revertErrorLikeViem } from './census-grandfathered-custody.mjs';
import { toFunctionSelector } from 'viem';

const H = (n) => `0x${String(n).padStart(64, 'a')}`;
const res = (chainSlug, deployment, atBlock, atBlockHash, diamond = '0xd1', vpfiToken = '0xt1') => ({ chainSlug, deployment, atBlock: String(atBlock), atBlockHash, diamond, vpfiToken });
const run = (current, results, opts = {}) => snapshotRegression({ current, results, ancestry: opts.ancestry ?? new Map(), acknowledged: opts.acknowledged ?? new Set(), now: 't' });

test('pickFinalitySample: lowest height wins; conflicting hashes at one height are refused', () => {
  const p = pickFinalitySample([{ number: 101n, hash: H(1) }, { number: 100n, hash: H(2) }, { number: 101n, hash: H(1) }]);
  assert.equal(p.number, 100n); assert.equal(p.hash, H(2)); assert.deepEqual(p.heights, ['100', '101']);
  assert.throws(() => pickFinalitySample([{ number: 100n, hash: H(1) }, { number: 100n, hash: H(9) }]), /disagree on the block HASH/);
});

test('regression: a lower height is refused', () => {
  const cur = { results: [res('x', 'live', 101, H(1))] };
  assert.match(run(cur, [res('x', 'live', 100, H(0))]).reason, /newer census is already committed/);
});

test('regression: equal height with a different hash is refused; same hash passes', () => {
  const cur = { results: [res('x', 'live', 100, H(1))] };
  assert.match(run(cur, [res('x', 'live', 100, H(2))]).reason, /DIFFERENT block hash/);
  assert.equal(run(cur, [res('x', 'live', 100, H(1))]).reason, null);
});

test('regression: a higher height must DESCEND from the committed block (r23)', () => {
  const cur = { results: [res('x', 'live', 100, H(1))] };
  const next = [res('x', 'live', 101, H(5))];
  assert.match(run(cur, next).reason, /could not be verified as an ancestor/);
  const P = { number: 101n, hash: H(5) };
  assert.match(run(cur, next, { ancestry: new Map([['x', { height: 100n, hash: H(1), proposed: P, verified: false, reason: 'parent-hash link broken at 101' }]]) }).reason, /NOT proven an ancestor.*link broken/);
  assert.match(run(cur, next, { ancestry: new Map([['x', { height: 99n, hash: H(1), proposed: P, verified: true }]]) }).reason, /could not be verified/);
  assert.match(run(cur, next, { ancestry: new Map([['x', { height: 100n, hash: H(1), proposed: { number: 105n, hash: H(9) }, verified: true }]]) }).reason, /bound to a different proposed block/);
  assert.match(run(cur, next, { ancestry: new Map([['x', { height: 100n, hash: H(1), verified: true }]]) }).reason, /bound to a different proposed block/);
  assert.equal(run(cur, next, { ancestry: new Map([['x', { height: 100n, hash: H(1), proposed: P, verified: true, method: 'parent-hash-link-walk' }]]) }).reason, null);
});

test('regression: a dropped identity is refused unless acknowledged, and acknowledged changes are recorded and carried forward', () => {
  const anc = new Map([['x', { height: 100n, hash: H(1), proposed: { number: 101n, hash: H(5) }, verified: true }]]);
  const cur = { results: [res('x', 'live', 100, H(1), '0xold')], identityChanges: [{ chainSlug: 'x', deployment: 'live', previous: { diamond: '0xancient', vpfiToken: null }, replacedBy: { diamond: '0xold', vpfiToken: null }, acknowledgedBy: 'earlier' }] };
  const next = [res('x', 'live', 101, H(5), '0xnew')];
  assert.match(run(cur, next, { ancestry: anc }).reason, /identity change/);
  const ok = run(cur, next, { ancestry: anc, acknowledged: new Set(['x|live']) });
  assert.equal(ok.reason, null); assert.equal(ok.fresh, 1);
  assert.deepEqual(ok.identityChanges.map((c) => c.previous.diamond), ['0xancient', '0xold'], 'carried forward, then the fresh one');
  // a scope-token change is an identity change too
  assert.match(run({ results: [res('x', 'live', 100, H(1), '0xd1', '0xA')] }, [res('x', 'live', 100, H(1), '0xd1', '0xB')]).reason, /identity change/);
});

test('regression: a deployment the committed artifact never had is fine; a clean re-run passes', () => {
  const cur = { results: [res('x', 'live', 100, H(1))] };
  assert.equal(run(cur, [res('x', 'live', 100, H(1)), res('y', 'live', 5, H(3))]).reason, null);
});

test('blockRef pins a state read to the block HASH and requires it canonical (r28)', () => {
  assert.deepEqual(blockRef({ number: 5n, hash: H(1).toUpperCase().replace('0X', '0x') }), { blockHash: H(1), requireCanonical: true });
  assert.throws(() => blockRef({ number: 5n }), /must be pinned to the census block's HASH/);
  assert.throws(() => blockRef({ number: 5n, hash: '0x12' }), /must be pinned to the census block's HASH/);
});

test('assertSampledHashesAgree: every sampled replica must serve the pinned hash at the chosen height (r28)', () => {
  assert.equal(assertSampledHashesAgree([H(1), H(1).toUpperCase().replace('0X', '0x'), H(1)], H(1), 100n, 't'), 3);
  // A at 100/A100 and B at 101/B101: what B serves at 100 decides — a different hash is a conflicting fork
  assert.throws(() => assertSampledHashesAgree([H(1), H(2)], H(1), 100n, 't'), /disagree on the block HASH at height 100/);
  // unanimous but not the pinned hash: the chain moved under the census
  assert.throws(() => assertSampledHashesAgree([H(2), H(2)], H(1), 100n, 't'), /pinned .* sampled/);
  assert.throws(() => assertSampledHashesAgree([], H(1), 100n, 't'), /disagree/);
});

test('revertErrorLikeViem: a revert the ABI cannot decode still carries its signature and raw data, a known one its name (post-#2070 regression)', () => {
  const abi = [{ type: 'error', name: 'IntentNoCommit', inputs: [] }, { type: 'function', name: 'getIntentCommit', inputs: [{ type: 'uint256', name: 'loanId' }], outputs: [], stateMutability: 'view' }];
  // the Diamond fallback's FunctionDoesNotExist(bytes4) — selector 0xa9ad62f8 — is in no facet ABI
  const raw = { details: 'execution reverted', data: '0xA9AD62F8' + '00'.repeat(28) + 'deadbeef' };
  const e = revertErrorLikeViem(raw, abi, 'getIntentCommit');
  assert.ok(e instanceof Error);
  assert.match(e.message, /reverted with the following signature:\n0xa9ad62f8/);
  assert.equal(e.signature, '0xa9ad62f8');
  assert.equal(e.data.startsWith('0xa9ad62f8'), true, 'raw data is lower-cased and kept');
  assert.equal(e.shortMessage, 'The contract function "getIntentCommit" reverted.');
  // what the census's detector reads
  assert.equal(`${e.shortMessage} ${e.details} ${e.message}`.toLowerCase().includes('0xa9ad62f8'), true);
  // a known error decodes to its name, in the fields readContract populates
  const known = revertErrorLikeViem({ details: 'execution reverted', data: toFunctionSelector('IntentNoCommit()') }, abi, 'getIntentCommit');
  assert.equal(known.errorName, 'IntentNoCommit');
  assert.match(known.metaMessages.join(' '), /IntentNoCommit\(\)/);
  // no revert data at all: not a revert the helper can shape
  assert.equal(revertErrorLikeViem({ details: 'header not found' }, abi, 'x'), null);
});
