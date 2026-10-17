// ofac-sanctions-diff.test.mjs — #2443: the OFAC SDN parser, the diff, the
// removal bound, the Chainalysis replay and the review-only cross-check, all
// pinned against a committed fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData } from 'viem';
import {
  parseSdnAdvanced,
  sourceHash,
  diffSets,
  buildUpdate,
  crossCheck,
  replayChainalysisLogs,
  normaliseAddresses,
  sanctionsListAbi,
  CHAINALYSIS_EVENTS,
} from './ofac-sanctions-diff.mjs';
import { toEventSelector, getAddress } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(HERE, 'fixtures', 'sdn_advanced.sample.xml'));
const A = '0x1CAb8177ACe78b1B6B1c393371F4f2dCAE40CbEB';
const B = getAddress('0x252a8bd2319d8a555b872990601221b3a2053bce'); // the fixture lists it lowercase and uppercase
const C = getAddress('0x00000000000000000000000000000000000000c0');
const D = getAddress('0x00000000000000000000000000000000000000d0');

test('parse: publication id, EVM addresses checksummed and deduped across assets', () => {
  const p = parseSdnAdvanced(FIXTURE.toString('utf8'));
  assert.equal(p.publicationId, '2026-03-07');
  assert.deepEqual(p.addresses, normaliseAddresses([A, B]));
  const b = p.entries.find((e) => e.address.toLowerCase() === B.toLowerCase());
  assert.deepEqual(b.assets, ['ETH', 'USDT']);
});

test('parse: False-reliability, non-EVM and non-currency features are kept out', () => {
  const p = parseSdnAdvanced(FIXTURE.toString('utf8'));
  assert.deepEqual(p.excludedFalse, [{ address: '0x1111111111111111111111111111111111111111', asset: 'ETH' }]);
  assert.deepEqual(p.nonEvmByAsset, { USDT: 1, XBT: 1 });
  assert.deepEqual(p.malformed, [{ value: '0x123', asset: 'ETH' }]);
  assert.ok(!p.addresses.some((a) => a.toLowerCase().endsWith('0bad')), 'a Place of Birth feature is not a currency address');
});

test('parse: refuses shapes that would make an empty list look real', () => {
  assert.throws(() => parseSdnAdvanced('<x/>'), /not an OFAC SDN Advanced XML/);
  const noDate = FIXTURE.toString('utf8').replace(/<DateOfIssue[\s\S]*?<\/DateOfIssue>/, '');
  assert.throws(() => parseSdnAdvanced(noDate), /DateOfIssue/);
  const noTypes = FIXTURE.toString('utf8').replaceAll('Digital Currency Address - ', 'Something - ');
  assert.throws(() => parseSdnAdvanced(noTypes), /feature types/);
  const noEvm = FIXTURE.toString('utf8').replace(/0x[0-9a-fA-F]{40}/g, 'TNotAnEvmAddress');
  assert.throws(() => parseSdnAdvanced(noEvm), /no EVM-format/);
});

test('sourceHash is SHA-256 of the exact bytes', () => {
  assert.match(sourceHash(FIXTURE), /^0x[0-9a-f]{64}$/);
  assert.notEqual(sourceHash(FIXTURE), sourceHash(Buffer.concat([FIXTURE, Buffer.from(' ')])));
});

test('diff: case-insensitive add and remove sets', () => {
  const d = diffSets([A, B], [B.toLowerCase(), C]);
  assert.deepEqual(d.add, [A]);
  assert.deepEqual(d.remove, [C]);
});

test('buildUpdate: calldata carries version, sets, hash and publication id', () => {
  const parsed = parseSdnAdvanced(FIXTURE.toString('utf8'));
  const hash = sourceHash(FIXTURE);
  const u = buildUpdate({ parsed, sourceHash: hash, current: [C], currentVersion: 4 });
  const abi = sanctionsListAbi();
  const { functionName, args } = decodeFunctionData({ abi, data: u.calldata });
  assert.equal(functionName, 'applyUpdate');
  assert.equal(args[0], 4n);
  assert.deepEqual(args[1], parsed.addresses);
  assert.deepEqual(args[2], [C]);
  assert.equal(args[3], hash);
  assert.equal(args[4], '2026-03-07');
});

test('buildUpdate: a large removal set is refused unless the bound is raised', () => {
  const parsed = parseSdnAdvanced(FIXTURE.toString('utf8'));
  const current = Array.from({ length: 11 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
  assert.throws(() => buildUpdate({ parsed, sourceHash: sourceHash(FIXTURE), current, currentVersion: 1 }), /refusing to delist 11/);
  const u = buildUpdate({ parsed, sourceHash: sourceHash(FIXTURE), current, currentVersion: 1, maxRemove: 11 });
  assert.equal(u.remove.length, 11);
});

test('Chainalysis replay: ordered by block/logIndex, removals honoured', () => {
  const logs = [
    { eventName: 'SanctionedAddressesRemoved', blockNumber: 20n, logIndex: 0, args: { addrs: [C] } },
    { eventName: 'SanctionedAddressesAdded', blockNumber: 10n, logIndex: 1, args: { addrs: [C, D] } },
    { eventName: 'SanctionedAddressesAdded', blockNumber: 10n, logIndex: 0, args: { addrs: [B] } },
  ];
  assert.deepEqual(replayChainalysisLogs(logs), normaliseAddresses([B, D]));
  assert.throws(() => replayChainalysisLogs([{ eventName: 'SanctionedAddress', blockNumber: 1n, logIndex: 0, args: { addrs: [C] } }]), /unexpected event/);
});

test('Chainalysis events match the verified source signatures', () => {
  assert.equal(toEventSelector(CHAINALYSIS_EVENTS.added), toEventSelector('SanctionedAddressesAdded(address[])'));
  assert.equal(toEventSelector(CHAINALYSIS_EVENTS.removed), toEventSelector('SanctionedAddressesRemoved(address[])'));
});

test('cross-check: three sets, and Chainalysis-only never reaches the update', () => {
  const parsed = parseSdnAdvanced(FIXTURE.toString('utf8'));
  const x = crossCheck(parsed.addresses, [B, D]);
  assert.deepEqual(x.inBoth, normaliseAddresses([B]));
  assert.deepEqual(x.ofacOnly, [A]);
  assert.deepEqual(x.chainalysisOnly, [D]);
  const u = buildUpdate({ parsed, sourceHash: sourceHash(FIXTURE), current: [], currentVersion: 0 });
  assert.ok(!u.add.includes(D));
});
