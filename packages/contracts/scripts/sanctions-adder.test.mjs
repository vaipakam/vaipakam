// sanctions-adder.test.mjs — #2443: the unattended adder run, with every
// chain and network effect replaced by a fake, against the committed fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, getAddress } from 'viem';
import { sanctionsListAbi, sourceHash } from './ofac-sanctions-diff.mjs';
import { awaitFinality, failureReport, needsAlert, planChains, readConfig, runAdder, summarize, summarizeFailure } from './sanctions-adder.mjs';
import { SERVICE_CHAINS, loadDeployments } from './sanctions-service.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, 'fixtures', 'sdn_advanced.sample.xml');
const HASH = sourceHash(readFileSync(FIXTURE_PATH));
const C = getAddress('0x00000000000000000000000000000000000000c0');
const ZERO_HASH = `0x${'0'.repeat(64)}`;
const KEY = `0x${'1'.repeat(64)}`;

/** {@link runChain}'s effects against a fake list in state `list`; `sent`
 *  collects what was sent. A sent call is applied to the list (its additions,
 *  publication and declared counts), so the next finalized read shows it,
 *  unless `list.applies` is false. */
function fakeChain(list, sent, overrides = {}) {
  return {
    readCurrent: async () => ({
      version: list.version,
      addresses: list.addresses,
      recordedDate: list.date ?? 0,
      recordedHash: list.hash ?? ZERO_HASH,
      recordedPendingAdditions: list.pendingAdditions ?? 0,
      recordedPendingDelistings: list.pendingDelistings ?? 0,
      blockNumber: list.finalizedBlock ?? 100n,
      blockHash: `0x${'c'.repeat(64)}`,
    }),
    latestVersion: async () => list.latest ?? list.version,
    roles: async () => ({ adder: list.isAdder ?? true, remover: list.isRemover ?? false, owner: list.isOwner ?? false }),
    send: async (call, { onSubmitted }) => {
      sent.push(call);
      const hash = `0x${String(sent.length).padStart(64, '0')}`;
      onSubmitted(hash);
      if (list.applies !== false) {
        const [expectedVersion, toAdd, , sourceHash_, publicationDate, additionsLeft, delistingsLeft] = decodeFunctionData({ abi: sanctionsListAbi(), data: call.calldata }).args;
        Object.assign(list, {
          version: expectedVersion + 1n,
          addresses: [...list.addresses, ...toAdd],
          hash: sourceHash_,
          date: publicationDate,
          pendingAdditions: additionsLeft,
          pendingDelistings: delistingsLeft,
          finalizedBlock: 300n,
        });
      }
      return { hash, blockNumber: 200n + BigInt(sent.length), blockHash: `0x${'b'.repeat(64)}` };
    },
    ...overrides,
  };
}

/** A run of one chain (`base-sepolia`) against a fake list; returns the run's
 *  report, that chain's section, what was sent, and the state directory. */
async function run(list, overrides = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'adder-'));
  const sent = [];
  const report = await runAdder({
    stateDir,
    fetchSource: async () => {
      const p = join(stateDir, 'download.xml');
      copyFileSync(FIXTURE_PATH, p);
      return p;
    },
    chains: [{ slug: 'base-sepolia', name: 'Base Sepolia', id: 84532, list: C, effects: fakeChain(list, sent, overrides) }],
  });
  return { report, chain: report.chains['base-sepolia'], sent, stateDir };
}

test('run: a new publication lists its additions and declares its delistings for the Safe', async () => {
  const { report, chain, sent, stateDir } = await run({ version: 7n, addresses: [C] });
  assert.equal(report.status, 'ok');
  assert.equal(chain.status, 'applied');
  assert.equal(sent.length, 1);
  assert.equal(chain.sent[0].state, 'included', 'a transaction is reported as sent and included; finality is the list\'s');
  assert.equal(chain.finalizedAt.number, '300');
  const args = decodeFunctionData({ abi: sanctionsListAbi(), data: sent[0].calldata }).args;
  assert.equal(args[0], 7n);
  assert.deepEqual(args[2], [], 'the adder never delists');
  assert.equal(args[6], 1, 'the delisting is declared outstanding');
  assert.deepEqual(chain.delistingsForRemover, [C]);
  assert.equal(chain.pendingDelistings, 1);
  assert.equal(report.source.sha256, HASH);
  // The publication is kept under its date and hash; the download name is gone.
  assert.deepEqual(readdirSync(stateDir), [`sdn-20260307-${HASH.slice(2, 14)}.xml`]);
  const text = summarize(report);
  assert.match(text, /Base Sepolia: listed 2 new/);
  assert.match(text, /1 delisting\(s\) await the remover/);
  assert.match(text, new RegExp(`--chain-id 84532 --list ${C}`));
  assert.ok(needsAlert(report));
});

test('run: up to date when the list holds the recorded publication', async () => {
  const fixtureAddrs = ['0x1CAb8177ACe78b1B6B1c393371F4f2dCAE40CbEB', getAddress('0x252a8bd2319d8a555b872990601221b3a2053bce')];
  const { report, chain, sent } = await run({ version: 8n, addresses: fixtureAddrs, date: 20260307, hash: HASH });
  assert.equal(chain.status, 'up-to-date');
  assert.equal(sent.length, 0);
  assert.equal(chain.pendingDelistings, 0);
  assert.match(summarize(report), /nothing sent/);
  assert.equal(needsAlert({ ...report, malformedValues: [] }), false, 'an up-to-date run with nothing to review is journal-only');
});

test('run: refuses a chain before sending when its list moved past the finalized block or the key is not the adder', async () => {
  let r = await run({ version: 7n, latest: 8n, addresses: [] });
  assert.equal(r.report.status, 'failed');
  assert.equal(r.chain.status, 'refused');
  assert.match(r.chain.error, /not yet final/);
  assert.equal(r.sent.length, 0);
  r = await run({ version: 7n, addresses: [], isAdder: false });
  assert.match(r.chain.error, /not an adder/);
  assert.equal(r.sent.length, 0);
  // A key that is ALSO the remover or the owner is refused: the stolen-key
  // bound (it can list, never delist or appoint) holds only for the adder alone.
  r = await run({ version: 7n, addresses: [C], isRemover: true });
  assert.match(r.chain.error, /also the list's remover/);
  assert.equal(r.sent.length, 0);
  r = await run({ version: 7n, addresses: [C], isOwner: true });
  assert.match(r.chain.error, /also the list's owner/);
  assert.equal(r.sent.length, 0);
});

test('run: a count of additions the publication does not supply is reported and alerted, never read as current', async () => {
  const fixtureAddrs = ['0x1CAb8177ACe78b1B6B1c393371F4f2dCAE40CbEB', getAddress('0x252a8bd2319d8a555b872990601221b3a2053bce')];
  const { report, chain, sent } = await run({ version: 8n, addresses: fixtureAddrs, date: 20260307, hash: HASH, pendingAdditions: 3 });
  assert.equal(chain.status, 'up-to-date');
  assert.equal(sent.length, 0);
  assert.equal(chain.pendingAdditions, 3);
  assert.ok(needsAlert({ ...report, malformedValues: [] }));
  const text = summarize(report);
  assert.match(text, /still declares 3 addition\(s\) outstanding/);
  assert.doesNotMatch(text, /already follows this publication/);
});

test('run: a tool refusal sends nothing', async () => {
  // An older publication than the one recorded.
  const { chain, sent } = await run({ version: 7n, addresses: [], date: 20270101, hash: `0x${'2'.repeat(64)}` });
  assert.equal(chain.status, 'refused');
  assert.match(chain.error, /not newer/);
  assert.equal(sent.length, 0);
});

test('run: one parse feeds every chain, and one chain failing never stops another', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'adder-'));
  let downloads = 0;
  const sentA = [];
  const sentB = [];
  const report = await runAdder({
    stateDir,
    fetchSource: async () => {
      downloads++;
      const p = join(stateDir, 'download.xml');
      copyFileSync(FIXTURE_PATH, p);
      return p;
    },
    redactError: (m) => m.replace('SECRET', '<redacted>'),
    chains: [
      { slug: 'base-sepolia', name: 'Base Sepolia', id: 84532, list: C, effects: fakeChain({ version: 7n, addresses: [C] }, sentA) },
      { slug: 'arb-sepolia', name: 'Arbitrum Sepolia', id: 421614, list: C, effects: fakeChain({ version: 3n, addresses: [] }, sentB, { readCurrent: async () => { throw new Error('RPC https://x/SECRET down'); } }) },
      { slug: 'sepolia', name: 'Sepolia', id: 11155111, skipped: 'no SanctionsList is recorded' },
    ],
  });
  assert.equal(downloads, 1, 'the publication is downloaded and parsed once');
  assert.equal(report.status, 'failed');
  assert.equal(report.chains['base-sepolia'].status, 'applied');
  assert.equal(sentA.length, 1);
  assert.equal(report.chains['arb-sepolia'].status, 'refused');
  assert.equal(report.chains['arb-sepolia'].error, 'RPC https://x/<redacted> down');
  assert.equal(report.chains.sepolia.status, 'skipped');
  const text = summarize(report);
  assert.match(text, /Arbitrum Sepolia: REFUSED, nothing sent/);
  assert.match(text, /What the list declares outstanding is UNKNOWN: it could not be read/);
  assert.match(text, /Sepolia: skipped: no SanctionsList/);
});

test('run: a stop part-way keeps what was already sent, and says what may still land', async () => {
  // Not final: the transaction is included, and the report says so.
  let { chain } = await run({ version: 7n, addresses: [C], applies: false }, { finality: fakeClock() });
  assert.equal(chain.status, 'stopped');
  assert.equal(chain.sent.length, 1);
  assert.equal(chain.sent[0].state, 'included');
  assert.equal(chain.finality.state, 'pending');
  assert.match(summarizeFailure(chain), /included, NOT confirmed final/);

  // Signed and recorded, then the broadcast's reply was lost: still reported by hash.
  ({ chain } = await run({ version: 7n, addresses: [C] }, {
    send: async (call, { onSubmitted }) => {
      onSubmitted(`0x${'d'.repeat(64)}`);
      throw new Error('socket hang up');
    },
  }));
  assert.equal(chain.status, 'stopped', 'an unknown broadcast is never reported as nothing sent');
  assert.equal(chain.sent[0].tx, `0x${'d'.repeat(64)}`);

  // Broadcast, then the receipt wait timed out: the hash is known, the outcome is not.
  ({ chain } = await run({ version: 7n, addresses: [C] }, {
    send: async (call, { onSubmitted }) => {
      onSubmitted(`0x${'e'.repeat(64)}`);
      throw new Error('receipt timeout');
    },
  }));
  assert.equal(chain.status, 'stopped');
  assert.equal(chain.sent[0].tx, `0x${'e'.repeat(64)}`);
  assert.match(summarizeFailure(chain), /may still land/);

  // Nothing broadcast: a plain refusal.
  // Signed but refused by the node, which does not know it: nothing was broadcast.
  ({ chain } = await run({ version: 7n, addresses: [C] }, {
    send: async (call, { onSubmitted }) => {
      onSubmitted(`0x${'f'.repeat(64)}`);
      throw Object.assign(new Error('the node refused it'), { sendOutcome: 'refused' });
    },
  }));
  assert.equal(chain.status, 'refused');
  assert.match(summarizeFailure(chain), /REFUSED, nothing sent: the node refused it/);
  // Included and reverted: broadcast, so the chain stopped, and said as such.
  ({ chain } = await run({ version: 7n, addresses: [C] }, {
    send: async (call, { onSubmitted }) => {
      onSubmitted(`0x${'d'.repeat(64)}`);
      throw Object.assign(new Error('applyUpdate reverted'), { sendOutcome: 'reverted' });
    },
  }));
  assert.equal(chain.status, 'stopped');
  assert.match(summarizeFailure(chain), /0xd+ — included but REVERTED/);
  const failed = failureReport('x', [{ tx: null, state: 'submitting' }]);
  assert.equal(failed.status, 'refused');
  assert.match(summarizeFailure(failed), /REFUSED, nothing sent/);
});

test('config: one file for every chain; every missing setting is named; mainnet RPCs and bad keys are refused', () => {
  assert.throws(() => readConfig({}), /SANCTIONS_ADDER_PRIVATE_KEY, an RPC for at least one chain \(RPC_BASE_SEPOLIA, RPC_ARB_SEPOLIA.*SANCTIONS_ADDER_STATE_DIR/);
  const env = { RPC_BASE_SEPOLIA: 'https://base', RPC_ARB_SEPOLIA: 'https://arb', SANCTIONS_ADDER_PRIVATE_KEY: KEY, STATE_DIRECTORY: '/var/lib/x' };
  const cfg = readConfig(env);
  assert.deepEqual(cfg.chains.map((c) => [c.id, c.rpc]), [[84532, 'https://base'], [421614, 'https://arb']]);
  assert.equal(cfg.stateDir, '/var/lib/x');
  assert.equal(cfg.maxRemove, 10);
  // A copy of keeper.env carries mainnet RPCs: they are ignored and named, never used.
  const withMainnet = readConfig({ ...env, RPC_BASE: 'https://mainnet', RPC_ETH: 'https://eth' });
  assert.deepEqual(withMainnet.chains.map((c) => c.id), [84532, 421614]);
  assert.deepEqual(withMainnet.ignoredMainnetRpcs, ['RPC_BASE', 'RPC_ETH']);
  assert.throws(() => readConfig({ RPC_BASE: 'https://mainnet', SANCTIONS_ADDER_PRIVATE_KEY: KEY, STATE_DIRECTORY: '/x' }), /an RPC for at least one chain/);
  // The key without its 0x, as keeper.env may hold it, signs as the same key.
  assert.equal(readConfig({ ...env, SANCTIONS_ADDER_PRIVATE_KEY: ` ${KEY.slice(2)} ` }).privateKey, KEY);
  assert.equal(cfg.privateKey, KEY);
  assert.throws(() => readConfig({ ...env, SANCTIONS_ADDER_PRIVATE_KEY: '0x12' }), /32-byte hex key/);
  assert.throws(() => readConfig({ ...env, SANCTIONS_ADDER_PRIVATE_KEY: `0x${'0'.repeat(64)}` }), /not a valid secp256k1 key/);
  assert.throws(() => readConfig({ ...env, SANCTIONS_ADDER_PRIVATE_KEY: `0x${'f'.repeat(64)}` }), /not a valid secp256k1 key/);
  assert.throws(() => readConfig({ ...env, SANCTIONS_ADDER_MAX_REMOVE: '-1' }), /non-negative decimal/);
});

test('chains: testnets only, and the list address comes from deployments.json, never configuration', () => {
  const mainnets = [1, 8453, 42161, 10, 56, 137, 1101];
  for (const c of SERVICE_CHAINS) assert.ok(!mainnets.includes(c.id), `${c.name} is a testnet`);
  const plan = planChains(readConfig({ RPC_BASE_SEPOLIA: 'https://b', RPC_SEPOLIA: 'https://s', SANCTIONS_ADDER_PRIVATE_KEY: KEY, STATE_DIRECTORY: '/x' }).chains, {
    84532: { sanctionsList: C.toLowerCase() },
    11155111: {},
  });
  assert.equal(plan[0].list, C);
  assert.equal(plan[0].skipped, undefined);
  assert.match(plan[1].skipped, /no SanctionsList is recorded for chain 11155111/);
  // The release's own artifact loads, keyed by chain id.
  assert.ok(loadDeployments()['84532']);
});

test('env template: names every setting the runner reads', () => {
  const template = readFileSync(join(HERE, '..', '..', '..', 'ops', 'sanctions', 'sanctions-adder.env.example'), 'utf8');
  const names = new Set([...template.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]));
  for (const k of ['SANCTIONS_ADDER_PRIVATE_KEY', ...SERVICE_CHAINS.map((c) => c.rpcEnv), 'SANCTIONS_ADDER_KEEP_FILES', 'SANCTIONS_ADDER_MAX_REMOVE', 'TG_OPS_BOT_TOKEN', 'TG_OPS_CHAT_ID']) {
    assert.ok(names.has(k), `the template names ${k}`);
  }
});


// ── Finality: one finalized reading holds exactly the planned update ──

/** A fake clock for awaitFinality: `wait` advances `now`. */
function fakeClock(timeoutMs = 60_000) {
  let t = 0;
  return { timeoutMs, pollMs: 15_000, now: () => t, wait: async (ms) => { t += ms; } };
}

const DATE = 20260307;
const A1 = getAddress('0x00000000000000000000000000000000000000a1');
const A2 = getAddress('0x00000000000000000000000000000000000000a2');
const OTHER_HASH = `0x${'9'.repeat(64)}`;
/** The update planned on a list at version 7 holding C: A1 (and A2) added, one delisting declared. */
const target = (version = 8n, addresses = [C, A1], { pendingAdditions = 0, pendingDelistings = 1 } = {}) => ({ version, addresses, sourceHash: HASH, publicationDate: DATE, pendingAdditions, pendingDelistings });
/** A finalized reading of the list. */
const snap = (version, addresses, { hash = HASH, date = DATE, block = 300n, pendingAdditions = 0, pendingDelistings = 1 } = {}) => ({
  version,
  addresses,
  recordedHash: hash,
  recordedDate: date,
  recordedPendingAdditions: pendingAdditions,
  recordedPendingDelistings: pendingDelistings,
  blockNumber: block,
  blockHash: `0x${'c'.repeat(64)}`,
});
/** A readCurrent answering `answers` in turn (the last repeats); an Error is thrown. */
function reads(answers) {
  let n = 0;
  const fn = async () => {
    const a = answers[Math.min(n++, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a;
  };
  fn.count = () => n;
  return fn;
}
const wait = (t, readCurrent, clock = fakeClock()) => awaitFinality({ target: t, readCurrent, ...clock });
/** The reading a run is planned on: version 7, holding C, no publication yet. */
const BASE = { version: 7n, addresses: [C], recordedDate: 0, recordedHash: ZERO_HASH, recordedPendingAdditions: 0, recordedPendingDelistings: 0, blockNumber: 100n, blockHash: `0x${'c'.repeat(64)}` };

test('finality: applied means one finalized reading holds exactly the planned update', async () => {
  const { chain, report } = await run({ version: 7n, addresses: [C] });
  assert.equal(chain.status, 'applied');
  assert.deepEqual(chain.finalizedAt, { number: '300', hash: `0x${'c'.repeat(64)}` });
  assert.deepEqual(chain.listAfter, { atVersion: '8', finalizedBlock: '300', count: 3 });
  assert.deepEqual(chain.outstandingAt, { finalizedBlock: '300', atVersion: '8', publication: 'this' });
  assert.match(summarize(report), /Final: the list at finalized block 300 holds exactly this update/);
});

test('finality: a failed read or a list not yet at the update\'s last version is "not yet", never a verdict', async () => {
  const readCurrent = reads([new Error('429 Too Many Requests'), snap(7n, [C]), snap(8n, [C, A1])]);
  const { list, finalizedBlock, version } = await wait(target(), readCurrent);
  assert.equal(list.version, 8n, 'it returns the reading that holds the update');
  assert.deepEqual(finalizedBlock, { number: '300', hash: `0x${'c'.repeat(64)}` });
  assert.equal(version, '8');
  assert.equal(readCurrent.count(), 3);
  // A two-call update is judged at its last version, by one reading.
  const two = await wait(target(9n, [C, A1, A2]), reads([snap(8n, [C, A1], { pendingAdditions: 1 }), snap(9n, [C, A1, A2])]));
  assert.equal(two.version, '9');
});

test('finality: at the last version, anything but exactly the planned update is conclusive', async () => {
  const cases = {
    'an extra address': snap(8n, [C, A1, A2]),
    'an address removed': snap(8n, [A1]),
    'a planned address missing': snap(8n, [C, A2]),
    'another publication': snap(8n, [C, A1], { hash: OTHER_HASH }),
    'another publication date': snap(8n, [C, A1], { date: 20260308 }),
    'other outstanding counts': snap(8n, [C, A1], { pendingDelistings: 0 }),
  };
  for (const [why, reading] of Object.entries(cases)) {
    const readCurrent = reads([reading]);
    const err = await wait(target(), readCurrent).catch((e) => e);
    assert.equal(err.finality?.state, 'displaced', why);
    assert.match(err.message, /at version 8, this update's last, but does not hold the planned update: other updates took the versions its transactions were built for, so it can never apply as planned/, why);
    assert.equal(err.list, reading, `${why}: the reading travels with the verdict`);
    assert.equal(readCurrent.count(), 1, `${why}: conclusive, no further reads`);
  }
});

test('finality: a list already past the update no longer records it, so its outcome is unknown', async () => {
  const readCurrent = reads([snap(9n, [C, A1], { pendingDelistings: 0 })]);
  const err = await wait(target(), readCurrent).catch((e) => e);
  assert.equal(err.finality.state, 'overtaken');
  assert.match(err.message, /already at version 9, past this update's last version 8, so it no longer records whether this update applied: its outcome is unknown/);
  assert.equal(readCurrent.count(), 1, 'no later reading can say more');
});

test('finality: the deadline reports what is unknown', async () => {
  let readCurrent = reads([snap(7n, [C]), snap(7n, [C]), snap(7n, [C]), snap(7n, [C]), new Error('503')]);
  let err = await wait(target(), readCurrent).catch((e) => e);
  assert.match(err.message, /no finalized reading of the list held this update within 1 minutes: the finalized list could not be read, so whether this update applied is unknown/);
  assert.deepEqual(err.finality, { state: 'unread' });
  assert.equal(err.list.version, 7n, 'the last reading still stands for what the list declares');
  readCurrent = reads([snap(7n, [C])]);
  err = await wait(target(), readCurrent).catch((e) => e);
  assert.match(err.message, /at version 7, not yet at this update's last version 8; its transactions may still land/);
  assert.equal(err.finality.state, 'pending');
  assert.equal(readCurrent.count(), 5, 'it read until the deadline');
});

test('finality: a stopped chain still reports what the last finalized reading declares outstanding', async () => {
  // Displaced: another update took version 8 (it lists C's neighbours, not this publication's additions).
  let { chain, report } = await run({ version: 7n, addresses: [C], applies: false }, {
    readCurrent: reads([BASE, snap(8n, [C], { pendingDelistings: 1 })]),
    finality: fakeClock(),
  });
  assert.equal(report.status, 'failed');
  assert.equal(chain.status, 'stopped');
  assert.equal(chain.finality.state, 'displaced');
  assert.equal(chain.pendingDelistings, 1);
  // The reading records this publication, but it is not the state this run's
  // delistings were computed from (another update made it), so they are not named.
  assert.deepEqual(chain.delistingsForRemover, []);
  assert.equal(chain.delistingsNamed, false);
  let text = summarizeFailure(chain, 'sdn.xml');
  assert.match(text, /can never apply as planned/);
  assert.match(text, /As last read \(finalized block 300, version 8\), the list declares 0 addition\(s\) and 1 delisting\(s\) outstanding, for this publication/);
  assert.match(text, /1 delisting\(s\) await the remover \(the Safe\) \(not named here: this run did not work them out for this state of the list; the command below does, from the list itself\)/);

  // Still at the reading the update was built on (its transaction never landed):
  // that is the state the delistings were computed from, so they are named.
  const F1 = '0x1CAb8177ACe78b1B6B1c393371F4f2dCAE40CbEB';
  ({ chain } = await run({ version: 8n, addresses: [C, F1], date: DATE, hash: HASH, pendingAdditions: 1, pendingDelistings: 1, applies: false }, { finality: fakeClock() }));
  assert.equal(chain.finality.state, 'pending');
  assert.deepEqual(chain.delistingsForRemover, [C]);
  assert.match(summarizeFailure(chain, 'sdn.xml'), new RegExp(`1 delisting\\(s\\) await the remover \\(the Safe\\): ${C}\\. Confirm`));

  // Overtaken by a NEWER publication before the first poll: its counts are reported as
  // that publication's, never paired with this run's delistings or file.
  ({ chain } = await run({ version: 7n, addresses: [C] }, {
    readCurrent: reads([BASE, snap(9n, [A2], { hash: OTHER_HASH, date: 20260401, pendingDelistings: 2 })]),
    finality: fakeClock(),
  }));
  assert.equal(chain.finality.state, 'overtaken');
  assert.deepEqual(chain.outstandingAt.publication, { date: 20260401, sha256: OTHER_HASH });
  assert.deepEqual(chain.delistingsForRemover, []);
  text = summarizeFailure(chain, 'sdn.xml');
  assert.match(text, /whether this update applied: its outcome is unknown/);
  assert.match(text, /declares 0 addition\(s\) and 2 delisting\(s\) outstanding, for another publication \(dated 20260401/);
  assert.doesNotMatch(text, /await the remover/);

  // Overtaken by the remover's delisting for this publication: owed nothing more.
  ({ chain } = await run({ version: 7n, addresses: [C] }, {
    readCurrent: reads([BASE, snap(9n, [A1], { pendingDelistings: 0 })]),
    finality: fakeClock(),
  }));
  assert.equal(chain.finality.state, 'overtaken');
  assert.equal(chain.pendingDelistings, 0);
  assert.doesNotMatch(summarizeFailure(chain), /await the remover/);

  // Refused before sending: the reading it was refused on is reported, as a list with no publication yet.
  ({ chain } = await run({ version: 7n, latest: 8n, addresses: [C] }));
  assert.equal(chain.status, 'refused');
  assert.equal(chain.outstandingAt.publication, 'none');
  assert.match(summarizeFailure(chain), /As last read \(finalized block 100, version 7\), the list declares 0 addition\(s\) and 0 delisting\(s\) outstanding, for no publication yet/);
});

test('finality: what a stopped chain says of each transaction it sent', async () => {
  // Unknown: the list could not be read again after the send.
  const { chain } = await run({ version: 7n, addresses: [C], applies: false }, {
    readCurrent: reads([BASE, new Error('RPC down')]),
    finality: fakeClock(),
  });
  assert.equal(chain.sent[0].state, 'included');
  assert.deepEqual(chain.finality, { state: 'unread' });
  assert.match(summarizeFailure(chain), /whether this update applied is unknown/);
  assert.match(summarizeFailure(chain), /As last read \(finalized block 100, version 7\)/, 'the reading before the send is the last one there is');
});
