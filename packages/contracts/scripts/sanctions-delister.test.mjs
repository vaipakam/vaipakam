// sanctions-delister.test.mjs — #2443: the unattended delister run, with every
// chain and network effect replaced by a fake, against the committed fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, getAddress } from 'viem';
import { parseSdnAdvancedFile } from './ofac-sanctions-diff.mjs';
import { parseSdnPlainFile } from './ofac-sdn-plain.mjs';
import { SERVICE_CHAINS } from './sanctions-service.mjs';
import {
  ALERT_REPEAT_MS,
  RE_EVALUATE_MS,
  STAND_IN_NAME,
  alertDigest,
  clearanceOracleName,
  createClientLookup,
  describeAction,
  evaluatePublication,
  fingerprint,
  identifyOracle,
  listRoleKeyVet,
  listRoleRefusal,
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
const ORACLE = getAddress('0x00000000000000000000000000000000000000c3');
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
// The advanced fixture carries three malformed values on purpose, for the
// parser's own tests; any one of them stops every unattended delisting (see
// "a value the files cannot read"), so the publication most tests use is the
// fixture without them.
const PUBLICATION = {
  advanced: { parsed: { ...adv.parsed, malformed: [] }, sourceHash: adv.sourceHash, source: { sha256: adv.sourceHash, publicationId: adv.parsed.publicationId } },
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
    roles: { proposer: true, timelockOwner: false },
    route: 2,
    reservedDelistings: 0,
    proposalCount: 0,
    now: 1_000_000n,
    balance: 10n ** 18n,
    relayPath: { ok: true },
    clearanceAttestor: OTHER,
    clearanceSourceChainId: 97n,
    // The only clearance oracle a test network carries.
    clearanceOracle: { address: ORACLE, identity: 'stand-in', updatedAt: 999_000n },
    oracleMaxAge: 7 * 86_400,
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

test('proposes only what both files support, minus vetoed, proposed and oracle-flagged addresses', () => {
  const snap = snapOf({ reservedDelistings: 1 });
  const ev = evaluatePublication(snap, PUBLICATION);
  assert.equal(ev.status, 'ready');
  assert.deepEqual(ev.stillMentioned, [FALSE_ONLY]);
  const plan = planChain(snap, KEY, ev, facts({ [D1]: {}, [D3]: { vetoed: true }, [D4]: { flagged: true }, [D5]: { proposalOf: 7n } }));
  assert.deepEqual(plan.actions, [{ kind: 'propose', accounts: [D1], sourceHash: adv.sourceHash, publicationDate: 20260307 }]);
  assert.ok(plan.notes.some((n) => n.includes(`${D3} is vetoed by the Safe`)));
  assert.ok(plan.review.some((r) => r.includes(`${D4}: OFAC delisted it but ${STAND_IN_NAME} flags it`)));
  assert.ok(plan.review.some((r) => r.includes(`${FALSE_ONLY}: the advanced file delists it but SDN.XML still mentions it`)));
});

test('an unreadable clearance oracle holds the address back; the proposal stays within what is outstanding, in batches', () => {
  const snap = snapOf({ reservedDelistings: 4 });
  const ev = evaluatePublication(snap, PUBLICATION);
  const plan = planChain(snap, KEY, ev, facts({ [D1]: {}, [D3]: { flagged: null }, [D4]: {}, [D5]: {} }));
  // One free slot: the first candidate only.
  assert.deepEqual(plan.actions.map((a) => a.accounts), [[D1]]);
  assert.ok(plan.notes.some((n) => n.includes(`${D3}: ${STAND_IN_NAME} could not be read`)));
  const none = planChain(snapOf({ reservedDelistings: 5 }), KEY, ev, facts({ [D1]: {} }));
  assert.deepEqual(none.actions, []);
});

test('publication work is refused or deferred, never guessed at', () => {
  // OFAC serves a newer file than the list records: wait for the adder,
  // which resolves it by changing the list.
  const behind = evaluatePublication(snapOf({ list: { sourceHash: OLD_HASH, publicationDate: 20260301 } }), PUBLICATION);
  assert.equal(behind.status, 'mismatch');
  assert.match(behind.reason, /a newer publication; proposals wait for the adder to record it/);
  assert.equal(behind.transient, undefined);
  // An OLDER copy than the list's (a stale download): read again next run.
  const stale = evaluatePublication(snapOf({ list: { sourceHash: OLD_HASH, publicationDate: 20260310 } }), PUBLICATION);
  assert.equal(stale.status, 'refused');
  assert.equal(stale.transient, true);
  // Another file under the list's own date: a same-day reissue the adder
  // will not apply by itself, so a person reconciles it.
  const reissue = evaluatePublication(snapOf({ list: { sourceHash: OLD_HASH } }), PUBLICATION);
  assert.equal(reissue.status, 'refused');
  assert.equal(reissue.transient, undefined);
  assert.match(reissue.reason, /same-day reissue.*a person must reconcile it/);
  const reissuePlan = planChain(snapOf({ list: { sourceHash: OLD_HASH }, proposals: [proposal({ sourceHash: OLD_HASH, ready: true, reason: null })], reservedDelistings: 1 }), KEY, reissue, new Map());
  assert.deepEqual(reissuePlan.actions, []);
  assert.ok(reissuePlan.review.some((r) => r.includes('publication work refused') && r.includes('same-day reissue')));
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
    // Under the list's publication, but naming an address OFAC still lists,
    // or one SDN.XML still mentions.
    proposal({ id: 18n, proposer: OTHER, ready: true, reason: null, accounts: [D1, A1] }),
    proposal({ id: 19n, reason: 'ClearanceNotRequested', proposer: OTHER, accounts: [FALSE_ONLY] }),
    proposal({ id: 20n, ready: true, reason: null, accounts: [FALSE_ONLY] }),
  ];
  const plan = planChain(snapOf({ proposals, reservedDelistings: 5 }), KEY, ev, new Map());
  const byId = Object.fromEntries(plan.actions.map((a) => [a.id?.toString(), a]));
  assert.equal(byId['1'].kind, 'discard');
  assert.equal(byId['2'].kind, 'withdraw');
  assert.deepEqual(byId['3'], { kind: 'reconfirm', id: 3n, sourceHash: adv.sourceHash, publicationDate: 20260307 });
  assert.equal(byId['4'].kind, 'withdraw');
  assert.match(byId['4'].why, /no longer supports delisting 0x1CAb/);
  assert.deepEqual(byId['5'], { kind: 'execute', id: 5n });
  assert.deepEqual(byId['6'], { kind: 'request', id: 6n, oracle: STAND_IN_NAME });
  assert.deepEqual(byId['7'], { kind: 'request', id: 7n, oracle: STAND_IN_NAME }, "another proposer's proposal moves on when OFAC supports every address in it");
  assert.deepEqual(byId['8'], { kind: 'reply', id: 8n, oracle: STAND_IN_NAME, sourceChainId: 421614, attestor: OTHER, messageId: `0x${'e'.repeat(64)}`, payload: '0x1234' });
  assert.equal(byId['9'], undefined);
  assert.equal(byId['10'].kind, 'withdraw');
  assert.equal(byId['11'], undefined, "another proposer's proposal is never withdrawn");
  assert.equal(byId['12'].kind, 'withdraw');
  assert.equal(byId['13'], undefined);
  assert.equal(byId['14'], undefined);
  assert.ok(plan.review.some((r) => r.includes(`proposal 12: ${STAND_IN_NAME} flags an address`)));
  assert.ok(plan.review.some((r) => r.includes('proposal 4 was withdrawn')));
  assert.ok(plan.notes.some((n) => n.includes("proposal 14 waits for the list's outstanding additions")));
  assert.ok(!plan.review.some((r) => r.includes('proposal 14')), 'the adder applies additions on its own; no person is needed');
  // Another proposer's proposal naming a delisted address is never executed
  // (execute would revert), and a person hears it holds a share back.
  assert.equal(byId['15'], undefined);
  assert.ok(plan.review.some((r) => r.includes('proposal 15 (another proposer') && r.includes('holds back 1 of the outstanding delistings')));
  // A stale clearance stops a proposal until a new request: a person hears it.
  assert.equal(byId['16'], undefined);
  assert.ok(plan.review.some((r) => r.includes(`proposal 16 is matured but not executable: its clearance answer carries no readable update time for ${STAND_IN_NAME}, older than the timelock accepts; ${STAND_IN_NAME} has updated since`)));
  // Same file, another date: the publication changed as far as execute is concerned.
  assert.equal(byId['17'].kind, 'reconfirm');
  // A proposal naming an address the publication does not support delisting
  // is never moved on, whoever made it: another proposer's goes to the Safe
  // to veto, this key's own is withdrawn.
  assert.equal(byId['18'], undefined);
  assert.ok(plan.review.some((r) => r.includes(`proposal 18 (another proposer's) names ${A1}`) && r.includes('the Safe should veto it')));
  assert.equal(byId['19'], undefined);
  assert.ok(plan.review.some((r) => r.includes(`proposal 19 (another proposer's) names ${FALSE_ONLY}`)));
  assert.equal(byId['20'].kind, 'withdraw');
  assert.match(byId['20'].why, /does not support delisting 0x1111/);
});

test('nothing moves a proposal on without a conclusive reading of OFAC\'s files', () => {
  const owed = { status: 'owed', messageId: `0x${'e'.repeat(64)}`, payload: '0x1234', sourceChainId: 421614, attestor: OTHER };
  const proposals = (o = {}) => [
    proposal({ id: 1n, ready: true, reason: null, ...o }),
    proposal({ id: 2n, reason: 'ClearanceExpired', ...o }),
    proposal({ id: 3n, reason: 'ClearanceNotAnswered', relay: owed, proposer: OTHER, ...o }),
  ];
  const older = { sourceHash: OLD_HASH, publicationDate: 20260301 };
  const torn = { ...PUBLICATION, plain: { ...PUBLICATION.plain, parsed: { ...plain.parsed, publicationDate: 20260308 } } };
  for (const [label, snap, ev] of [
    ['a newer publication', snapOf({ proposals: proposals(older), reservedDelistings: 3, list: older }), evaluatePublication(snapOf({ list: older }), PUBLICATION)],
    ['a failed download', snapOf({ proposals: proposals(), reservedDelistings: 3 }), evaluatePublication(snapOf(), { error: 'the OFAC files could not be loaded: timeout' })],
    ['files from two publications', snapOf({ proposals: proposals(), reservedDelistings: 3 }), evaluatePublication(snapOf(), torn)],
    ['a count the files do not support', snapOf({ proposals: proposals(), reservedDelistings: 3, list: { pendingDelistings: 4 } }), evaluatePublication(snapOf({ list: { pendingDelistings: 4 } }), PUBLICATION)],
    ['files not read', snapOf({ proposals: proposals(), reservedDelistings: 3 }), { status: 'not-loaded', reason: 'x' }],
    ['a list mid-update', snapOf({ proposals: proposals(), reservedDelistings: 3, list: { latestVersion: 6n } }), evaluatePublication(snapOf(), PUBLICATION)],
  ]) {
    const plan = planChain(snap, KEY, ev, new Map());
    assert.deepEqual(plan.actions, [], label);
    for (const step of ['proposal 1: executing waits', 'proposal 2: requesting the clearance waits', `proposal 3: relaying the answer from ${STAND_IN_NAME} waits`]) {
      assert.ok(plan.notes.some((n) => n.startsWith(step)), `${label}: ${step}`);
    }
  }
});

test('a stale proposal of its own waits when the files cannot be read', () => {
  const plan = planChain(snapOf({ proposals: [proposal({ sourceHash: OLD_HASH })] }), KEY, { status: 'not-loaded', reason: 'x' }, new Map());
  assert.deepEqual(plan.actions, []);
  assert.match(plan.notes[0], /older publication; reconfirming waits: x/);
});

test('refuses a key that is not the proposer alone, and a timelock serving another list', async () => {
  const chain = (snap) => ({ slug: 'base-sepolia', name: 'Base Sepolia', id: 84532, timelock: TL, list: LIST, effects: { readSnapshot: async () => snap, readFacts: async () => new Map(), send: async () => assert.fail('nothing may be sent') } });
  const load = async () => assert.fail('nothing may be downloaded');
  for (const [snap, re] of [
    [snapOf({ roles: { proposer: false } }), /not a proposer of this timelock/],
    [snapOf({ roles: { proposer: true, timelockOwner: true } }), /also the timelock's owner/],
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
  // `quiet`: every candidate is vetoed, so the run reads the files and sends
  // nothing.
  const chain = (snap, { quiet = false } = {}) => ({
    slug: 'base-sepolia',
    name: 'Base Sepolia',
    id: 84532,
    timelock: TL,
    list: LIST,
    effects: {
      readSnapshot: async () => snap,
      readFacts: async (as) => facts(Object.fromEntries(as.map((a) => [a, quiet ? { vetoed: true } : a === D4 ? { flagged: true } : a === D3 ? { vetoed: true } : a === D5 ? { proposalOf: 1n } : {}]))),
      send: async (a, { onSubmitted }) => (sent.push(a), onSubmitted('0x01'), { hash: `0x${String(sent.length).padStart(64, '0')}`, blockNumber: 9n }),
    },
  });
  const loadPublication = async () => (loads++, PUBLICATION);
  const t0 = 10 * RE_EVALUATE_MS;
  // A run that sent something is never cached, even when every send was
  // included: included is not final, and a reorganised-out proposal would
  // bring back exactly the state it was built on.
  const proposing = await runDelister({ chains: [chain(snapOf())], key: KEY, loadPublication, nowMs: t0 });
  assert.equal(loads, 1);
  assert.equal(proposing.report.status, 'ok');
  assert.deepEqual(sent.map((a) => a.kind), ['propose']);
  assert.equal(proposing.cache[84532], undefined);
  await runDelister({ chains: [chain(snapOf())], key: KEY, loadPublication, cache: proposing.cache, nowMs: t0 + 3_600_000 });
  assert.equal(loads, 2, 'the same state an hour later is read again');
  // A run that read the files and sent nothing is cached.
  loads = 0;
  const first = await runDelister({ chains: [chain(snapOf(), { quiet: true })], key: KEY, loadPublication, nowMs: t0 });
  assert.equal(loads, 1);
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
  // An entry stamped after "now" (the host clock went backwards) is stale.
  await runDelister({ chains: [chain(snapOf())], key: KEY, loadPublication, cache: first.cache, nowMs: t0 - 60_000 });
  assert.equal(loads, 4);
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
  const refused = Object.assign(new Error('the node refused it'), { sendOutcome: 'refused' });
  const chain = { slug: 'b', name: 'B', id: 84532, timelock: TL, list: LIST, effects: { readSnapshot: async () => snap, readFacts: async () => new Map(), send: async (a, { onSubmitted }) => (onSubmitted('0xdef'), Promise.reject(refused)) } };
  const { report } = await runDelister({ chains: [chain], key: KEY, loadPublication: async () => PUBLICATION, nowMs: 1 });
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
  // The proposals it could not check are work an error put off: the chain
  // and the run say so, and the unit fails.
  assert.equal(report.chains.b.status, 'partial');
  assert.equal(report.status, 'failed');
  assert.ok(report.chains.b.deferred.some((d) => d.includes('attestor chain RPC down')));
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
  // The mandatory check did not happen: the chain that needed it is not done,
  // and the run fails, so the unit's own status shows it.
  assert.equal(failedLoad.report.chains.b.status, 'partial');
  assert.equal(failedLoad.report.status, 'failed');
  assert.match(failedLoad.report.chains.b.deferred[0], /needed OFAC's files and has no conclusive reading of them: the OFAC files could not be loaded: timeout/);
  assert.match(summarize(failedLoad.report), /NOT DONE, retried next run: this chain needed OFAC's files/);
  await runDelister({ chains: [chainWith(snapOf())], key: KEY, loadPublication: async () => (loads++, PUBLICATION), cache: failedLoad.cache, nowMs: 2 });
  assert.equal(loads, 2);
  // Two files either side of a new publication: not cached.
  const torn = { ...PUBLICATION, plain: { ...PUBLICATION.plain, parsed: { ...plain.parsed, publicationDate: 20260308 } } };
  const tornRun = await runDelister({ chains: [chainWith(snapOf())], key: KEY, loadPublication: async () => torn, nowMs: 3 });
  assert.equal(tornRun.cache[84532], undefined);
  // Loaded, but no conclusive reading: not done either.
  assert.equal(tornRun.report.chains.b.status, 'partial');
  assert.equal(tornRun.report.status, 'failed');
  // A reconfirm that did not land: not cached.
  const stale = snapOf({ reservedDelistings: 5, proposals: [proposal({ sourceHash: OLD_HASH })] });
  const failedReconfirm = await runDelister({ chains: [chainWith(stale, async () => Promise.reject(new Error('reverted')))], key: KEY, loadPublication: async () => PUBLICATION, nowMs: 4 });
  assert.equal(failedReconfirm.cache[84532], undefined);
  // A newer publication than the list's is cached: only a change to the
  // list resolves it. The next run, unchanged, downloads nothing and still
  // moves nothing on.
  const behind = snapOf({ reservedDelistings: 1, proposals: [proposal({ id: 1n, sourceHash: OLD_HASH, publicationDate: 20260301, ready: true, reason: null })], list: { sourceHash: OLD_HASH, publicationDate: 20260301 } });
  const sends = [];
  const first = await runDelister({ chains: [chainWith(behind, async (a) => (sends.push(a.kind), { hash: '0x02', blockNumber: 3n }))], key: KEY, loadPublication: async () => PUBLICATION, nowMs: 5 });
  assert.equal(first.cache[84532].status, 'mismatch');
  // Waiting for the adder is by design, not a failure.
  assert.equal(first.report.status, 'ok');
  assert.deepEqual(first.report.chains.b.deferred, []);
  const second = await runDelister({ chains: [chainWith(behind, async (a) => (sends.push(a.kind), { hash: '0x02', blockNumber: 3n }))], key: KEY, loadPublication: async () => assert.fail('cached'), cache: first.cache, nowMs: 6 });
  assert.deepEqual(sends, []);
  assert.ok(second.report.chains.b.notes.some((n) => n.startsWith("proposal 1: executing waits: nothing changed since OFAC's files were last read")));
});

test('a proposal reaching a new stage is checked against OFAC again, cache or not', async () => {
  let loads = 0;
  const sends = [];
  const chainWith = (snap) => ({ slug: 'b', name: 'B', id: 84532, timelock: TL, list: LIST, effects: { readSnapshot: async () => snap, readFacts: async () => new Map(), send: async (a) => (sends.push(a.kind), { hash: '0x02', blockNumber: 3n, logs: [] }) } });
  const loadPublication = async () => (loads++, PUBLICATION);
  const run = (snap, cache, nowMs) => runDelister({ chains: [chainWith(snap)], key: KEY, loadPublication, cache, nowMs });
  const at = (o) => snapOf({ reservedDelistings: 5, proposalCount: 1, proposals: [proposal(o)] });
  // In its window: nothing to do, nothing read.
  const inWindow = await run(at({ eta: 2_000_000n }), {}, 1);
  assert.equal(loads, 0);
  // Out of the window, a request is due: read, then requested.
  const requested = await run(at({ reason: 'ClearanceNotRequested' }), inWindow.cache, 2);
  assert.equal(loads, 1);
  // Requested, the answer on its way: nothing to send, nothing read.
  const inFlight = await run(at({ reason: 'ClearanceNotAnswered', relay: { status: 'in-flight' } }), requested.cache, 3);
  assert.equal(loads, 1);
  // The answer is owed: read again before relaying it, though the cache is fresh.
  const replied = await run(at({ reason: 'ClearanceNotAnswered', relay: { status: 'owed', messageId: `0x${'e'.repeat(64)}`, payload: '0x12', sourceChainId: 421614, attestor: OTHER } }), inFlight.cache, 4);
  assert.equal(loads, 2);
  // Ready: read again before executing.
  await run(at({ ready: true, reason: null }), replied.cache, 5);
  assert.equal(loads, 3);
  assert.deepEqual(sends, ['request', 'reply', 'execute']);
});

test('every step that moves a proposal on is checked against OFAC first', () => {
  const at = (o) => snapOf({ reservedDelistings: 5, proposals: [proposal(o)] });
  assert.equal(wantsPublication(at({ ready: true, reason: null }), KEY, undefined, 0), true);
  assert.equal(wantsPublication(at({ reason: 'ClearanceNotRequested', proposer: OTHER }), KEY, undefined, 0), true);
  assert.equal(wantsPublication(at({ reason: 'ClearanceExpired' }), KEY, undefined, 0), true);
  assert.equal(wantsPublication(at({ reason: 'ClearanceNotAnswered', relay: { status: 'owed' } }), KEY, undefined, 0), true);
  // Nothing to send: no download.
  assert.equal(wantsPublication(at({ reason: 'ClearanceNotAnswered', relay: { status: 'in-flight' } }), KEY, undefined, 0), false);
  assert.equal(wantsPublication(at({ eta: 2_000_000n }), KEY, undefined, 0), false);
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
  // It says which oracle that attestor reads, as the timelock chain found it.
  assert.deepEqual(report.chains.a.attestors, [{ attestor: OTHER, for: ['Base Sepolia'], clearanceOracle: { address: ORACLE, identity: 'stand-in', name: STAND_IN_NAME, updatedAt: 999_000 } }]);

  const standIn = { ...snap, clearanceOracle: { address: ORACLE, identity: 'stand-in', updatedAt: 999_000n } };
  const onStandIn = await runDelister({
    chains: [
      { slug: 'b', name: 'Base Sepolia', id: 84532, timelock: TL, list: LIST, effects: { readSnapshot: async () => standIn, readFacts: async () => new Map(), send: async () => assert.fail('no send') } },
      { slug: 'a', name: 'Arbitrum Sepolia', id: 421614, skipped: 'no SanctionsDelistingTimelock is recorded' },
    ],
    key: KEY,
    loadPublication: async () => assert.fail('no download'),
    nowMs: 1,
  });
  assert.match(summarize(onStandIn.report), new RegExp(`Arbitrum Sepolia: skipped: [^\\n]*\\n  attestor ${OTHER} \\(for Base Sepolia\\): clearance read from ${STAND_IN_NAME} at ${ORACLE}: NOT RedStone`));
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
  assert.equal(cfg.privateKey, PK);
  // The key without its 0x, as keeper.env may hold it, signs as the same key.
  assert.equal(readConfig({ SANCTIONS_DELISTER_PRIVATE_KEY: ` ${PK.slice(2)} `, RPC_BASE_SEPOLIA: 'x', STATE_DIRECTORY: '/s' }).privateKey, PK);
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

test('a cross-chain clearance is requested only when its answer can come back', async () => {
  const noWay = { ok: false, detail: 'no RPC is configured for chain 421614, where its attestor runs' };
  for (const reason of ['ClearanceNotRequested', 'ClearanceExpired']) {
    const p = proposal({ id: 1n, reason });
    // Every outstanding delisting is reserved, so nothing new could be proposed.
    const snap = snapOf({ reservedDelistings: 5, relayPath: noWay, proposals: [p] });
    const plan = planChain(snap, KEY, evaluatePublication(snap, PUBLICATION), facts({}));
    assert.deepEqual(plan.actions, [], `${reason}: a paid request with no way back is never sent`);
    assert.ok(plan.review.some((r) => r.includes('could not be relayed back') && r.includes('no RPC is configured for chain 421614')), reason);
    // Nothing to advance, so it costs no download either.
    assert.equal(wantsPublication(snap, KEY, undefined, 1), false, reason);
    // Once the way back is proven, the stage changes, so a cached reading
    // never stands in for a fresh one.
    const fixed = snapOf({ reservedDelistings: 5, proposals: [p] });
    assert.equal(wantsPublication(fixed, KEY, undefined, 1), true, `${reason}: a request is checked against OFAC first`);
    assert.notEqual(fingerprint(snap), fingerprint(fixed));
    assert.deepEqual(planChain(fixed, KEY, evaluatePublication(fixed, PUBLICATION), facts({})).actions.map((a) => a.kind), ['request']);
  }
  // A local route needs no relay: nothing to prove.
  const local = snapOf({ route: 1, relayPath: null, reservedDelistings: 1, proposals: [proposal({ id: 1n, ready: true, reason: null })] });
  assert.deepEqual(planChain(local, KEY, evaluatePublication(local, PUBLICATION), facts({})).actions.map((a) => a.kind), ['execute']);
});

test('a revoked remover closes every step toward a delisting: no download, request, relay or execute', () => {
  const owed = { status: 'owed', messageId: '0x01', payload: '0x02', sourceChainId: 421614, attestor: OTHER, balance: 10n ** 18n };
  const closed = snapOf({
    timelockIsRemover: false,
    reservedDelistings: 3,
    proposals: [
      proposal({ id: 1n, ready: true, reason: null }),
      proposal({ id: 2n, accounts: [D3], reason: 'ClearanceNotRequested' }),
      proposal({ id: 3n, accounts: [D4], proposer: OTHER, reason: 'ClearanceNotAnswered', relay: owed }),
    ],
  });
  assert.equal(wantsPublication(closed, KEY, undefined, 0), false, 'nothing can move, so nothing is downloaded');
  // Even handed a conclusive reading, nothing advances.
  const plan = planChain(closed, KEY, evaluatePublication(closed, PUBLICATION), facts({}));
  assert.deepEqual(plan.actions, []);
  for (const id of [1, 2, 3]) assert.ok(plan.notes.some((n) => n.startsWith(`proposal ${id} is not moved on: the timelock is not a remover`)), `proposal ${id}`);
  // Restoring the role changes the fingerprint, so the next step waits for a
  // fresh reading of the files.
  assert.notEqual(fingerprint(closed), fingerprint({ ...closed, timelockIsRemover: true }));
});

test('a value the files cannot read stops every unattended delisting, and a chain that needed the files fails the run', async () => {
  // The real fixture: its advanced file carries three malformed values.
  const unread = { ...PUBLICATION, advanced: { ...PUBLICATION.advanced, parsed: adv.parsed } };
  const ev = evaluatePublication(snapOf(), unread);
  assert.equal(ev.status, 'refused');
  assert.equal(ev.transient, undefined, 'it needs a person, so it is not retried as if it might clear');
  assert.match(ev.reason, /refusing an unattended delisting: .*"0x123" \(ETH, advanced file\)/);
  const ready = snapOf({ reservedDelistings: 1, proposals: [proposal({ ready: true, reason: null })] });
  assert.deepEqual(planChain(ready, KEY, evaluatePublication(ready, unread), facts({})).actions, []);
  const { report } = await runDelister({
    chains: [{ slug: 'b', name: 'Base Sepolia', id: 84532, timelock: TL, list: LIST, effects: { readSnapshot: async () => snapOf(), readFacts: async () => assert.fail('nothing is proposed'), send: async () => assert.fail('nothing is sent') } }],
    key: KEY,
    loadPublication: async () => unread,
    nowMs: 1,
  });
  assert.equal(report.status, 'failed');
  assert.match(report.chains.b.deferred[0], /no conclusive reading of them: refusing an unattended delisting/);
});

test("the key's roles on a list are checked on every chain it is used on, before any use", async () => {
  assert.equal(listRoleRefusal({ adder: false, remover: false, owner: false }), null);
  assert.match(listRoleRefusal({ adder: true, remover: false, owner: true }), /also the list's adder and the list's owner on this chain/);
  const listClient = (roles, fail = false) => ({
    readContract: async ({ functionName, args }) => {
      if (fail) throw new Error('rpc down');
      if (functionName !== 'owner') assert.deepEqual(args, [KEY]);
      return { isAdder: roles.adder ?? false, isRemover: roles.remover ?? false, owner: roles.owner ?? OTHER }[functionName];
    },
  });
  const vet = listRoleKeyVet({ listByChain: new Map([[84532, LIST]]), key: KEY, abi: [] });
  assert.equal(await vet(84532, { client: listClient({}) }), null);
  assert.match(await vet(84532, { client: listClient({ remover: true }) }), /also the list's remover/);
  assert.match(await vet(84532, { client: listClient({ owner: KEY }) }), /also the list's owner/);
  assert.match(await vet(84532, { client: listClient({}, true) }), /roles on list .* could not be read, so the key is not used on this chain: rpc down/);
  assert.equal(await vet(421614, { client: listClient({}, true) }), null, 'no list recorded there: nothing to check');

  // The lookup is the one way to reach a chain: a refusing vet fails every
  // use of it, with the same reason, and is asked once.
  let vetted = 0;
  const lookup = createClientLookup(new Map([[421614, { client: { getChainId: async () => 421614 } }]]), async () => (vetted++, "the signing key is also the list's adder on this chain"));
  await assert.rejects(lookup(421614), /also the list's adder/);
  await assert.rejects(lookup(421614n), /also the list's adder/);
  assert.equal(vetted, 1);

  // A chain with no timelock keeps its list, and is refused when the key
  // holds a role there — naming the attestor it hosts.
  const plan = planChains([{ id: 421614 }], { 421614: { sanctionsList: LIST } });
  assert.equal(plan[0].list, LIST);
  assert.ok(plan[0].skipped);
  const snap = snapOf({ route: 2, clearanceSourceChainId: 421614n, reservedDelistings: 5 });
  const run = (vetKey) =>
    runDelister({
      chains: [
        { slug: 'b', name: 'Base Sepolia', id: 84532, timelock: TL, list: LIST, effects: { readSnapshot: async () => snap, readFacts: async () => new Map(), send: async () => assert.fail('no send') } },
        { slug: 'a', name: 'Arbitrum Sepolia', id: 421614, list: LIST, skipped: 'no SanctionsDelistingTimelock is recorded', effects: { vetKey } },
      ],
      key: KEY,
      loadPublication: async () => assert.fail('no download'),
      nowMs: 1,
    });
  const refused = (await run(() => lookup(421614))).report;
  assert.equal(refused.status, 'failed');
  assert.equal(refused.chains.a.status, 'refused');
  assert.match(refused.chains.a.error, /also the list's adder on this chain; it hosts the clearance attestor for Base Sepolia, and no answer is relayed from here until this is fixed/);
  const fine = (await run(async () => {})).report;
  assert.equal(fine.chains.a.status, 'skipped');
  assert.equal(fine.status, 'ok');
});

test('with no timelock on any chain the run is refused, and the key is still checked', async () => {
  let checked = 0;
  const { report } = await runDelister({
    chains: [{ slug: 'a', name: 'Arbitrum Sepolia', id: 421614, list: LIST, skipped: 'no SanctionsDelistingTimelock is recorded', effects: { vetKey: async () => void checked++ } }],
    key: KEY,
    loadPublication: async () => assert.fail('no download'),
  });
  assert.equal(checked, 1);
  assert.equal(report.status, 'refused');
  assert.match(summarize(report), /^REFUSED, nothing sent: no configured chain has a SanctionsDelistingTimelock recorded in this release\.\nArbitrum Sepolia: skipped: /);
  assert.notEqual(alertDigest(report), null);
});

test('a chain that stops on an unexpected error still reports what it sent', async () => {
  // Fail the first read of one field AFTER the send, to stand for any bug
  // between a send and the chain's report.
  const snap = snapOf({ reservedDelistings: 1, proposals: [proposal({ ready: true, reason: null })] });
  let armed = false;
  Object.defineProperty(snap, 'reservedDelistings', {
    get() {
      if (armed) {
        armed = false;
        throw new Error('boom');
      }
      return 1;
    },
  });
  const { report } = await runDelister({
    chains: [{ slug: 'b', name: 'Base Sepolia', id: 84532, timelock: TL, list: LIST, effects: { readSnapshot: async () => snap, readFacts: async () => new Map(), send: async () => ((armed = true), { hash: '0xfeed', blockNumber: 7n }) } }],
    key: KEY,
    loadPublication: async () => PUBLICATION,
    nowMs: 1,
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.chains.b.status, 'partial');
  assert.deepEqual(report.chains.b.actions.map((e) => [e.kind, e.state, e.tx]), [['execute', 'included', '0xfeed']]);
  assert.match(report.chains.b.deferred[0], /stopped on an unexpected error after the sends listed: boom/);
  assert.match(summarize(report), /execute proposal 1: 0xfeed — included/);
});

test('the clearance oracle is named from what the run established: the stand-in, or nothing', () => {
  assert.equal(clearanceOracleName(snapOf()), STAND_IN_NAME);
  assert.equal(clearanceOracleName(snapOf({ clearanceOracle: { address: ORACLE, identity: 'redstone' } })), 'the clearance oracle', 'no identity names RedStone');
  assert.equal(clearanceOracleName(snapOf({ clearanceOracle: { address: ORACLE, identity: 'unknown', detail: 'rpc down' } })), 'the clearance oracle');
  assert.equal(clearanceOracleName(snapOf({ clearanceOracle: null })), 'the clearance oracle', 'an unread oracle is never called RedStone');

  // On the stand-in, every action, note and review line says so.
  const standIn = snapOf({
    clearanceOracle: { address: ORACLE, identity: 'stand-in', updatedAt: 999_000n },
    reservedDelistings: 4,
    proposals: [
      proposal({ id: 1n, reason: 'ClearanceNotRequested' }),
      proposal({ id: 2n, reason: 'ClearanceNotAnswered', relay: { status: 'owed', messageId: `0x${'e'.repeat(64)}`, payload: '0x1234', sourceChainId: 97, attestor: OTHER } }),
      proposal({ id: 3n, reason: 'ClearanceFlagged', proposer: OTHER }),
    ],
  });
  const plan = planChain(standIn, KEY, evaluatePublication(standIn, PUBLICATION), facts({ [D4]: { flagged: true } }));
  const byId = Object.fromEntries(plan.actions.filter((a) => a.id).map((a) => [a.id.toString(), a]));
  assert.equal(describeAction(byId['1']), `request the clearance from ${STAND_IN_NAME} for proposal 1`);
  assert.equal(describeAction(byId['2']), `relay the answer from ${STAND_IN_NAME} for proposal 2 from chain 97`);
  assert.ok(plan.notes.some((n) => n === `proposal 3 (another proposer's) cannot execute: ${STAND_IN_NAME} flags an address in it`));
  assert.ok(plan.review.some((r) => r.includes(`${D4}: OFAC delisted it but ${STAND_IN_NAME} flags it`)));
  const said = JSON.stringify([plan.notes, plan.review, plan.actions.map(describeAction)]).replaceAll(STAND_IN_NAME, '');
  assert.ok(!said.includes('RedStone'), 'RedStone is named only as what the stand-in stands in for');
});

test('a stale clearance names the remedy from what the oracle holds now, not from the old answer', () => {
  const DAY = 86_400n;
  const now = 1_000_000n;
  const stale = (oracle, o = {}) => {
    const snap = snapOf({ now, reservedDelistings: 1, clearanceOracle: { address: ORACLE, ...oracle }, proposals: [proposal({ reason: 'OracleStale', proposer: OTHER, clearance: { requestId: 3n, requestedAt: now - DAY, oracleUpdatedAt: now - 8n * DAY, state: 2 } })], ...o });
    const plan = planChain(snap, KEY, evaluatePublication(snap, PUBLICATION), new Map());
    return plan.review.find((r) => r.startsWith('proposal 1 is matured but not executable: '));
  };
  const answered = new Date(Number(now - 8n * DAY) * 1000).toISOString();
  // The answer is old, but the stand-in has been re-published since: only a new request is needed.
  const since = stale({ identity: 'stand-in', updatedAt: now - DAY });
  assert.match(since, new RegExp(`carries an update time of ${answered} for ${STAND_IN_NAME}, older than the timelock accepts; ${STAND_IN_NAME} has updated since`));
  assert.ok(!since.includes('markUpdated'), 'no refresh is prescribed for an oracle that is current');
  // The stand-in itself is stale: its admin re-publishes it, then the next request carries it.
  assert.match(stale({ identity: 'stand-in', updatedAt: now - 9n * DAY }), /also too old: this test network's admin re-publishes it with markUpdated, and the next clearance request, which this bot sends once this one expires, carries the new time/);
  // Its current time unknown: the refresh is conditional, never asserted.
  assert.match(stale({ identity: 'stand-in', updatedAt: null, detail: 'rpc down' }), /could not be read \(rpc down\), so whether it has updated since is not known; if it has not, this test network's admin re-publishes it/);
  // An unidentified oracle stale: nobody here refreshes it.
  assert.match(stale({ identity: 'unknown', updatedAt: now - 9n * DAY }), /the clearance oracle itself was last updated .*, also too old; nothing here can move it on until it updates/);
  // The local route judged the oracle itself at this block.
  assert.match(stale({ identity: 'stand-in', updatedAt: now - 9n * DAY }, { route: 1, relayPath: null }), new RegExp(`${STAND_IN_NAME} was last updated .*, older than the timelock accepts; this test network's admin re-publishes it with markUpdated`));
});

test('the report names the clearance oracle, and says the stand-in is not RedStone', async () => {
  const run = (snap) =>
    runDelister({
      chains: [{ slug: 'b', name: 'Base Sepolia', id: 84532, timelock: TL, list: LIST, effects: { readSnapshot: async () => snap, readFacts: async () => new Map(), send: async () => assert.fail('no send') } }],
      key: KEY,
      loadPublication: async () => assert.fail('no download'),
      nowMs: 1,
    });
  const quiet = { list: { pendingDelistings: 0, addresses: [A1, A2] } };
  const stand = (await run(snapOf({ ...quiet, clearanceOracle: { address: ORACLE, identity: 'stand-in', updatedAt: 999_000n } }))).report;
  assert.deepEqual(stand.chains.b.clearanceOracle, { address: ORACLE, identity: 'stand-in', name: STAND_IN_NAME, updatedAt: 999_000 });
  assert.match(summarize(stand), new RegExp(`clearance read from ${STAND_IN_NAME} at ${ORACLE}: NOT RedStone — it flags only what this test network's admin flags; last published 1970-01-12T13:30:00.000Z`));
  const unknown = (await run(snapOf({ ...quiet, clearanceOracle: { address: null, identity: 'unknown', updatedAt: null, detail: 'chain 97 cannot be used from here' } }))).report;
  assert.match(summarize(unknown), /clearance oracle not identified this run \(chain 97 cannot be used from here\)\./);
  const denies = (await run(snapOf({ ...quiet, clearanceOracle: { address: ORACLE, identity: 'unknown', updatedAt: 999_000n, detail: 'it answers false' } }))).report;
  assert.match(summarize(denies), new RegExp(`clearance oracle not identified this run at ${ORACLE} \\(it answers false\\); it reports a last update of 1970-01-12T13:30:00.000Z\\.`));
  assert.ok(!summarize(denies).includes('RedStone'), 'an unidentified oracle is never called RedStone');
  assert.equal((await run(snapOf({ ...quiet, route: 0, clearanceOracle: null }))).report.chains.b.clearanceOracle, null, 'no route, no oracle to name');
  const absurd = (await run(snapOf({ ...quiet, clearanceOracle: { address: ORACLE, identity: 'stand-in', updatedAt: 2n ** 64n - 1n } }))).report;
  assert.match(summarize(absurd), /last published an unreadable time \(18446744073709551615\)/, 'a time no date can hold never aborts the report');
});

test('an oracle is the stand-in only on its own answer, and never RedStone', async () => {
  const answering = (marker, updatedAt = 123n, blockTime = 1_000n) => ({
    readContract: async ({ functionName }) => {
      if (functionName === 'isTestnetStandIn') return marker instanceof Error ? Promise.reject(marker) : marker;
      assert.equal(functionName, 'getLastUpdateBlockTimestamp');
      return updatedAt instanceof Error ? Promise.reject(updatedAt) : updatedAt;
    },
    getBlock: async () => (blockTime instanceof Error ? Promise.reject(blockTime) : { timestamp: blockTime }),
  });
  assert.deepEqual(await identifyOracle(answering(true), ORACLE.toLowerCase(), []), { address: ORACLE, identity: 'stand-in', updatedAt: 123n });
  // An explicit false says only that it is not the stand-in.
  const no = await identifyOracle(answering(false), ORACLE, []);
  assert.equal(no.identity, 'unknown');
  assert.match(no.detail, /answers isTestnetStandIn\(\) with false, so it is not the stand-in; nothing this run read says what it is/);
  // A revert is not an identity: RedStone's oracle has no such function, but
  // an RPC fault can surface the same way, so nothing is inferred from it.
  const reverted = new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: [], functionName: 'isTestnetStandIn', data: '0x' }), { abi: [], functionName: 'isTestnetStandIn', contractAddress: ORACLE });
  const noFunction = await identifyOracle(answering(reverted, 0n), ORACLE, []);
  assert.equal(noFunction.identity, 'unknown');
  assert.equal(noFunction.updatedAt, null, 'a zero update time is unknown');
  assert.match(noFunction.detail, /whether it is the testnet stand-in returned no answer/);
  // An RPC that failed told us nothing about the contract.
  const down = await identifyOracle(answering(new Error('fetch failed'), new Error('fetch failed')), ORACLE, []);
  assert.equal(down.identity, 'unknown');
  assert.equal(down.updatedAt, null);
  assert.match(down.detail, /whether it is the testnet stand-in returned no answer: fetch failed/);
  for (const o of [no, noFunction, down]) assert.equal(clearanceOracleName({ clearanceOracle: o }), 'the clearance oracle');
  // The contracts' freshness rule: a time later than the chain's latest block
  // is unknown, as is one that cannot be judged because the block is unreadable.
  assert.equal((await identifyOracle(answering(true, 2n ** 64n - 1n), ORACLE, [])).updatedAt, null, 'a future time is unknown');
  assert.equal((await identifyOracle(answering(true, 1_000n), ORACLE, [])).updatedAt, 1_000n, 'the current block itself is fine');
  assert.equal((await identifyOracle(answering(true, 123n, new Error('rpc down')), ORACLE, [])).updatedAt, null);
});
