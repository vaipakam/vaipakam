// sanctions-adder.test.mjs — #2443: the unattended adder run, with every
// chain and network effect replaced by a fake, against the committed fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, getAddress } from 'viem';
import { sanctionsListAbi, sourceHash } from './ofac-sanctions-diff.mjs';
import { failureReport, keepPublication, notifyOps, readConfig, redact, runAdder, summarize, summarizeFailure } from './sanctions-adder.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, 'fixtures', 'sdn_advanced.sample.xml');
const HASH = sourceHash(readFileSync(FIXTURE_PATH));
const C = getAddress('0x00000000000000000000000000000000000000c0');
const ZERO_HASH = `0x${'0'.repeat(64)}`;
const KEY = `0x${'1'.repeat(64)}`;

/** A run against a fake list in state `list`; returns the report and what was sent. */
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
    readCurrent: async () => ({
      version: list.version,
      addresses: list.addresses,
      recordedDate: list.date ?? 0,
      recordedHash: list.hash ?? ZERO_HASH,
      recordedPendingAdditions: list.pendingAdditions ?? 0,
      recordedPendingDelistings: list.pendingDelistings ?? 0,
      blockNumber: 100n,
    }),
    latestVersion: async () => list.latest ?? list.version,
    isAdder: async () => list.isAdder ?? true,
    send: async (call, { onSubmitted }) => {
      sent.push(call);
      const hash = `0x${String(sent.length).padStart(64, '0')}`;
      onSubmitted(hash);
      return { hash, blockNumber: 200n + BigInt(sent.length), blockHash: `0x${'b'.repeat(64)}` };
    },
    ...overrides,
  });
  return { report, sent, stateDir };
}

test('run: a new publication lists its additions and declares its delistings for the Safe', async () => {
  const { report, sent, stateDir } = await run({ version: 7n, addresses: [C] });
  assert.equal(report.status, 'applied');
  assert.equal(sent.length, 1);
  assert.equal(report.sent[0].state, 'final', 'applied means final');
  const args = decodeFunctionData({ abi: sanctionsListAbi(), data: sent[0].calldata }).args;
  assert.equal(args[0], 7n);
  assert.deepEqual(args[2], [], 'the adder never delists');
  assert.equal(args[6], 1, 'the delisting is declared outstanding');
  assert.deepEqual(report.delistingsForRemover, [C]);
  assert.equal(report.pendingDelistings, 1);
  assert.equal(report.source.sha256, HASH);
  // The publication is kept under its date and hash; the download name is gone.
  assert.deepEqual(readdirSync(stateDir), [`sdn-20260307-${HASH.slice(2, 14)}.xml`]);
  assert.match(summarize(report), /1 delisting\(s\) await the remover/);
});

test('run: up to date when the list holds the recorded publication', async () => {
  const fixtureAddrs = ['0x1CAb8177ACe78b1B6B1c393371F4f2dCAE40CbEB', getAddress('0x252a8bd2319d8a555b872990601221b3a2053bce')];
  const { report, sent } = await run({ version: 8n, addresses: fixtureAddrs, date: 20260307, hash: HASH });
  assert.equal(report.status, 'up-to-date');
  assert.equal(sent.length, 0);
  assert.equal(report.pendingDelistings, 0);
  assert.match(summarize(report), /nothing sent/);
});

test('run: refuses before sending when the list moved past the finalized block or the key is not the adder', async () => {
  await assert.rejects(run({ version: 7n, latest: 8n, addresses: [] }), /not yet final/);
  await assert.rejects(run({ version: 7n, addresses: [], isAdder: false }), /not an adder/);
});

test('run: a tool refusal sends nothing', async () => {
  const sent = [];
  // An older publication than the one recorded.
  await assert.rejects(
    run({ version: 7n, addresses: [], date: 20270101, hash: `0x${'2'.repeat(64)}` }, { send: async (c) => sent.push(c) }),
    /not newer/,
  );
  assert.equal(sent.length, 0);
});

test('run: a stop part-way keeps what was already sent, and says what may still land', async () => {
  // Not final: the transaction is included, and the report says so.
  const progress = [];
  await assert.rejects(
    run({ version: 7n, addresses: [C] }, { progress, confirmFinal: async () => { throw new Error('not final after 40 minutes'); } }),
    /not final/,
  );
  assert.equal(progress.length, 1);
  assert.equal(progress[0].state, 'included');
  let failed = failureReport('not final after 40 minutes', progress);
  assert.equal(failed.status, 'stopped');
  assert.match(summarizeFailure(failed), /included, NOT yet final/);

  // Broadcast, then the receipt wait timed out: the hash is known, the outcome is not.
  const progress2 = [];
  await assert.rejects(
    run({ version: 7n, addresses: [C] }, {
      progress: progress2,
      send: async (call, { onSubmitted }) => {
        onSubmitted(`0x${'e'.repeat(64)}`);
        throw new Error('receipt timeout');
      },
    }),
    /receipt timeout/,
  );
  failed = failureReport('receipt timeout', progress2);
  assert.equal(failed.sent[0].tx, `0x${'e'.repeat(64)}`);
  assert.match(summarizeFailure(failed), /may still land/);

  // Nothing broadcast: a plain refusal.
  failed = failureReport('x', [{ tx: null, state: 'submitting' }]);
  assert.equal(failed.status, 'refused');
  assert.match(summarizeFailure(failed), /REFUSED, nothing sent/);
});

test('keepPublication: keeps the newest N publications', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keep-'));
  for (let i = 0; i < 4; i++) {
    const f = join(dir, `sdn-2026010${i}-${'a'.repeat(11)}${i}.xml`);
    writeFileSync(f, 'x');
    utimesSync(f, 1000 + i, 1000 + i);
  }
  writeFileSync(join(dir, 'last-run.json'), '{}');
  const dl = join(dir, 'download.xml');
  writeFileSync(dl, 'y');
  const kept = keepPublication(dl, dir, 20260307, `0x${'b'.repeat(64)}`, 2);
  assert.ok(existsSync(kept));
  assert.deepEqual(readdirSync(dir).sort(), ['last-run.json', `sdn-20260103-${'a'.repeat(11)}3.xml`, `sdn-20260307-${'b'.repeat(12)}.xml`]);
});

test('config: every missing setting is named; mainnets and bad keys are refused', () => {
  assert.throws(() => readConfig({}), /SANCTIONS_ADDER_RPC_URL, SANCTIONS_ADDER_CHAIN_ID, SANCTIONS_LIST_ADDRESS, SANCTIONS_ADDER_PRIVATE_KEY, SANCTIONS_ADDER_STATE_DIR/);
  const env = { SANCTIONS_ADDER_RPC_URL: 'https://rpc', SANCTIONS_ADDER_CHAIN_ID: '84532', SANCTIONS_LIST_ADDRESS: C.toLowerCase(), SANCTIONS_ADDER_PRIVATE_KEY: KEY, STATE_DIRECTORY: '/var/lib/x' };
  const cfg = readConfig(env);
  assert.equal(cfg.chainId, 84532n);
  assert.equal(cfg.list, C);
  assert.equal(cfg.stateDir, '/var/lib/x');
  assert.equal(cfg.maxRemove, 10);
  assert.throws(() => readConfig({ ...env, SANCTIONS_ADDER_CHAIN_ID: '8453' }), /testnets only/);
  assert.throws(() => readConfig({ ...env, SANCTIONS_ADDER_CHAIN_ID: '1' }), /testnets only/);
  assert.throws(() => readConfig({ ...env, SANCTIONS_ADDER_PRIVATE_KEY: '0x12' }), /32-byte hex key/);
  assert.throws(() => readConfig({ ...env, SANCTIONS_ADDER_PRIVATE_KEY: `0x${'0'.repeat(64)}` }), /not a valid secp256k1 key/);
  assert.throws(() => readConfig({ ...env, SANCTIONS_ADDER_PRIVATE_KEY: `0x${'f'.repeat(64)}` }), /not a valid secp256k1 key/);
  assert.throws(() => readConfig({ ...env, SANCTIONS_ADDER_MAX_REMOVE: '-1' }), /non-negative decimal/);
});

test('notifyOps: skips without a token, never throws, reports a failed delivery, never leaks the token', async () => {
  assert.deepEqual(await notifyOps({ token: '', chatId: '1', text: 'x' }), { skipped: true });
  let body;
  const ok = await notifyOps({ token: 'T0KEN', chatId: '5', text: 'hello', fetchImpl: async (url, init) => ((body = init.body), { ok: true }) });
  assert.deepEqual(ok, { delivered: true });
  assert.ok(!body.includes('T0KEN'));
  assert.deepEqual(await notifyOps({ token: 'T', chatId: '5', text: 'x', fetchImpl: async () => ({ ok: false, status: 401 }) }), { delivered: false, reason: 'Telegram answered HTTP 401' });
  const down = await notifyOps({ token: 'S3CRET', chatId: '5', text: 'x', fetchImpl: async () => { throw new Error('fetch https://api.telegram.org/botS3CRET/sendMessage failed'); } });
  assert.equal(down.delivered, false);
  assert.ok(!down.reason.includes('S3CRET'));
});

test('redact: an RPC URL and its key never reach a report, in any of the forms viem prints', () => {
  const rpc = 'https://base-sepolia.g.alchemy.com/v2/SECRETKEY123?x=1';
  const msg = `HTTP request failed.\n\nURL: ${rpc}\nRequest body: {}\nalso https://base-sepolia.g.alchemy.com/v2/SECRETKEY123 and /v2/SECRETKEY123`;
  const out = redact(msg, [rpc, KEY]);
  assert.ok(!out.includes('SECRETKEY123'), out);
  assert.match(out, /<redacted>/);
  assert.equal(redact(`key ${KEY}`, [undefined, KEY]), 'key <redacted>');
});
