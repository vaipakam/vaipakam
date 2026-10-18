// sanctions-delister.test.mjs — #2443: the unattended delister run, with every
// chain and network effect replaced by a fake, against the committed fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import { parseSdnAdvancedFile } from './ofac-sanctions-diff.mjs';
import { parseSdnPlainFile } from './ofac-sdn-plain.mjs';
import { SERVICE_CHAINS } from './sanctions-service.mjs';
import {
  ALERT_REPEAT_MS,
  RE_EVALUATE_MS,
  alertDigest,
  createClientLookup,
  evaluatePublication,
  planChain,
  planChains,
  readConfig,
  readRelayCache,
  readState,
  runDelister,
  shouldAlert,
  summarize,
  wantsPublication,
} from './sanctions-delister.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY = getAddress('0x00000000000000000000000000000000000000aa');
const OTHER = getAddress('0x00000000000000000000000000000000000000bb');
const TL = getAddress('0x00000000000000000000000000000000000000c1');
const LIST = getAddress('0x00000000000000000000000000000000000000c2');
const PK = `0x${'1'.repeat(64)}`;

// The fixtures list A1 and A2; 0x1111… is a False-reliability record in the
// advanced file that the plain file still carries.
const A1 = '0x1CAb8177ACe78b1B6B1c393371F4f2dCAE40CbEB';
const A2 = '0x252A8Bd2319d8A555b872990601221B3a2053Bce';
const FALSE_ONLY = '0x1111111111111111111111111111111111111111';
const D1 = getAddress('0x000000000000000000000000000000000000dead');
const D3 = getAddress('0x000000000000000000000000000000000000beef');
const D4 = getAddress('0x0000000000000000000000000000000000c0ffee');
const D5 = getAddress('0x00000000000000000000000000000000000f00d5');

const adv = await parseSdnAdvancedFile(join(HERE, 'fixtures', 'sdn_advanced.sample.xml'));
const plain = await parseSdnPlainFile(join(HERE, 'fixtures', 'sdn_plain.sample.xml'));
const PUBLICATION = {
  advanced: { parsed: adv.parsed, sourceHash: adv.sourceHash, source: { sha256: adv.sourceHash, publicationId: adv.parsed.publicationId } },
  plain: { parsed: plain.parsed, sourceHash: plain.sourceHash, source: { sha256: plain.sourceHash } },
};
const OLD_HASH = `0x${'9'.repeat(64)}`;

/** A snapshot of a timelock chain whose list follows the fixture
 *  publication, with five delistings outstanding (D1, FALSE_ONLY, D3, D4, D5)
 *  and nothing proposed; `o` overrides any part. */
function snapOf(o = {}) {
  const removals = [D1, FALSE_ONLY, D3, D4, D5];
  return {
    chainId: 84532,
    timelock: TL,
    timelockList: LIST,
    timelockIsRemover: true,
    roles: { proposer: true, timelockOwner: false, listAdder: false, listRemover: false, listOwner: false },
    route: 2,
    reservedDelistings: 0,
    proposalCount: 0,
    now: 1_000_000n,
    balance: 10n ** 18n,
    proposals: [],
    ...o,
    list: {
      address: LIST,
      version: 5n,
      latestVersion: 5n,
      sourceHash: adv.sourceHash,
      publicationDate: 20260307,
      pendingAdditions: 0,
      pendingDelistings: removals.length,
      addresses: [A1, A2, ...removals],
      ...o.list,
    },
  };
}

const facts = (entries) => new Map(Object.entries(entries).map(([a, f]) => [a.toLowerCase(), { vetoed: false, proposalOf: 0n, flagged: false, ...f }]));
const proposal = (o) => ({
  id: 1n,
  proposer: KEY,
  proposerAppointed: true,
  sourceHash: adv.sourceHash,
  publicationDate: 20260307,
  eta: 500_000n,
  accounts: [D1],
  unlisted: [],
  ready: false,
  reason: 'TooEarly',
  clearance: { requestId: 0n, requestedAt: 0n, state: 0 },
  ...o,
});

test('proposes only what both files support, minus vetoed, proposed and RedStone-flagged addresses', () => {
  const snap = snapOf({ reservedDelistings: 1 });
  const ev = evaluatePublication(snap, PUBLICATION);
  assert.equal(ev.status, 'ready');
  assert.deepEqual(ev.stillMentioned, [FALSE_ONLY]);
  const plan = planChain(snap, KEY, ev, facts({ [D1]: {}, [D3]: { vetoed: true }, [D4]: { flagged: true }, [D5]: { proposalOf: 7n } }));
  assert.deepEqual(plan.actions, [{ kind: 'propose', accounts: [D1], sourceHash: adv.sourceHash, publicationDate: 20260307, derived: true }]);
  assert.ok(plan.notes.some((n) => n.includes(`${D3} is vetoed by the Safe`)));
  assert.ok(plan.review.some((r) => r.includes(`${D4}: OFAC delisted it but RedStone flags it`)));
  assert.ok(plan.review.some((r) => r.includes(`${FALSE_ONLY}: the advanced file delists it but SDN.XML still mentions it`)));
});

test('an unreadable RedStone holds the address back; the proposal stays within what is outstanding, in batches', () => {
  const snap = snapOf({ reservedDelistings: 4 });
  const ev = evaluatePublication(snap, PUBLICATION);
  const plan = planChain(snap, KEY, ev, facts({ [D1]: {}, [D3]: { flagged: null }, [D4]: {}, [D5]: {} }));
  // One free slot: the first candidate only.
  assert.deepEqual(plan.actions.map((a) => a.accounts), [[D1]]);
  assert.ok(plan.notes.some((n) => n.includes(`${D3}: RedStone could not be read`)));
  const none = planChain(snapOf({ reservedDelistings: 5 }), KEY, ev, facts({ [D1]: {} }));
  assert.deepEqual(none.actions, []);
});

test('publication work is refused or deferred, never guessed at', () => {
  // OFAC serves a newer file than the list records: wait for the adder, and
  // hold executing and requesting meanwhile.
  const behind = evaluatePublication(snapOf({ list: { sourceHash: OLD_HASH, publicationDate: 20260301 } }), PUBLICATION);
  assert.equal(behind.status, 'mismatch');
  assert.match(behind.reason, /a newer publication; proposing, executing and requesting wait for the adder to record it/);
  assert.equal(behind.hold, behind.reason);
  assert.equal(behind.transient, undefined);
  // An OLDER copy than the list's (a stale download): no hold, read again next run.
  const stale = evaluatePublication(snapOf({ list: { sourceHash: OLD_HASH, publicationDate: 20260310 } }), PUBLICATION);
  assert.equal(stale.status, 'mismatch');
  assert.equal(stale.hold, undefined);
  assert.equal(stale.transient, true);
  // The list records this file under another date: a person reconciles it.
  const misdated = evaluatePublication(snapOf({ list: { publicationDate: 20260308 } }), PUBLICATION);
  assert.equal(misdated.status, 'refused');
  assert.match(misdated.reason, /records date 20260308 for this file, which is dated 20260307/);
  // The two files are different publications: OFAC published between the downloads.
  const torn = evaluatePublication(snapOf(), { ...PUBLICATION, plain: { ...PUBLICATION.plain, parsed: { ...plain.parsed, publicationDate: 20260308 } } });
  assert.equal(torn.status, 'refused');
  assert.equal(torn.transient, true);
  // A failed download is transient too.
  assert.equal(evaluatePublication(snapOf(), { error: 'x' }).transient, true);
  // The list declares a different count than the file supports.
  const count = evaluatePublication(snapOf({ list: { pendingDelistings: 4 } }), PUBLICATION);
  assert.equal(count.status, 'refused');
  assert.match(count.reason, /calls for 5 delisting\(s\) but the list declares 4 outstanding/);
  const plan = planChain(snapOf({ list: { pendingDelistings: 4 } }), KEY, count, new Map());
  assert.deepEqual(plan.actions, []);
  assert.ok(plan.review.some((r) => r.startsWith('publication work refused')));
  // A listed address still in the advanced file is a dropped record, not a delisting.
  const dropped = evaluatePublication(snapOf({ list: { pendingDelistings: 6 } }), {
    ...PUBLICATION,
    advanced: { ...PUBLICATION.advanced, parsed: { ...adv.parsed, addresses: [A1] } },
  });
  assert.equal(dropped.status, 'refused');
  assert.match(dropped.reason, /still appears in the source file/);
  // The two files disagree.
  const disagree = evaluatePublication(snapOf(), { ...PUBLICATION, plain: { ...PUBLICATION.plain, parsed: { ...plain.parsed, addresses: [A1] } } });
  assert.equal(disagree.status, 'refused');
  assert.match(disagree.reason, /the two OFAC files disagree/);
  // A list not yet final waits.
  const moving = planChain(snapOf({ list: { latestVersion: 6n } }), KEY, evaluatePublication(snapOf(), PUBLICATION), facts({ [D1]: {} }));
  assert.deepEqual(moving.actions, []);
  assert.match(moving.notes[0], /wait for it to be final/);
});

test('no route or no remover role: nothing is proposed, and the reason is stated', () => {
  const ev = evaluatePublication(snapOf(), PUBLICATION);
  const closed = planChain(snapOf({ route: 0 }), KEY, ev, facts({ [D1]: {} }));
  assert.deepEqual(closed.actions, []);
  assert.ok(closed.notes.some((n) => n.includes('clearance route Unavailable')));
  const notRemover = planChain(snapOf({ timelockIsRemover: false }), KEY, ev, facts({ [D1]: {} }));
  assert.deepEqual(notRemover.actions, []);
  assert.ok(notRemover.notes.some((n) => n.includes('not a remover of the list')));
});

test('moves pending proposals on: discard, withdraw, reconfirm, execute, request, relay', () => {
  const ev = evaluatePublication(snapOf(), PUBLICATION);
  const proposals = [
    proposal({ id: 1n, proposer: OTHER, proposerAppointed: false }),
    proposal({ id: 2n, unlisted: [D1] }),
    proposal({ id: 3n, sourceHash: OLD_HASH, accounts: [D1, D3] }),
    proposal({ id: 4n, sourceHash: OLD_HASH, accounts: [A1] }),
    proposal({ id: 5n, ready: true, reason: null }),
    proposal({ id: 6n, reason: 'ClearanceNotRequested' }),
    proposal({ id: 7n, reason: 'ClearanceExpired', proposer: OTHER }),
    proposal({ id: 8n, reason: 'ClearanceNotAnswered', relay: { status: 'owed', messageId: `0x${'e'.repeat(64)}`, payload: '0x1234', sourceChainId: 421614, attestor: OTHER } }),
    proposal({ id: 9n, reason: 'ClearanceNotAnswered', relay: { status: 'in-flight' } }),
    proposal({ id: 10n, reason: 'Vetoed' }),
    proposal({ id: 11n, reason: 'Vetoed', proposer: OTHER }),
    proposal({ id: 12n, reason: 'ClearanceFlagged' }),
    proposal({ id: 13n, eta: 2_000_000n }),
    proposal({ id: 14n, reason: 'AdditionsOutstanding' }),
    proposal({ id: 15n, proposer: OTHER, unlisted: [D3], accounts: [D3], ready: true, reason: null }),
    proposal({ id: 16n, reason: 'OracleStale' }),
    proposal({ id: 17n, publicationDate: 20260301, accounts: [D4] }),
  ];
  const plan = planChain(snapOf({ proposals, reservedDelistings: 5 }), KEY, ev, new Map());
  const byId = Object.fromEntries(plan.actions.map((a) => [a.id?.toString(), a]));
  assert.equal(byId['1'].kind, 'discard');
  assert.equal(byId['2'].kind, 'withdraw');
  assert.deepEqual(byId['3'], { kind: 'reconfirm', id: 3n, sourceHash: adv.sourceHash, publicationDate: 20260307, derived: true });
  assert.equal(byId['4'].kind, 'withdraw');
  assert.match(byId['4'].why, /no longer supports delisting 0x1CAb/);
  assert.equal(byId['5'].kind, 'execute');
  assert.equal(byId['6'].kind, 'request');
  assert.equal(byId['7'].kind, 'request');
  assert.deepEqual(byId['8'], { kind: 'reply', id: 8n, sourceChainId: 421614, attestor: OTHER, messageId: `0x${'e'.repeat(64)}`, payload: '0x1234' });
  assert.equal(byId['9'], undefined);
  assert.equal(byId['10'].kind, 'withdraw');
  assert.equal(byId['11'], undefined, "another proposer's proposal is never withdrawn");
  assert.equal(byId['12'].kind, 'withdraw');
  assert.equal(byId['13'], undefined);
  assert.equal(byId['14'], undefined);
  assert.ok(plan.review.some((r) => r.includes('proposal 12: RedStone flags an address')));
  assert.ok(plan.review.some((r) => r.includes('proposal 4 was withdrawn')));
  assert.ok(plan.notes.some((n) => n.includes("proposal 14 waits for the list's outstanding additions")));
  assert.ok(!plan.review.some((r) => r.includes('proposal 14')), 'the adder applies additions on its own; no person is needed');
  // Another proposer's proposal naming a delisted address is never executed
  // (execute would revert), and a person hears it holds a share back.
  assert.equal(byId['15'], undefined);
  assert.ok(plan.review.some((r) => r.includes('proposal 15 (another proposer') && r.includes('holds back 1 of the outstanding delistings')));
  // A stale RedStone stops a proposal no step here can move: a person hears it.
  assert.equal(byId['16'], undefined);
  assert.ok(plan.review.some((r) => r.includes('proposal 16 is matured but not executable: OracleStale')));
  // Same file, another date: the publication changed as far as execute is concerned.
  assert.equal(byId['17'].kind, 'reconfirm');
});

test('executing and requesting wait while OFAC serves a newer publication or the list is mid-update', () => {
  const proposals = [proposal({ id: 1n, ready: true, reason: null }), proposal({ id: 2n, reason: 'ClearanceExpired' })];
  const newer = evaluatePublication(snapOf({ list: { sourceHash: OLD_HASH, publicationDate: 20260301 } }), PUBLICATION);
  const held = planChain(snapOf({ proposals: proposals.map((p) => ({ ...p, sourceHash: OLD_HASH, publicationDate: 20260301 })), reservedDelistings: 2, list: { sourceHash: OLD_HASH, publicationDate: 20260301 } }), KEY, newer, new Map());
  assert.deepEqual(held.actions, []);
  assert.ok(held.notes.some((n) => n.includes('proposal 1 is ready, but executing waits: the list records publication 20260301')));
  assert.ok(held.notes.some((n) => n.includes('proposal 2 needs a clearance request, which waits')));
  const moving = planChain(snapOf({ proposals, reservedDelistings: 2, list: { latestVersion: 6n } }), KEY, { status: 'not-loaded', reason: 'x' }, new Map());
  assert.deepEqual(moving.actions, []);
  assert.ok(moving.notes.some((n) => n.includes('executing waits: the list is mid-update')));
});

test('a stale proposal of its own waits when the files cannot be read', () => {
  const plan = planChain(snapOf({ proposals: [proposal({ sourceHash: OLD_HASH })] }), KEY, { status: 'not-loaded', reason: 'x' }, new Map());
  assert.deepEqual(plan.actions, []);
  assert.match(plan.notes[0], /older publication and cannot be re-checked yet/);
});

test('refuses a key that holds more than the proposer role, and a timelock serving another list', async () => {
  const chain = (snap) => ({ slug: 'base-sepolia', name: 'Base Sepolia', id: 84532, timelock: TL, list: LIST, effects: { readSnapshot: async () => snap, readFacts: async () => new Map(), send: async () => assert.fail('nothing may be sent') } });
  const load = async () => assert.fail('nothing may be downloaded');
  for (const [snap, re] of [
    [snapOf({ roles: { proposer: false } }), /not a proposer of this timelock/],
    [snapOf({ roles: { proposer: true, listRemover: true } }), /also the list's remover/],
    [snapOf({ roles: { proposer: true, timelockOwner: true, listAdder: true } }), /also the timelock's owner and the list's adder/],
    [snapOf({ timelockList: OTHER }), /serves list/],
  ]) {
    const { report } = await runDelister({ chains: [chain(snap)], key: KEY, loadPublication: load });
    assert.equal(report.status, 'failed');
    assert.match(report.chains['base-sepolia'].error, re);
  }
});

test('downloads only when there is publication work, and re-checks an unchanged chain once a day', async () => {
  let loads = 0;
  const sent = [];
  const chain = (snap) => ({
    slug: 'base-sepolia',
    name: 'Base Sepolia',
    id: 84532,
    timelock: TL,
    list: LIST,
    effects: {
      readSnapshot: async () => snap,
      readFacts: async (as) => facts(Object.fromEntries(as.map((a) => [a, a === D4 ? { flagged: true } : a === D3 ? { vetoed: true } : a === D5 ? { proposalOf: 1n } : {}]))),
      send: async (a, { onSubmitted }) => (sent.push(a), onSubmitted('0x01'), { hash: `0x${String(sent.length).padStart(64, '0')}`, blockNumber: 9n }),
    },
  });
  const loadPublication = async () => (loads++, PUBLICATION);
  const t0 = 10 * RE_EVALUATE_MS;
  const first = await runDelister({ chains: [chain(snapOf())], key: KEY, loadPublication, nowMs: t0 });
  assert.equal(loads, 1);
  assert.equal(first.report.status, 'ok');
  assert.deepEqual(sent.map((a) => a.kind), ['propose']);
  assert.ok(first.cache[84532]);
  // Same state an hour later: nothing new, no download.
  const second = await runDelister({ chains: [chain(snapOf())], key: KEY, loadPublication, cache: first.cache, nowMs: t0 + 3_600_000 });
  assert.equal(loads, 1);
  assert.ok(second.report.chains['base-sepolia'].notes.some((n) => n.includes('last checked against OFAC')));
  // A changed state, or a day later: checked again.
  await runDelister({ chains: [chain(snapOf({ reservedDelistings: 1, proposalCount: 1 }))], key: KEY, loadPublication, cache: first.cache, nowMs: t0 + 3_600_000 });
  assert.equal(loads, 2);
  await runDelister({ chains: [chain(snapOf())], key: KEY, loadPublication, cache: first.cache, nowMs: t0 + RE_EVALUATE_MS });
  assert.equal(loads, 3);
  // Nothing outstanding beyond what is proposed: no download at all.
  assert.equal(wantsPublication(snapOf({ reservedDelistings: 5 }), KEY, undefined, t0), false);
  // A route closed: no download either.
  assert.equal(wantsPublication(snapOf({ route: 0 }), KEY, undefined, t0), false);
  // A stale proposal of its own: a download, whatever the cache says about the count.
  assert.equal(wantsPublication(snapOf({ reservedDelistings: 5, proposals: [proposal({ sourceHash: OLD_HASH })] }), KEY, undefined, t0), true);
});

test('a failed send is recorded, the others still go, and a failed proposal is retried next run', async () => {
  const sent = [];
  const snap = snapOf({ reservedDelistings: 1, proposals: [proposal({ id: 1n, ready: true, reason: null }), proposal({ id: 2n, reason: 'ClearanceNotRequested' })] });
  const chain = {
    slug: 'base-sepolia',
    name: 'Base Sepolia',
    id: 84532,
    timelock: TL,
    list: LIST,
    effects: {
      readSnapshot: async () => snap,
      readFacts: async () => facts({ [D1]: {}, [D3]: {}, [D4]: {}, [D5]: { proposalOf: 1n } }),
      send: async (a, { onSubmitted }) => {
        sent.push(a.kind);
        if (a.kind === 'execute') throw new Error('execution reverted: StillSanctioned');
        if (a.kind === 'propose') {
          onSubmitted('0xabc');
          throw new Error('connection dropped');
        }
        return { hash: '0x02', blockNumber: 3n };
      },
    },
  };
  const { report, cache } = await runDelister({ chains: [chain], key: KEY, loadPublication: async () => PUBLICATION, nowMs: 1 });
  assert.deepEqual(sent, ['execute', 'request', 'propose']);
  const c = report.chains['base-sepolia'];
  assert.equal(c.status, 'partial');
  assert.deepEqual(c.actions.map((e) => e.state), ['failed', 'included', 'unknown']);
  assert.equal(report.status, 'failed');
  assert.equal(cache[84532], undefined, 'a proposal that did not land is retried next run');
  const text = summarize(report);
  assert.match(text, /execute proposal 1: FAILED, not sent \(execution reverted: StillSanctioned\)/);
  assert.match(text, /0xabc — signed and broadcast attempted, outcome unknown/);
});

test('a send the node refused is reported as not broadcast', async () => {
  const snap = snapOf({ reservedDelistings: 5, proposals: [proposal({ id: 1n, reason: 'ClearanceNotRequested' })] });
  const refused = Object.assign(new Error('the node refused it'), { notBroadcast: true });
  const chain = { slug: 'b', name: 'B', id: 84532, timelock: TL, list: LIST, effects: { readSnapshot: async () => snap, readFacts: async () => new Map(), send: async (a, { onSubmitted }) => (onSubmitted('0xdef'), Promise.reject(refused)) } };
  const { report } = await runDelister({ chains: [chain], key: KEY, loadPublication: async () => assert.fail('no download'), nowMs: 1 });
  assert.equal(report.chains.b.actions[0].state, 'rejected');
  assert.match(summarize(report), /0xdef — signed, but the node refused it; not broadcast/);
});

test('candidates that cannot be checked propose nothing and stop nothing else', async () => {
  const sent = [];
  const snap = snapOf({ reservedDelistings: 1, proposals: [proposal({ id: 1n, reason: 'ClearanceNotRequested' })] });
  const chain = {
    slug: 'b', name: 'B', id: 84532, timelock: TL, list: LIST,
    effects: {
      readSnapshot: async () => snap,
      readFacts: async () => { throw new Error('attestor chain RPC down'); },
      send: async (a) => (sent.push(a.kind), { hash: '0x02', blockNumber: 3n }),
    },
  };
  const { report, cache } = await runDelister({ chains: [chain], key: KEY, loadPublication: async () => PUBLICATION, nowMs: 1 });
  assert.deepEqual(sent, ['request']);
  assert.equal(report.chains.b.status, 'ok');
  assert.ok(report.chains.b.review.some((r) => r.includes('could not be read (attestor chain RPC down)')));
  assert.equal(cache[84532], undefined, 'checked again next run');
  // Nothing can be proposed (no route): the facts are not even read.
  const closed = { ...chain, effects: { ...chain.effects, readSnapshot: async () => snapOf({ route: 0 }), readFacts: async () => assert.fail('no facts without a route') } };
  await runDelister({ chains: [closed], key: KEY, loadPublication: async () => PUBLICATION, nowMs: 1 });
});

test('only a conclusive reading is cached', async () => {
  let loads = 0;
  const chainWith = (snap, send = async () => ({ hash: '0x02', blockNumber: 3n })) => ({ slug: 'b', name: 'B', id: 84532, timelock: TL, list: LIST, effects: { readSnapshot: async () => snap, readFacts: async (as) => facts(Object.fromEntries(as.map((a) => [a, {}]))), send } });
  // A failed download: not cached, and the next run downloads again.
  const failedLoad = await runDelister({ chains: [chainWith(snapOf())], key: KEY, loadPublication: async () => (loads++, Promise.reject(new Error('timeout'))), nowMs: 1 });
  assert.equal(failedLoad.cache[84532], undefined);
  await runDelister({ chains: [chainWith(snapOf())], key: KEY, loadPublication: async () => (loads++, PUBLICATION), cache: failedLoad.cache, nowMs: 2 });
  assert.equal(loads, 2);
  // Two files either side of a new publication: not cached.
  const torn = { ...PUBLICATION, plain: { ...PUBLICATION.plain, parsed: { ...plain.parsed, publicationDate: 20260308 } } };
  assert.equal((await runDelister({ chains: [chainWith(snapOf())], key: KEY, loadPublication: async () => torn, nowMs: 3 })).cache[84532], undefined);
  // A reconfirm that did not land: not cached.
  const stale = snapOf({ reservedDelistings: 5, proposals: [proposal({ sourceHash: OLD_HASH })] });
  const failedReconfirm = await runDelister({ chains: [chainWith(stale, async () => Promise.reject(new Error('reverted')))], key: KEY, loadPublication: async () => PUBLICATION, nowMs: 4 });
  assert.equal(failedReconfirm.cache[84532], undefined);
  // A newer publication than the list's: cached WITH its hold, which the
  // next run applies without downloading.
  const behind = snapOf({ reservedDelistings: 1, proposals: [proposal({ id: 1n, sourceHash: OLD_HASH, publicationDate: 20260301, ready: true, reason: null })], list: { sourceHash: OLD_HASH, publicationDate: 20260301 } });
  const sends = [];
  const first = await runDelister({ chains: [chainWith(behind, async (a) => (sends.push(a.kind), { hash: '0x02', blockNumber: 3n }))], key: KEY, loadPublication: async () => PUBLICATION, nowMs: 5 });
  assert.ok(first.cache[84532].hold);
  const second = await runDelister({ chains: [chainWith(behind, async (a) => (sends.push(a.kind), { hash: '0x02', blockNumber: 3n }))], key: KEY, loadPublication: async () => assert.fail('cached'), cache: first.cache, nowMs: 6 });
  assert.deepEqual(sends, []);
  assert.ok(second.report.chains.b.notes.some((n) => n.includes('executing waits')));
});

test('a proposal ready to execute is checked against OFAC first', () => {
  const ready = snapOf({ reservedDelistings: 5, proposals: [proposal({ ready: true, reason: null })] });
  assert.equal(wantsPublication(ready, KEY, undefined, 0), true);
  // Another proposer's proposal that would revert on a delisted address does not count.
  assert.equal(wantsPublication(snapOf({ reservedDelistings: 5, proposals: [proposal({ proposer: OTHER, ready: true, reason: null, unlisted: [D1] })] }), KEY, undefined, 0), false);
});

test('a configured chain with no timelock is named as the attestor chain it serves', async () => {
  const snap = snapOf({ route: 2, clearanceSourceChainId: 421614n, reservedDelistings: 5 });
  const { report } = await runDelister({
    chains: [
      { slug: 'b', name: 'Base Sepolia', id: 84532, timelock: TL, list: LIST, effects: { readSnapshot: async () => snap, readFacts: async () => new Map(), send: async () => assert.fail('no send') } },
      { slug: 'a', name: 'Arbitrum Sepolia', id: 421614, skipped: 'no SanctionsDelistingTimelock is recorded' },
    ],
    key: KEY,
    loadPublication: async () => assert.fail('no download'),
    nowMs: 1,
  });
  assert.match(report.chains.a.reason, /hosts the clearance attestor for Base Sepolia/);
});

test('alerts when something happens or needs a person, and repeats a standing condition once a day', () => {
  const quiet = { publication: { loaded: false }, chains: { a: { status: 'ok', actions: [], notes: ['waiting'], review: [] } } };
  assert.equal(alertDigest(quiet), null);
  assert.equal(shouldAlert(null, null, 0), false);
  const standing = { publication: { loaded: false }, chains: { a: { status: 'ok', actions: [], notes: [], review: ['x needs the Safe'] } } };
  const d = alertDigest(standing);
  assert.equal(shouldAlert(d, null, 0), true);
  assert.equal(shouldAlert(d, { digest: d, at: 0 }, ALERT_REPEAT_MS - 1), false);
  assert.equal(shouldAlert(d, { digest: d, at: 0 }, ALERT_REPEAT_MS), true);
  const sent = { publication: { loaded: false }, chains: { a: { status: 'ok', actions: [{ action: 'execute proposal 1', state: 'included', tx: '0x1' }], review: [] } } };
  assert.equal(shouldAlert(alertDigest(sent), { digest: d, at: 0 }, 1), true);
  // A run refused before any chain was read still reaches the chat.
  assert.notEqual(alertDigest({ status: 'refused', error: 'no configured chain has a SanctionsDelistingTimelock recorded in this release', chains: {} }), null);
});

test('state files: a damaged one reads as empty, never as a reason to stop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'delister-state-'));
  try {
    assert.deepEqual(readState(dir, 'missing.json'), {});
    writeFileSync(join(dir, 'evaluations.json'), 'null');
    assert.deepEqual(readState(dir, 'evaluations.json'), {});
    writeFileSync(join(dir, 'evaluations.json'), '[1,2]');
    assert.deepEqual(readState(dir, 'evaluations.json'), {});
    writeFileSync(join(dir, 'relay.json'), '{"messageIds": null, "payloads": 3}');
    assert.deepEqual(readRelayCache(dir), { messageIds: {}, payloads: {} });
    writeFileSync(join(dir, 'relay.json'), '{"messageIds": {"k": "v"}}');
    assert.deepEqual(readRelayCache(dir), { messageIds: { k: 'v' }, payloads: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every chain an RPC is used for must serve that chain, checked once', async () => {
  let asked = 0;
  const lookup = createClientLookup(new Map([
    [84532, { client: { getChainId: async () => (asked++, 84532) } }],
    [421614, { client: { getChainId: async () => 1 } }],
  ]));
  assert.ok(await lookup(84532));
  assert.ok(await lookup(84532n));
  assert.equal(asked, 1);
  await assert.rejects(lookup(421614), /configured for chain 421614 serves chain 1/);
  assert.equal(await lookup(11155111), null);
});

test('configuration: one file for every chain, addresses from the release only', () => {
  assert.throws(() => readConfig({}), /SANCTIONS_DELISTER_PRIVATE_KEY, an RPC for at least one chain .*SANCTIONS_DELISTER_STATE_DIR/);
  const cfg = readConfig({ SANCTIONS_DELISTER_PRIVATE_KEY: PK, RPC_BASE_SEPOLIA: 'https://b', RPC_ARB_SEPOLIA: 'https://a', RPC_ETH: 'https://m', STATE_DIRECTORY: '/s:/t' });
  assert.deepEqual(cfg.chains.map((c) => c.id), [84532, 421614]);
  assert.deepEqual(cfg.ignoredMainnetRpcs, ['RPC_ETH']);
  assert.equal(cfg.stateDir, '/s');
  assert.throws(() => readConfig({ SANCTIONS_DELISTER_PRIVATE_KEY: '0x1', RPC_BASE_SEPOLIA: 'x', STATE_DIRECTORY: '/s' }), /32-byte hex key/);
  const plan = planChains(cfg.chains, { 84532: { sanctionsList: LIST, sanctionsDelistingTimelock: TL }, 421614: { sanctionsList: LIST } });
  assert.equal(plan[0].timelock, TL);
  assert.match(plan[1].skipped, /no SanctionsDelistingTimelock is recorded for chain 421614/);
});

test('env template: exactly the settings the runner reads, as the file already on the VM names them', () => {
  const template = readFileSync(join(HERE, '..', '..', '..', 'ops', 'sanctions', 'sanctions-delister.env.example'), 'utf8');
  const names = [...template.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]).sort();
  assert.deepEqual(names, ['SANCTIONS_DELISTER_PRIVATE_KEY', ...SERVICE_CHAINS.map((c) => c.rpcEnv), 'TG_OPS_BOT_TOKEN', 'TG_OPS_CHAT_ID'].sort());
});
