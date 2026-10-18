// sanctions-service.test.mjs — #2443: what the sanctions adder and the
// sanctions delister share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcRequestError } from 'viem';
import { SERVICE_CHAINS, TELEGRAM_MAX_TEXT, checkPrivateKey, configuredChains, createSendQueues, keepPublication, notifyOps, redact, sendTransaction } from './sanctions-service.mjs';

const KEY = `0x${'1'.repeat(64)}`;

test('keepPublication: keeps the newest N publications of its own prefix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keep-'));
  for (let i = 0; i < 4; i++) {
    const f = join(dir, `sdn-2026010${i}-${'a'.repeat(11)}${i}.xml`);
    writeFileSync(f, 'x');
    utimesSync(f, 1000 + i, 1000 + i);
  }
  // Another prefix's files are not counted against, or pruned by, this one.
  const plain = join(dir, `sdn-plain-20260101-${'c'.repeat(12)}.xml`);
  writeFileSync(plain, 'p');
  utimesSync(plain, 900, 900);
  writeFileSync(join(dir, 'last-run.json'), '{}');
  const dl = join(dir, 'download.xml');
  writeFileSync(dl, 'y');
  const kept = keepPublication(dl, dir, 20260307, `0x${'b'.repeat(64)}`, 2);
  assert.ok(existsSync(kept));
  assert.deepEqual(readdirSync(dir).sort(), ['last-run.json', `sdn-20260103-${'a'.repeat(11)}3.xml`, `sdn-20260307-${'b'.repeat(12)}.xml`, `sdn-plain-20260101-${'c'.repeat(12)}.xml`]);
  const dl2 = join(dir, 'download-plain.xml');
  writeFileSync(dl2, 'z');
  keepPublication(dl2, dir, 20260307, `0x${'d'.repeat(64)}`, 1, 'sdn-plain');
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('sdn-plain-')), [`sdn-plain-20260307-${'d'.repeat(12)}.xml`]);
});

test('checkPrivateKey and configuredChains', () => {
  checkPrivateKey('K', KEY);
  assert.throws(() => checkPrivateKey('K', '0x12'), /K is not a 32-byte hex key/);
  assert.throws(() => checkPrivateKey('K', `0x${'0'.repeat(64)}`), /not a valid secp256k1 key/);
  assert.throws(() => checkPrivateKey('K', `0x${'f'.repeat(64)}`), /not a valid secp256k1 key/);
  const chains = configuredChains({ RPC_ARB_SEPOLIA: 'https://a', RPC_BASE: 'https://mainnet' });
  assert.deepEqual(chains.map((c) => [c.id, c.rpc]), [[421614, 'https://a']]);
  const mainnets = [1, 8453, 42161, 10, 56, 137, 1101];
  for (const c of SERVICE_CHAINS) assert.ok(!mainnets.includes(c.id), `${c.name} is a testnet`);
});

test('createSendQueues: sends on one chain run one at a time, in order, and a failure does not stall the queue', async () => {
  const q = createSendQueues();
  const log = [];
  const slow = (tag, ms, fail) => () => new Promise((resolve, reject) => setTimeout(() => (log.push(tag), fail ? reject(new Error(tag)) : resolve(tag)), ms));
  const a = q.run(1, slow('a', 30));
  const b = q.run(1, slow('b', 1, true));
  const c = q.run(1, slow('c', 1));
  const other = q.run(2, slow('x', 1));
  await assert.rejects(b, /b/);
  assert.equal(await a, 'a');
  assert.equal(await c, 'c');
  assert.equal(await other, 'x');
  assert.deepEqual(log, ['x', 'a', 'b', 'c']);
});

test('notifyOps: skips without a token, never throws, reports a failed delivery, never leaks the token', async () => {
  assert.deepEqual(await notifyOps({ label: 'l', token: '', chatId: '1', text: 'x' }), { skipped: true });
  let body;
  const ok = await notifyOps({ label: 'sanctions adder', token: 'T0KEN', chatId: '5', text: 'hello', fetchImpl: async (url, init) => ((body = init.body), { ok: true }) });
  assert.deepEqual(ok, { delivered: true });
  assert.ok(!body.includes('T0KEN'));
  assert.equal(JSON.parse(body).text, '[sanctions adder] hello');
  assert.deepEqual(await notifyOps({ label: 'l', token: 'T', chatId: '5', text: 'x', fetchImpl: async () => ({ ok: false, status: 401 }) }), { delivered: false, reason: 'Telegram answered HTTP 401' });
  const down = await notifyOps({ label: 'l', token: 'S3CRET', chatId: '5', text: 'x', fetchImpl: async () => { throw new Error('fetch https://api.telegram.org/botS3CRET/sendMessage failed'); } });
  assert.equal(down.delivered, false);
  assert.ok(!down.reason.includes('S3CRET'));
  // A report too long for Telegram is cut to fit, never refused.
  const long = await notifyOps({ label: 'l', token: 'T', chatId: '5', text: 'y'.repeat(9000), fetchImpl: async (url, init) => ((body = init.body), { ok: true }) });
  assert.deepEqual(long, { delivered: true });
  const cut = JSON.parse(body).text;
  assert.equal(cut.length, TELEGRAM_MAX_TEXT);
  assert.match(cut, /the full report is in the journal\)$/);
});

test('sendTransaction: a refusal the node does not know is not broadcast; a lost reply to a known send goes on', async () => {
  const account = { address: '0x00000000000000000000000000000000000000aa' };
  const wallet = { prepareTransactionRequest: async () => ({}), signTransaction: async () => '0x01' };
  const refusal = new RpcRequestError({ body: {}, error: { code: -32000, message: 'nonce too low' }, url: 'http://rpc' });
  const make = ({ sendError, known }) => ({
    call: async () => ({}),
    sendRawTransaction: async () => Promise.reject(sendError),
    getTransaction: async () => (known ? {} : Promise.reject(new Error('not found'))),
    waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 7n, blockHash: '0xb' }),
  });
  let hash;
  await assert.rejects(
    sendTransaction({ client: make({ sendError: refusal, known: false }), wallet, account, to: account.address, data: '0x', onSubmitted: (h) => (hash = h), label: 'l' }),
    (e) => e.notBroadcast === true && e.message.includes(hash),
  );
  // A dropped connection the node cannot vouch for stays unknown.
  await assert.rejects(
    sendTransaction({ client: make({ sendError: new Error('socket hang up'), known: false }), wallet, account, to: account.address, data: '0x', label: 'l' }),
    (e) => !e.notBroadcast && /socket hang up/.test(e.message),
  );
  // The node has it (a retry answered "already known"): the send goes on.
  const sent = await sendTransaction({ client: make({ sendError: refusal, known: true }), wallet, account, to: account.address, data: '0x', label: 'l' });
  assert.equal(sent.blockNumber, 7n);
});

test('redact: an RPC URL and its key never reach a report, in any of the forms viem prints', () => {
  const rpc = 'https://base-sepolia.g.alchemy.com/v2/SECRETKEY123?x=1';
  const msg = `HTTP request failed.\n\nURL: ${rpc}\nRequest body: {}\nalso https://base-sepolia.g.alchemy.com/v2/SECRETKEY123 and /v2/SECRETKEY123`;
  const out = redact(msg, [rpc, KEY]);
  assert.ok(!out.includes('SECRETKEY123'), out);
  assert.match(out, /<redacted>/);
  assert.equal(redact(`key ${KEY}`, [undefined, KEY]), 'key <redacted>');
});
