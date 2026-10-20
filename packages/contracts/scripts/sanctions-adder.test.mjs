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
 *  collects what was sent. A sent call is applied to the list, so the next
 *  finalized read shows it, unless `list.applies` is false. */
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
        Object.assign(list, {
          version: call.expectedVersion + 1n,
          addresses: [...list.addresses, ...call.add],
          hash: HASH,
          pendingAdditions: call.additionsLeft,
          pendingDelistings: call.delistingsLeft,
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
  assert.equal(chain.sent[0].state, 'final', 'applied means final');
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
  assert.match(text, /Sepolia: skipped: no SanctionsList/);
});

test('run: a stop part-way keeps what was already sent, and says what may still land', async () => {
  // Not final: the transaction is included, and the report says so.
  let { chain } = await run({ version: 7n, addresses: [C], applies: false }, { finality: fakeClock() });
  assert.equal(chain.status, 'stopped');
  assert.equal(chain.sent.length, 1);
  assert.equal(chain.sent[0].state, 'included');
  assert.match(summarizeFailure(chain), /included, NOT yet final/);

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


// ── Finality: what the list shows at the finalized block, never a receipt ──

/** A fake clock for awaitFinality: `wait` advances `now`. */
function fakeClock(timeoutMs = 60_000) {
  let t = 0;
  return { timeoutMs, pollMs: 15_000, now: () => t, wait: async (ms) => { t += ms; } };
}

const A1 = getAddress('0x00000000000000000000000000000000000000a1');
const A2 = getAddress('0x00000000000000000000000000000000000000a2');
const TX1 = `0x${'1'.repeat(64)}`;
const TX2 = `0x${'2'.repeat(64)}`;
const entry = (expectedVersion, add, tx = TX1) => ({ expectedVersion: String(expectedVersion), add, tx, blockNumber: '201', state: 'included' });
const snap = (version, addresses, { hash = HASH, block = 300n } = {}) => ({ version, addresses, recordedHash: hash, blockNumber: block, blockHash: `0x${'c'.repeat(64)}` });
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

test('finality: applied means the list at the finalized block shows every call', async () => {
  const { chain, report } = await run({ version: 7n, addresses: [C] });
  assert.equal(chain.status, 'applied');
  assert.equal(chain.sent[0].state, 'final');
  assert.deepEqual(chain.sent[0].finalizedBlock, { number: '300', hash: `0x${'c'.repeat(64)}` });
  assert.match(summarize(report), /all final \(the list at finalized block 300 shows them\)/);
});

test('finality: a failed read or a list not yet past the call is "not yet", never a verdict', async () => {
  const readCurrent = reads([new Error('429 Too Many Requests'), snap(7n, []), snap(8n, [A1])]);
  const outcomes = await awaitFinality({ entries: [entry(7, [A1])], readCurrent, sourceHash: HASH, ...fakeClock() });
  assert.deepEqual(outcomes, [{ state: 'final', finalizedBlock: { number: '300', hash: `0x${'c'.repeat(64)}` } }]);
  assert.equal(readCurrent.count(), 3);
});

test('finality: a call once shown final stays final, whatever a later read says', async () => {
  // Call 1 is shown at the first read; a later read reports another publication; call 2 is shown after.
  const readCurrent = reads([snap(8n, [A1]), snap(8n, [A1], { hash: `0x${'9'.repeat(64)}` }), snap(9n, [A1, A2])]);
  const outcomes = await awaitFinality({ entries: [entry(7, [A1]), entry(8, [A2], TX2)], readCurrent, sourceHash: HASH, ...fakeClock() });
  assert.deepEqual(outcomes.map((o) => o.state), ['final', 'final']);
});

test('finality: a list past the call without showing it is conclusive; a deadline reports what is unknown', async () => {
  // Another update took version 7: the list is at 8 and does not list A1.
  let readCurrent = reads([snap(8n, [A2])]);
  let err = await awaitFinality({ entries: [entry(7, [A1])], readCurrent, sourceHash: HASH, ...fakeClock() }).catch((e) => e);
  assert.match(err.message, /past version 7 but does not show 0x1+: another update took that version/);
  assert.equal(readCurrent.count(), 1, 'conclusive: no further reads');
  assert.equal(err.outcomes[0].state, 'displaced');
  // Past the version, listing the addresses, but recording another publication: not this call either.
  err = await awaitFinality({ entries: [entry(7, [A1])], readCurrent: reads([snap(8n, [A1], { hash: `0x${'9'.repeat(64)}` })]), sourceHash: HASH, ...fakeClock() }).catch((e) => e);
  assert.equal(err.outcomes[0].state, 'displaced');

  // Never shown: the list stays behind, then the last read fails.
  readCurrent = reads([snap(7n, []), snap(7n, []), snap(7n, []), snap(7n, []), new Error('503')]);
  err = await awaitFinality({ entries: [entry(7, [A1])], readCurrent, sourceHash: HASH, ...fakeClock() }).catch((e) => e);
  assert.match(err.message, /not shown final after 1 minutes: 0x1+ is unknown: the finalized list could not be read/);
  assert.equal(err.outcomes[0].state, 'unread');
  readCurrent = reads([snap(7n, [])]);
  err = await awaitFinality({ entries: [entry(7, [A1])], readCurrent, sourceHash: HASH, ...fakeClock() }).catch((e) => e);
  assert.match(err.message, /\(included in block 201 when sent\) is not shown by the finalized list yet; it may still land/);
  assert.equal(err.outcomes[0].state, 'included');
  assert.equal(readCurrent.count(), 5, 'it read until the deadline');
});

test('finality: what a stopped chain reports for each outcome the check could establish', async () => {
  // Displaced: another update takes the version before this call lands.
  let { chain, report } = await run({ version: 7n, addresses: [C], applies: false }, {
    readCurrent: reads([
      { version: 7n, addresses: [C], recordedDate: 0, recordedHash: ZERO_HASH, recordedPendingAdditions: 0, recordedPendingDelistings: 0, blockNumber: 100n },
      snap(8n, [C]),
    ]),
    finality: fakeClock(),
  });
  assert.equal(report.status, 'failed');
  assert.equal(chain.status, 'stopped');
  assert.equal(chain.sent[0].state, 'displaced');
  assert.match(summarizeFailure(chain), /NOT applied — the finalized list moved past its version without it/);
  // Unknown: the list could not be read again after the send.
  ({ chain } = await run({ version: 7n, addresses: [C], applies: false }, {
    readCurrent: reads([
      { version: 7n, addresses: [C], recordedDate: 0, recordedHash: ZERO_HASH, recordedPendingAdditions: 0, recordedPendingDelistings: 0, blockNumber: 100n },
      new Error('RPC down'),
    ]),
    finality: fakeClock(),
  }));
  assert.equal(chain.sent[0].state, 'unread');
  assert.match(summarizeFailure(chain), /whether it is final is UNKNOWN/);
});
