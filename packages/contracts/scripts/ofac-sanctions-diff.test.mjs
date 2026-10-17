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
  assertCompleteXml,
  parseUintArg,
  checkPublicationOrder,
  scanXml,
  decodeXmlText,
} from './ofac-sanctions-diff.mjs';
import { toEventSelector, getAddress } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(HERE, 'fixtures', 'sdn_advanced.sample.xml'));
const A = '0x1CAb8177ACe78b1B6B1c393371F4f2dCAE40CbEB';
const B = getAddress('0x252a8bd2319d8a555b872990601221b3a2053bce'); // the fixture lists it lowercase and uppercase
const C = getAddress('0x00000000000000000000000000000000000000c0');
const D = getAddress('0x00000000000000000000000000000000000000d0');
const ZERO_HASH = `0x${'0'.repeat(64)}`;
// A list that has never been updated: any valid publication is newer.
const FRESH = { recordedDate: 0, recordedHash: ZERO_HASH };

test('parse: publication id, EVM addresses checksummed and deduped across assets', () => {
  const p = parseSdnAdvanced(FIXTURE.toString('utf8'));
  assert.equal(p.publicationId, '2026-03-07');
  assert.equal(p.publicationDate, 20260307);
  assert.deepEqual(p.addresses, normaliseAddresses([A, B]));
  const b = p.entries.find((e) => e.address.toLowerCase() === B.toLowerCase());
  assert.deepEqual(b.assets, ['ETH', 'USDT']);
});

test('parse: False-reliability, non-EVM and non-currency features are kept out', () => {
  const p = parseSdnAdvanced(FIXTURE.toString('utf8'));
  assert.deepEqual(p.excludedFalse, [{ address: '0x1111111111111111111111111111111111111111', asset: 'ETH' }]);
  assert.deepEqual(p.nonEvmByAsset, { USDT: 1, XBT: 1 });
  // Every 0x/0X-prefixed value that is not exactly an address is reported raw.
  assert.deepEqual(p.malformed, [
    { value: '0x123', asset: 'ETH' },
    { value: '0x123Z', asset: 'ETH' },
    { value: '0X1CAb8177ACe78b1B6B1c393371F4f2dCAE40CbEB', asset: 'ARB' },
  ]);
  assert.ok(!p.addresses.some((a) => a.toLowerCase().endsWith('0bad')), 'a Place of Birth feature is not a currency address');
});

test('parse: refuses shapes that would make an empty list look real', () => {
  assert.throws(() => parseSdnAdvanced('<x/>'), /unexpected root/);
  assert.throws(() => parseSdnAdvanced('<Sanctions xmlns="https://example.org"></Sanctions>'), /not an OFAC SDN Advanced XML/);
  // A namespace that only CONTAINS the OFAC host is not OFAC's document.
  assert.throws(
    () => parseSdnAdvanced('<Sanctions xmlns="https://evil.example/ofac.treas.gov/ADVANCED_XML"></Sanctions>'),
    /not an OFAC SDN Advanced XML/,
  );
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
  const u = buildUpdate({ parsed, sourceHash: hash, current: [C], currentVersion: 4, ...FRESH });
  const abi = sanctionsListAbi();
  const { functionName, args } = decodeFunctionData({ abi, data: u.calldata });
  assert.equal(functionName, 'applyUpdate');
  assert.equal(args[0], 4n);
  assert.deepEqual(args[1], parsed.addresses);
  assert.deepEqual(args[2], [C]);
  assert.equal(args[3], hash);
  assert.equal(args[4], 20260307);
  assert.equal(u.order, 'newer');
  assert.equal(u.authorizeCalldata, null);
});

test('buildUpdate: a large removal set is refused unless the bound is raised', () => {
  const parsed = parseSdnAdvanced(FIXTURE.toString('utf8'));
  const current = Array.from({ length: 11 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
  assert.throws(() => buildUpdate({ parsed, sourceHash: sourceHash(FIXTURE), current, currentVersion: 1, ...FRESH }), /refusing to delist 11/);
  assert.throws(() => buildUpdate({ parsed, sourceHash: sourceHash(FIXTURE), current, currentVersion: 1, ...FRESH, maxRemove: NaN }), /maxRemove/);
  const u = buildUpdate({ parsed, sourceHash: sourceHash(FIXTURE), current, currentVersion: 1, maxRemove: 11, ...FRESH });
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
  const u = buildUpdate({ parsed, sourceHash: sourceHash(FIXTURE), current: [], currentVersion: 0, ...FRESH });
  assert.ok(!u.add.includes(D));
});

// ── Codex #2543 r1 ──────────────────────────────────────────────────

test('completeness: the fixture and a minimal document pass', () => {
  assertCompleteXml(FIXTURE.toString('utf8'));
  assertCompleteXml('<?xml version="1.0"?>\n<!-- c --><Sanctions a="x>y"><A/><B>t</B></Sanctions>\n');
});

test('completeness: truncation at any point is refused', () => {
  const text = FIXTURE.toString('utf8');
  const end = text.lastIndexOf('</Sanctions>');
  // Every cut strictly inside the document — mid-tag, mid-attribute, mid-text,
  // between elements, inside the closing root tag — must fail.
  const cuts = new Set([text.indexOf('<Sanctions') + 5, text.indexOf('ReliabilityID') + 3, text.indexOf('0x252a') + 10, text.indexOf('</Feature>') + 10, end - 1, end, end + 5, end + '</Sanctions'.length]);
  for (let c = 200; c < end; c += 97) cuts.add(c);
  for (const c of cuts) {
    assert.throws(() => parseSdnAdvanced(text.slice(0, c)), /incomplete XML|malformed XML|unterminated/, `cut at ${c}`);
  }
});

test('completeness: a cut after a whole feature still fails before extraction', () => {
  const text = FIXTURE.toString('utf8');
  const cut = text.indexOf('</Feature>', text.indexOf('0x252a')) + '</Feature>'.length;
  assert.throws(() => parseSdnAdvanced(text.slice(0, cut)), /never closed.*truncated/);
});

test('completeness: mismatched, doubled-root, trailing-junk and DOCTYPE inputs are refused', () => {
  assert.throws(() => assertCompleteXml('<Sanctions><A></B></Sanctions>'), /closes <A>/);
  assert.throws(() => assertCompleteXml('<Sanctions></Sanctions><Sanctions></Sanctions>'), /second root/);
  assert.throws(() => assertCompleteXml('<Sanctions></Sanctions>junk'), /outside the root/);
  assert.throws(() => assertCompleteXml('<!DOCTYPE x><Sanctions></Sanctions>'), /DOCTYPE/);
  assert.throws(() => assertCompleteXml('<Other></Other>'), /unexpected root/);
  assert.throws(() => assertCompleteXml('<Sanctions><!-- open'), /unterminated/);
});

test('numeric flags: one parser refuses everything but plain non-negative integers', () => {
  for (const bad of ['ten', 'NaN', '', '-1', '1e3', '0x10', '1.5', ' 3', 'Infinity']) {
    assert.throws(() => parseUintArg('--max-remove', bad), /non-negative decimal integer/, bad);
  }
  assert.equal(parseUintArg('--max-remove', '0'), 0n);
  assert.equal(parseUintArg('--max-remove', '12'), 12n);
  assert.throws(() => parseUintArg('--log-chunk', '0', { min: 1n }), /between 1/);
  assert.throws(() => parseUintArg('--max-remove', '2000000', { max: 1000000n }), /between/);
});

test('publication order: newer passes; older and same-day reissues are refused', () => {
  const H = (c) => `0x${c.repeat(64)}`;
  const base = { recordedDate: 20261015, recordedHash: H('a') };
  assert.equal(checkPublicationOrder({ ...base, date: 20261016, hash: H('b'), diffEmpty: false }), 'newer');
  assert.equal(checkPublicationOrder({ ...base, date: 20261015, hash: H('a'), diffEmpty: true }), 'refresh');
  assert.throws(() => checkPublicationOrder({ ...base, date: 20261014, hash: H('c'), diffEmpty: false }), /not newer/);
  assert.throws(() => checkPublicationOrder({ ...base, date: 20261015, hash: H('b'), diffEmpty: true }), /not newer/);
  assert.throws(() => checkPublicationOrder({ ...base, date: 20261015, hash: H('a'), diffEmpty: false }), /already records this exact file/);
  assert.equal(checkPublicationOrder({ ...base, date: 20261014, hash: H('c'), diffEmpty: false, allowRollback: true }), 'rollback');
});

test('buildUpdate: an older publication is refused; an allowed rollback carries the owner call', () => {
  const parsed = parseSdnAdvanced(FIXTURE.toString('utf8')); // 20260307
  const hash = sourceHash(FIXTURE);
  const newer = { recordedDate: 20260308, recordedHash: `0x${'b'.repeat(64)}` };
  assert.throws(() => buildUpdate({ parsed, sourceHash: hash, current: [], currentVersion: 5, ...newer }), /not newer/);
  const u = buildUpdate({ parsed, sourceHash: hash, current: [], currentVersion: 5, ...newer, allowRollback: true });
  assert.equal(u.order, 'rollback');
  const { functionName, args } = decodeFunctionData({ abi: sanctionsListAbi(), data: u.authorizeCalldata });
  assert.equal(functionName, 'authorizePublicationRollback');
  assert.equal(args[0], 20260307);
  assert.equal(args[1], hash);
  assert.throws(() => buildUpdate({ parsed, sourceHash: hash, current: [], currentVersion: 5 }), /recorded publication/);
});

// ---- Codex #2543 r2: one tokenizer drives completeness AND extraction ----
const PROFILE_OPEN = '<Profile ID="1" PartySubTypeID="4">';
const E = getAddress('0x00000000000000000000000000000000000000e0');
const feature = (addr, id = 90) =>
  `<Feature ID="${id}" FeatureTypeID="345"><FeatureVersion ID="${id + 1}" ReliabilityID="1"><VersionDetail DetailTypeID="1432">${addr}</VersionDetail></FeatureVersion></Feature>`;
const withInProfile = (snippet) => FIXTURE.toString('utf8').replace(PROFILE_OPEN, PROFILE_OPEN + snippet);

test('tokenizer: a commented-out <Feature> is not extracted', () => {
  const p = parseSdnAdvanced(withInProfile(`<!-- ${feature(E)} -->`));
  assert.ok(!p.addresses.includes(E));
  assert.deepEqual(p.addresses, normaliseAddresses([A, B]));
  // A comment that never closes is truncation, not a hidden feature.
  assert.throws(() => parseSdnAdvanced(withInProfile(`<!-- ${feature(E)}`)), /malformed|truncat|unterminated|unclosed/i);
});

test('tokenizer: a <Feature> inside CDATA is text, never markup; CDATA inside a value is decoded', () => {
  const asText = parseSdnAdvanced(withInProfile(`<![CDATA[${feature(E)}]]>`));
  assert.ok(!asText.addresses.includes(E), 'markup inside CDATA is literal text');
  const inValue = parseSdnAdvanced(withInProfile(feature(`<![CDATA[${E}]]>`)));
  assert.ok(inValue.addresses.includes(E), 'a CDATA-wrapped value is the value');
});

test('tokenizer: entities are decoded; an undeclared entity or a bare & is refused', () => {
  const hexRef = `&#x30;x${E.slice(2)}`; // &#x30; is "0"
  assert.ok(parseSdnAdvanced(withInProfile(feature(hexRef))).addresses.includes(E));
  assert.equal(decodeXmlText('a &amp; b &lt;&gt; &quot;&apos; &#65;'), 'a & b <> "\' A');
  assert.throws(() => decodeXmlText('&nbsp;'), /undeclared entity/);
  assert.throws(() => decodeXmlText('a & b'), /bare '&'/);
  assert.throws(() => parseSdnAdvanced(withInProfile(feature(`&ent;${E}`))), /undeclared entity/);
});

test('tokenizer: malformed attributes are refused; a quoted ">" or "<Feature" in an attribute is not markup', () => {
  assert.throws(() => scanXml('<Sanctions a="1" a="2"></Sanctions>'), /duplicate|attribute/i);
  assert.throws(() => scanXml('<Sanctions a=1></Sanctions>'), /attribute|malformed/i);
  const seen = [];
  scanXml('<Sanctions note="x &gt; y"><!-- <Feature/> --><F q="&lt;Feature/&gt;"/></Sanctions>', {
    open: (name, attrs) => seen.push([name, Object.fromEntries(attrs)]),
  });
  assert.deepEqual(seen, [['Sanctions', { note: 'x > y' }], ['F', { q: '<Feature/>' }]]);
});
