// census-guards.test.mjs — the census's replacement guard and finality picker
// are PURE functions (Codex #2070 r23); every rule they carry is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFinalitySample, snapshotRegression, blockRef, assertSampledHashesAgree, revertErrorLikeViem, isExecutionRevert, isFunctionDoesNotExistRevert, makeRoutingBoundary, UNROUTED } from './census-grandfathered-custody.mjs';
import { toFunctionSelector } from 'viem';
import { readFileSync } from 'node:fs';

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
  const raw = { code: 3, details: 'execution reverted', data: '0xA9AD62F8' };
  const e = revertErrorLikeViem(raw, abi, 'getIntentCommit');
  assert.ok(e instanceof Error);
  assert.match(e.message, /reverted with the following signature:\n0xa9ad62f8/);
  assert.equal(e.signature, '0xa9ad62f8');
  assert.equal(e.data, '0xa9ad62f8', 'raw data is lower-cased and kept');
  assert.equal(e.shortMessage, 'The contract function "getIntentCommit" reverted.');
  // what the census's detector reads
  assert.equal(`${e.shortMessage} ${e.details} ${e.message}`.toLowerCase().includes('0xa9ad62f8'), true);
  // a known error decodes to its name, in the fields readContract populates
  const known = revertErrorLikeViem({ code: 3, details: 'execution reverted', data: toFunctionSelector('IntentNoCommit()') }, abi, 'getIntentCommit');
  assert.equal(known.errorName, 'IntentNoCommit');
  assert.match(known.metaMessages.join(' '), /IntentNoCommit\(\)/);
  // no revert data at all: not a revert the helper can shape
  assert.equal(revertErrorLikeViem({ details: 'header not found' }, abi, 'x'), null);
  // a PROVIDER failure that happens to carry hex data is never dressed as a revert (#2088 r1 P2)
  const provider = { code: -32602, message: 'invalid block reference', details: 'invalid block reference', data: '0xa9ad62f8' + '00'.repeat(28) };
  assert.equal(isExecutionRevert(provider), false);
  assert.equal(revertErrorLikeViem(provider, abi, 'x'), null);
  assert.equal(isExecutionRevert({ code: -32000, details: 'execution reverted: custom' }), true, 'the text still counts where a client uses another code');
  assert.equal(isExecutionRevert({ cause: { code: 3 } }), true);
  // a provider message that merely CONTAINS "revert" is not an execution revert (#2088 r3 P2)
  const revertedBlock = { code: -32602, message: 'cannot serve a reverted block', details: 'cannot serve a reverted block', data: '0xa9ad62f8' };
  assert.equal(isExecutionRevert(revertedBlock), false);
  assert.equal(revertErrorLikeViem(revertedBlock, abi, 'x'), null);
  // viem's other revert form (#2088 r4 P2): -32603 "Internal error" WITH revert data is a revert — the fallback signature comes through
  const internalWithData = { code: -32603, message: 'Internal error', details: 'Internal error', data: '0xa9ad62f8' };
  assert.equal(isExecutionRevert(internalWithData), true);
  const shaped = revertErrorLikeViem(internalWithData, abi, 'facetAddresses');
  assert.equal(shaped?.signature, '0xa9ad62f8');
  assert.equal(shaped?.data, '0xa9ad62f8');
  // … but an internal error WITHOUT data is a provider failure
  assert.equal(isExecutionRevert({ code: -32603, message: 'Internal error', details: 'Internal error' }), false);
  assert.equal(isExecutionRevert({ cause: { code: -32603, data: '0xa9ad62f8' } }), true, 'the code and data may sit on the cause');
});

test('isFunctionDoesNotExistRevert: only the EXACT four-byte fallback payload proves a selector unrouted on a Diamond (#2088 r2)', () => {
  const abi = [{ type: 'function', name: 'facetAddresses', inputs: [], outputs: [], stateMutability: 'view' }];
  // the real Diamond fallback: FunctionDoesNotExist() has no arguments → exactly 0xa9ad62f8
  const shell = revertErrorLikeViem({ code: 3, details: 'execution reverted', data: '0xA9AD62F8' }, abi, 'facetAddresses');
  assert.equal(isFunctionDoesNotExistRevert(shell), true);
  // the selector followed by ANY payload is some other contract talking
  const impostor = revertErrorLikeViem({ code: 3, details: 'execution reverted', data: '0xa9ad62f8' + '00'.repeat(31) + '01' }, abi, 'facetAddresses');
  assert.equal(isFunctionDoesNotExistRevert(impostor), false);
  // mentioning the selector in a message proves nothing
  assert.equal(isFunctionDoesNotExistRevert({ message: 'reverted with the following signature: 0xa9ad62f8', details: 'execution reverted' }), false);
  // an empty revert is not the fallback either
  assert.equal(isFunctionDoesNotExistRevert({ data: '0x' }), false);
  assert.equal(isFunctionDoesNotExistRevert(null), false);
});

test('the routing boundary: a read is gated by ITS OWN selector, answers UNROUTED instead of throwing, and probes each selector once (#2095 r26)', async () => {
  const probed = [];
  const reads = [];
  const routed = new Set(['getFallbackSnapshot']); // the Diamond routes the snapshot getter and NOT the loan getter
  const probe = async (fn) => { probed.push(fn); return routed.has(fn); };
  const read = async (fn, args) => { reads.push([fn, args]); return `${fn}:ok`; };
  const { selectorRouted, readRouted } = makeRoutingBoundary(probe, read);

  assert.equal(await readRouted('getFallbackSnapshot', [], [1n]), 'getFallbackSnapshot:ok');
  // THE REGRESSION: the loan getter is cut out. Before r26 this read threw
  // FunctionDoesNotExist and took the whole deployment's evidence with it.
  assert.equal(await readRouted('getLoanDetails', [], [1n]), UNROUTED, 'an unrouted selector answers the sentinel');
  assert.deepEqual(reads, [['getFallbackSnapshot', [1n]]], 'an unrouted selector is never called');

  // the per-loan loop asks again for every id: one probe per selector, not per read
  await readRouted('getFallbackSnapshot', [], [2n]);
  await readRouted('getLoanDetails', [], [2n]);
  assert.deepEqual(probed, ['getFallbackSnapshot', 'getLoanDetails'], 'routing is resolved once per selector');
  assert.equal(await selectorRouted('getFallbackSnapshot', [], [3n]), true, 'the gates read the same one answer');
  assert.equal(probed.length, 2);
});

test('the routing boundary does NOT remember a failed probe — only an answer is a fact about the Diamond (#2095 r26)', async () => {
  let attempt = 0;
  const probe = async () => { attempt += 1; if (attempt === 1) throw new Error('rate limited'); return true; };
  const { selectorRouted } = makeRoutingBoundary(probe, async () => 'value');
  await assert.rejects(() => selectorRouted('getIntentCommit', [], [1n]), /rate limited/);
  assert.equal(await selectorRouted('getIntentCommit', [], [1n]), true, 'the next caller probes again rather than inheriting a transport failure as "unrouted"');
  assert.equal(attempt, 2);
});

// #2095 r27 — the finalization is only worth anything if the census actually
// runs it, and no unit test can reach `applyLayoutProvenance` (it needs a
// client and a Diamond). Deleting its one call would leave every rule above
// green, which is the failure mode #1800 named on the deploy guard. So the
// CALL SITE is pinned here, structurally: the pass's every exit goes through
// the finalization, and the census's every exit goes through the pass.
test('#2095 r27 — every exit of the layout-provenance pass is finalized, and the census has no other exit', () => {
  const src = readFileSync(new URL('./census-grandfathered-custody.mjs', import.meta.url), 'utf8');
  const bodyOf = (signature) => {
    const at = src.indexOf(signature);
    assert.notEqual(at, -1, `${signature} — the function this test pins has been renamed; re-point the test rather than deleting it`);
    // the parameter list is destructured, so the first `{` after the signature
    // belongs to it — walk the parens out first, then take the body's brace
    let p = src.indexOf('(', at);
    let k = p;
    for (let depth = 0; k < src.length; k++) {
      if (src[k] === '(') depth++;
      else if (src[k] === ')' && --depth === 0) break;
    }
    let i = src.indexOf('{', k);
    for (let depth = 0, j = i; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
    }
    throw new Error(`${signature}: unbalanced braces`);
  };

  // only the function's OWN returns: a nested helper's return says nothing
  // about the exit the caller sees. Comments go first so a `return` written in
  // prose cannot be mistaken for one.
  const ownReturns = (body) => {
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const out = [];
    // a brace that opens a NESTED function body (`=>` or `function …()` before
    // it) hides everything under it; any other brace is a block or an object
    // literal and the returns inside it are still this function's own
    const stack = [];
    for (let i = 0; i < code.length; i++) {
      if (code[i] === '{') { stack.push(/(?:=>|\bfunction\b[^{;]*)\s*$/.test(code.slice(Math.max(0, i - 200), i))); continue; }
      if (code[i] === '}') { stack.pop(); continue; }
      if (stack.length && stack.some(Boolean)) continue;
      // `return` as a keyword: an identifier character on either side makes it
      // prose (`returned NONE`, in a message this function throws)
      if (stack.length && code.startsWith('return', i) && !/[A-Za-z0-9_$]/.test(code[i - 1] ?? ' ') && !/[A-Za-z0-9_$]/.test(code[i + 6] ?? ' ')) {
        const end = code.indexOf(';', i);
        out.push(code.slice(i + 'return'.length, end).trim());
        i = end;
      }
    }
    return out;
  };

  const pass = bodyOf('async function applyLayoutProvenance(');
  const returns = ownReturns(pass);
  assert.ok(returns.length, 'the pass returns something');
  for (const r of returns) {
    assert.ok(
      r.startsWith('finalizeVerdictFromEvidence('),
      `the layout-provenance pass returns \`${r}\` unfinalized — a class it withdraws would leave the liability aggregates stating the old figure (#2095 r27)`,
    );
  }

  // and the census's own exits are that pass, so there is no path around it
  const census = bodyOf('async function censusDeployment(');
  const exits = ownReturns(census).filter((r) => r.length);
  assert.ok(exits.length >= 3, 'the census has the code-absent exit, the shell exit and the full exit');
  for (const r of exits) {
    assert.ok(
      r.startsWith('applyLayoutProvenance(') || r.startsWith('finalizeVerdictFromEvidence('),
      `censusDeployment returns \`${r.slice(0, 60)}…\` through neither the layout-provenance pass nor the finalization — that path can publish a class verdict and a liability figure nothing re-derived (#2095 r27)`,
    );
  }
});
