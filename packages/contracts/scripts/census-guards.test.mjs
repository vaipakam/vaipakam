// census-guards.test.mjs — the census's replacement guard and finality picker
// are PURE functions (Codex #2070 r23); every rule they carry is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFinalitySample, snapshotRegression } from './census-grandfathered-custody.mjs';

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
  assert.match(run(cur, next, { ancestry: new Map([['x', { height: 100n, hash: H(7) }]]) }).reason, /NOT an ancestor/);
  assert.match(run(cur, next, { ancestry: new Map([['x', { height: 99n, hash: H(1) }]]) }).reason, /could not be verified/);
  assert.equal(run(cur, next, { ancestry: new Map([['x', { height: 100n, hash: H(1) }]]) }).reason, null);
});

test('regression: a dropped identity is refused unless acknowledged, and acknowledged changes are recorded and carried forward', () => {
  const anc = new Map([['x', { height: 100n, hash: H(1) }]]);
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
