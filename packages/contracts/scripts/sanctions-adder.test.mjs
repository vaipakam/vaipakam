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
import { keepPublication, notifyOps, readConfig, runAdder, summarize } from './sanctions-adder.mjs';

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
    send: async (call) => {
      sent.push(call);
      return { hash: `0x${String(sent.length).padStart(64, '0')}` };
    },
    ...overrides,
  });
  return { report, sent, stateDir };
}

test('run: a new publication lists its additions and declares its delistings for the Safe', async () => {
  const { report, sent, stateDir } = await run({ version: 7n, addresses: [C] });
  assert.equal(report.status, 'applied');
  assert.equal(sent.length, 1);
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
  assert.throws(() => readConfig({ ...env, SANCTIONS_ADDER_MAX_REMOVE: '-1' }), /non-negative decimal/);
});

test('notifyOps: silent without a token, never throws, never puts the token in the text', async () => {
  assert.equal(await notifyOps({ token: '', chatId: '1', text: 'x' }), false);
  let body;
  const ok = await notifyOps({ token: 'T0KEN', chatId: '5', text: 'hello', fetchImpl: async (url, init) => ((body = init.body), { ok: true }) });
  assert.equal(ok, true);
  assert.ok(!body.includes('T0KEN'));
  assert.equal(await notifyOps({ token: 'T', chatId: '5', text: 'x', fetchImpl: async () => { throw new Error('down'); } }), false);
});
