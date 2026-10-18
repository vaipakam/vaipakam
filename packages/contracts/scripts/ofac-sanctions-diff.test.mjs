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
  decodeSource,
  isPublicationDate,
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
/**
 * buildUpdate with every delisting the diff computes confirmed, for tests
 * about batching, ordering and counts. The confirmation rule itself is tested
 * against buildUpdate directly.
 */
const buildConfirmed = (o) => buildUpdate({ confirmedDelistings: diffSets(o.parsed.addresses, o.current ?? []).remove, ...o });
const FRESH = { recordedDate: 0, recordedHash: ZERO_HASH, recordedPendingAdditions: 0, recordedPendingDelistings: 0 };

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

test('buildUpdate: additions go to the adder, delistings to the remover at the next version', () => {
  const parsed = parseSdnAdvanced(FIXTURE.toString('utf8'));
  const hash = sourceHash(FIXTURE);
  const u = buildConfirmed({ parsed, sourceHash: hash, current: [C], currentVersion: 4, ...FRESH });
  const abi = sanctionsListAbi();
  assert.deepEqual(u.calls.map((c) => [c.signer, c.expectedVersion]), [['adder', 4n], ['remover', 5n]]);
  const first = decodeFunctionData({ abi, data: u.calls[0].calldata });
  assert.equal(first.functionName, 'applyUpdate');
  assert.deepEqual(first.args, [4n, parsed.addresses, [], hash, 20260307, 0, 1], 'the adder declares the delisting it leaves outstanding');
  const second = decodeFunctionData({ abi, data: u.calls[1].calldata });
  assert.deepEqual(second.args, [5n, [], [C], hash, 20260307, 0, 0], 'the remover repeats the publication with delistings only, completing it');
  assert.equal(u.order, 'newer');
  assert.equal(u.authorizeCalldata, null);
});

test('buildUpdate: adds-only, delist-only and empty diffs each make exactly one call', () => {
  const parsed = parseSdnAdvanced(FIXTURE.toString('utf8'));
  const hash = sourceHash(FIXTURE);
  const signers = (current, rec = FRESH) =>
    buildConfirmed({ parsed, sourceHash: hash, current, currentVersion: 2, ...rec }).calls.map((c) => [c.signer, c.expectedVersion]);
  assert.deepEqual(signers([]), [['adder', 2n]]);
  assert.deepEqual(signers([...parsed.addresses, C]), [['remover', 2n]]);
  assert.deepEqual(signers(parsed.addresses), [['adder', 2n]], 'a refresh needs no multisig');
  // The remover completing the recorded publication's delistings.
  const same = { recordedDate: 20260307, recordedHash: hash, recordedPendingAdditions: 0, recordedPendingDelistings: 1 };
  assert.deepEqual(signers([...parsed.addresses, C], same), [['remover', 2n]]);
  assert.equal(buildConfirmed({ parsed, sourceHash: hash, current: [...parsed.addresses, C], currentVersion: 2, ...same }).order, 'same-publication');
  assert.throws(() => signers([], same), /already records this exact file/);
});

test('buildUpdate: a large removal set is refused unless the bound is raised', () => {
  const parsed = parseSdnAdvanced(FIXTURE.toString('utf8'));
  const current = Array.from({ length: 11 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
  assert.throws(() => buildConfirmed({ parsed, sourceHash: sourceHash(FIXTURE), current, currentVersion: 1, ...FRESH }), /refusing to delist 11/);
  assert.throws(() => buildConfirmed({ parsed, sourceHash: sourceHash(FIXTURE), current, currentVersion: 1, ...FRESH, maxRemove: NaN }), /maxRemove/);
  const u = buildConfirmed({ parsed, sourceHash: sourceHash(FIXTURE), current, currentVersion: 1, maxRemove: 11, ...FRESH });
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
  const u = buildConfirmed({ parsed, sourceHash: sourceHash(FIXTURE), current: [], currentVersion: 0, ...FRESH });
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
  assert.equal(checkPublicationOrder({ ...base, date: 20261016, hash: H('b'), additions: 1 }), 'newer');
  assert.equal(checkPublicationOrder({ ...base, date: 20261015, hash: H('a'), additions: 0 }), 'same-publication');
  assert.throws(() => checkPublicationOrder({ ...base, date: 20261014, hash: H('c'), additions: 1 }), /not newer/);
  assert.throws(() => checkPublicationOrder({ ...base, date: 20261015, hash: H('b'), additions: 0 }), /not newer/);
  assert.throws(() => checkPublicationOrder({ ...base, date: 20261015, hash: H('a'), additions: 1 }), /already records this exact file/);
  assert.equal(checkPublicationOrder({ ...base, date: 20261014, hash: H('c'), additions: 1, allowRollback: true }), 'rollback');
});

test('buildUpdate: an older publication is refused; an allowed rollback carries the owner call', () => {
  const parsed = parseSdnAdvanced(FIXTURE.toString('utf8')); // 20260307
  const hash = sourceHash(FIXTURE);
  const newer = { recordedDate: 20260308, recordedHash: `0x${'b'.repeat(64)}`, recordedPendingAdditions: 0, recordedPendingDelistings: 0 };
  assert.throws(() => buildConfirmed({ parsed, sourceHash: hash, current: [], currentVersion: 5, ...newer }), /not newer/);
  const u = buildConfirmed({ parsed, sourceHash: hash, current: [], currentVersion: 5, ...newer, allowRollback: true });
  assert.equal(u.order, 'rollback');
  const { functionName, args } = decodeFunctionData({ abi: sanctionsListAbi(), data: u.authorizeCalldata });
  assert.equal(functionName, 'authorizePublicationRollback');
  assert.equal(args[0], 5n, 'bound to the list version the diff was computed against');
  assert.equal(args[1], 20260307);
  assert.equal(args[2], hash);
  assert.throws(() => buildConfirmed({ parsed, sourceHash: hash, current: [], currentVersion: 5 }), /recorded publication/);
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

// ---- Codex #2543 r4: namespace-aware extraction, every record resolves ----
const NS = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML';

test('namespaces: any element outside OFAC\'s namespace refuses the file; a prefixed OFAC root is accepted', () => {
  // Codex #2543 r15: skipping a foreign subtree could drop a real record and
  // delist its address, so an element outside OFAC's namespace is refused.
  const foreignRe = /unexpected element <.*> in namespace/;
  assert.throws(() => parseSdnAdvanced(withInProfile(`<x:Feature xmlns:x="https://evil.example/" FeatureTypeID="345"><x:FeatureVersion ReliabilityID="1"><x:VersionDetail>${E}</x:VersionDetail></x:FeatureVersion></x:Feature>`)), foreignRe);
  // A default-namespace switch on a wrapper puts unprefixed children outside OFAC's namespace too.
  assert.throws(() => parseSdnAdvanced(withInProfile(`<Wrap xmlns="https://evil.example/">${feature(E)}</Wrap>`)), foreignRe);
  // A record node at its documented path, moved out of the namespace, is refused, not skipped.
  assert.throws(() => parseSdnAdvanced(withInProfile(feature(E).replace('<Feature ', '<Feature xmlns="" '))), foreignRe);
  // The same document with OFAC's namespace bound to a prefix is still OFAC's document.
  const prefixed = FIXTURE.toString('utf8')
    .replace(`xmlns="${NS}"`, `xmlns:o="${NS}"`)
    .replace(/<(\/?)(?![?!])([A-Za-z])/g, '<$1o:$2');
  assert.deepEqual(parseSdnAdvanced(prefixed).addresses, normaliseAddresses([A, B]));
  // A prefixed root bound to another namespace is refused, as is an unbound prefix.
  assert.throws(() => parseSdnAdvanced(`<o:Sanctions xmlns:o="https://evil.example/" xmlns="${NS}"></o:Sanctions>`), /not an OFAC SDN Advanced XML/);
  assert.throws(() => scanXml('<Sanctions><q:Feature/></Sanctions>'), /unbound namespace prefix q/);
});

// ---- Codex #2543 r17: record nodes appear only on their documented paths ----
test('anchors: a record node found off its documented path refuses the file instead of being skipped', () => {
  const moved = /but the schema places it only at/;
  // An extra wrapper around a real Feature.
  assert.throws(() => parseSdnAdvanced(withInProfile(`<Wrapper>${feature(E)}</Wrapper>`)), moved);
  // A FeatureVersion one level up, directly under the Profile.
  assert.throws(() => parseSdnAdvanced(withInProfile(`<FeatureVersion ReliabilityID="1"/>`)), moved);
  // A reference value outside its set.
  const fx = FIXTURE.toString('utf8').replace('<ReferenceValueSets>', '<ReferenceValueSets><Extra><FeatureType ID="7">x</FeatureType></Extra>');
  assert.throws(() => parseSdnAdvanced(fx), moved);
  // Year/Month/Day are shared names: elsewhere they are unrelated structure.
  assert.ok(parseSdnAdvanced(withInProfile('<Other><Year>2020</Year></Other>')).addresses.length > 0);
});

// ---- Codex #2543 r16: names are XML qualified names, one colon at most ----
test('names: an element or attribute name with a second colon is malformed, not a different local name', () => {
  assert.throws(() => scanXml(`<Sanctions xmlns:o="${NS}"><o:Feature:x/></Sanctions>`), /not a valid qualified name/);
  assert.throws(() => scanXml('<Sanctions><Feature x:y:z="1"/></Sanctions>'), /bad attribute syntax/);
  // A feature carrying an address, corrupted this way, refuses the whole file.
  const corrupted = feature(E).replace('<Feature ', '<o:Feature:x ').replace('</Feature>', '</o:Feature:x>');
  assert.throws(() => parseSdnAdvanced(withInProfile(corrupted).replace(`xmlns="${NS}"`, `xmlns="${NS}" xmlns:o="${NS}"`)), /not a valid qualified name/);
  // Single-prefix names still parse.
  assert.doesNotThrow(() => scanXml(`<Sanctions xmlns:o="${NS}"><o:Feature o:a="1"/></Sanctions>`));
});

test('references: a record whose FeatureTypeID or ReliabilityID resolves to nothing refuses the file', () => {
  const badType = feature(E).replace('FeatureTypeID="345"', 'FeatureTypeID="99999"');
  assert.throws(() => parseSdnAdvanced(withInProfile(badType)), /FeatureTypeID "99999"/);
  const badRel = feature(E).replace('ReliabilityID="1"', 'ReliabilityID="99999"');
  assert.throws(() => parseSdnAdvanced(withInProfile(badRel)), /ReliabilityID "99999"/);
  const noRel = feature(E).replace(' ReliabilityID="1"', '');
  assert.throws(() => parseSdnAdvanced(withInProfile(noRel)), /ReliabilityID null/);
  const dupType = FIXTURE.toString('utf8').replace('<FeatureTypeValues>', '<FeatureTypeValues><FeatureType ID="345">Digital Currency Address - XBT</FeatureType>');
  assert.throws(() => parseSdnAdvanced(dupType), /defined twice/);
});

// ---- Codex #2543 r5: full-path matching, a single publication date ----
test('paths: a <Feature> off the documented party path is never read — it refuses the file', () => {
  // Codex #2543 r17 tightened "never read" to "refused": a skipped record
  // would be a dropped address and a delisting.
  const spliced = FIXTURE.toString('utf8').replace('<DistinctParties>', `<Wrapper>${feature(E)}</Wrapper><DistinctParties>`);
  assert.throws(() => parseSdnAdvanced(spliced), /but the schema places it only at/);
  const underParty = FIXTURE.toString('utf8').replace(PROFILE_OPEN, `<Other>${feature(E)}</Other>${PROFILE_OPEN}`);
  assert.throws(() => parseSdnAdvanced(underParty), /but the schema places it only at/);
  assert.ok(parseSdnAdvanced(withInProfile(feature(E))).addresses.includes(E), 'the documented path is still read');
});

test('paths: a repeated <DateOfIssue> or date part is refused, never last-wins', () => {
  const xml = FIXTURE.toString('utf8');
  const block = /<DateOfIssue[\s\S]*?<\/DateOfIssue>/.exec(xml)[0];
  const later = block.replace(/<Year>\d{4}<\/Year>/, '<Year>2099</Year>');
  assert.throws(() => parseSdnAdvanced(xml.replace('</Sanctions>', `${later}</Sanctions>`)), /more than once/);
  assert.throws(() => parseSdnAdvanced(xml.replace('</DateOfIssue>', '<Year>2099</Year></DateOfIssue>')), /more than once/);
});

// ---- Codex #2543 r7: the zero address never reaches an update ----
test('zero address: refused in a current list, surfaced as malformed in OFAC data', () => {
  const ZERO_ADDR = `0x${'0'.repeat(40)}`;
  assert.throws(() => normaliseAddresses([A, ZERO_ADDR]), /zero address/);
  const p = parseSdnAdvanced(withInProfile(feature(ZERO_ADDR)));
  assert.ok(!p.addresses.includes(ZERO_ADDR));
  assert.ok(p.malformed.some((m) => m.value === ZERO_ADDR));
});

// ---- Codex #2543 r8: a repeated publication mirrors the contract's count rule ----
test('buildUpdate: completing a partly applied publication declares what the contract will compute', () => {
  const parsed = parseSdnAdvanced(FIXTURE.toString('utf8'));
  const hash = sourceHash(FIXTURE);
  const same = { recordedDate: 20260307, recordedHash: hash, recordedPendingAdditions: 0 };
  const abi = sanctionsListAbi();
  const last = (u) => decodeFunctionData({ abi, data: u.calls[u.calls.length - 1].calldata }).args[6];
  // Two outstanding, the diff applies one: one stays outstanding.
  const partial = buildConfirmed({ parsed, sourceHash: hash, current: [...parsed.addresses, C], currentVersion: 3, ...same, recordedPendingDelistings: 2 });
  assert.equal(last(partial), 1);
  const full = buildConfirmed({ parsed, sourceHash: hash, current: [...parsed.addresses, C, D], currentVersion: 3, ...same, recordedPendingDelistings: 2 });
  assert.equal(last(full), 0);
  // A no-change refresh keeps the recorded count.
  const refresh = buildConfirmed({ parsed, sourceHash: hash, current: parsed.addresses, currentVersion: 3, ...same, recordedPendingDelistings: 2 });
  assert.equal(last(refresh), 2);
});

// ---- Codex #2543 r9: a digital-currency version with no address is refused ----
test('parseSdnAdvanced: a digital-currency FeatureVersion without a VersionDetail refuses the file', () => {
  const noDetail = `<Feature ID="9100" FeatureTypeID="345"><FeatureVersion ID="9101" ReliabilityID="1"></FeatureVersion></Feature>`;
  assert.throws(() => parseSdnAdvanced(withInProfile(noDetail)), /carries no <VersionDetail>/);
  const selfClosing = `<Feature ID="9102" FeatureTypeID="345"><FeatureVersion ID="9103" ReliabilityID="1"/></Feature>`;
  assert.throws(() => parseSdnAdvanced(withInProfile(selfClosing)), /carries no <VersionDetail>/);
  const emptyDetail = feature('');
  assert.throws(() => parseSdnAdvanced(withInProfile(emptyDetail)), /carries no <VersionDetail>/);
  // A detail-less version of a NON-digital-currency feature is not ours to read.
  const otherType = `<Feature ID="9104" FeatureTypeID="25"><FeatureVersion ID="9105" ReliabilityID="1"/></Feature>`;
  assert.ok(parseSdnAdvanced(withInProfile(otherType)).addresses.length > 0);
});

// ---- Codex #2543 r14: a digital-currency feature with no version is refused ----
test('parseSdnAdvanced: a digital-currency Feature without a FeatureVersion refuses the file', () => {
  const empty = `<Feature ID="9200" FeatureTypeID="345"></Feature>`;
  assert.throws(() => parseSdnAdvanced(withInProfile(empty)), /carries no <FeatureVersion>/);
  const selfClosing = `<Feature ID="9201" FeatureTypeID="345"/>`;
  assert.throws(() => parseSdnAdvanced(withInProfile(selfClosing)), /carries no <FeatureVersion>/);
  // A version-less feature of another type is not ours to read.
  const otherType = `<Feature ID="9202" FeatureTypeID="25"/>`;
  assert.ok(parseSdnAdvanced(withInProfile(otherType)).addresses.length > 0);
  // Its type must still resolve.
  const unknownType = `<Feature ID="9203" FeatureTypeID="99999"/>`;
  assert.throws(() => parseSdnAdvanced(withInProfile(unknownType)), /no <FeatureType> defines/);
});

// ---- Codex #2543 r10: the current list comes from the chain only ----
test('CLI: a file of current addresses is refused; the list is read from the chain', async () => {
  const { spawnSync } = await import('node:child_process');
  const xml = join(HERE, 'fixtures', 'sdn_advanced.sample.xml');
  const r = spawnSync(process.execPath, [join(HERE, 'ofac-sanctions-diff.mjs'), '--xml', xml, '--current', 'x.json'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--rpc \+ --list/);
});

// ---- Codex #2543 r10: corrupted bytes are refused, not replaced ----
test('decodeSource: invalid UTF-8 is refused; valid UTF-8 decodes unchanged', () => {
  assert.equal(decodeSource(FIXTURE), FIXTURE.toString('utf8'));
  const corrupt = Buffer.concat([Buffer.from('<a>0'), Buffer.from([0xff]), Buffer.from('</a>')]);
  assert.throws(() => decodeSource(corrupt), /not valid UTF-8/);
});

// ---- Codex #2543 r10: impossible calendar dates are refused ----
test('isPublicationDate: month lengths and leap years', () => {
  for (const d of [20260231, 20260431, 20270229, 21000229, 20261301, 20261000]) assert.equal(isPublicationDate(d), false, String(d));
  for (const d of [20280229, 24000229, 20260430, 20261231, 20260101]) assert.equal(isPublicationDate(d), true, String(d));
});

// ---- Codex #2543 r10: a large publication is applied in batches ----
test('buildUpdate: additions are batched, each call declaring what remains', () => {
  const parsed = parseSdnAdvanced(FIXTURE.toString('utf8'));
  const hash = sourceHash(FIXTURE);
  const abi = sanctionsListAbi();
  const n = parsed.addresses.length;
  assert.ok(n >= 2, 'fixture needs at least two addresses');
  const u = buildConfirmed({ parsed, sourceHash: hash, current: [C], currentVersion: 7, ...FRESH, maxChangesPerCall: 1 });
  const decoded = u.calls.map((c) => decodeFunctionData({ abi, data: c.calldata }).args);
  assert.equal(u.calls.length, n + 1);
  decoded.slice(0, n).forEach((args, i) => {
    assert.equal(args[0], 7n + BigInt(i), 'each call applies to the version the one before produces');
    assert.deepEqual(args[1], [parsed.addresses[i]]);
    assert.equal(args[5], n - i - 1, 'additions still to come');
    assert.equal(args[6], 1, 'the delisting stays outstanding until the remover');
  });
  assert.deepEqual(decoded[n].slice(0, 3), [7n + BigInt(n), [], [C]]);
  assert.equal(decoded[n][5], 0);
  assert.equal(decoded[n][6], 0);
  assert.deepEqual(u.calls.map((c) => c.signer), [...Array(n).fill('adder'), 'remover']);
  // Resuming a partly applied publication continues from the recorded counts.
  const same = { recordedDate: 20260307, recordedHash: hash, recordedPendingAdditions: n - 1, recordedPendingDelistings: 1 };
  const resumed = buildConfirmed({ parsed, sourceHash: hash, current: [parsed.addresses[0], C], currentVersion: 8, ...same, maxChangesPerCall: 100 });
  assert.equal(resumed.order, 'same-publication');
  const r0 = decodeFunctionData({ abi, data: resumed.calls[0].calldata }).args;
  assert.deepEqual([r0[5], r0[6]], [0, 1]);
  // More additions than the publication declared outstanding is refused.
  assert.throws(
    () => buildConfirmed({ parsed, sourceHash: hash, current: [C], currentVersion: 8, ...same }),
    /already records this exact file/,
  );
  assert.throws(() => buildConfirmed({ parsed, sourceHash: hash, current: [], currentVersion: 1, ...FRESH, maxChangesPerCall: 0 }), /maxChangesPerCall/);
  assert.throws(
    () => buildConfirmed({ parsed, sourceHash: hash, current: [], currentVersion: 1, recordedDate: 0, recordedHash: ZERO_HASH }),
    /pendingAdditions and pendingDelistings are required/,
  );
});

// ---- Codex #2543 r11: only the schema version whose paths the tool reads ----
test('parseSdnAdvanced: an unsupported or missing schema Version is refused', () => {
  const xml = FIXTURE.toString('utf8');
  assert.ok(parseSdnAdvanced(xml).addresses.length > 0);
  assert.throws(() => parseSdnAdvanced(xml.replace(' Version="3"', ' Version="4"')), /unsupported OFAC SDN Advanced schema version "4"/);
  assert.throws(() => parseSdnAdvanced(xml.replace(' Version="3"', '')), /unsupported OFAC SDN Advanced schema version null/);
});

// ---- Codex #2543 r11: a repeat may delist only what was declared outstanding ----
test('buildUpdate: a completed publication cannot be cited for further delistings', () => {
  const parsed = parseSdnAdvanced(FIXTURE.toString('utf8'));
  const hash = sourceHash(FIXTURE);
  const done = { recordedDate: 20260307, recordedHash: hash, recordedPendingAdditions: 0, recordedPendingDelistings: 0 };
  assert.throws(
    () => buildConfirmed({ parsed, sourceHash: hash, current: [...parsed.addresses, C], currentVersion: 4, ...done }),
    /already records this exact file/,
  );
  const one = { ...done, recordedPendingDelistings: 1 };
  assert.throws(
    () => buildConfirmed({ parsed, sourceHash: hash, current: [...parsed.addresses, C, D], currentVersion: 4, ...one }),
    /already records this exact file/,
  );
  const u = buildConfirmed({ parsed, sourceHash: hash, current: [...parsed.addresses, C], currentVersion: 4, ...one });
  assert.deepEqual([u.calls.length, u.calls[0].signer, u.calls[0].delistingsLeft], [1, 'remover', 0]);
});

// ---- Codex #2543 r12: delistings are batched by the same rule ----
test('buildUpdate: delistings are batched too, each call declaring what remains', () => {
  const parsed = parseSdnAdvanced(FIXTURE.toString('utf8'));
  const hash = sourceHash(FIXTURE);
  const abi = sanctionsListAbi();
  const extra = Array.from({ length: 5 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
  const u = buildConfirmed({ parsed, sourceHash: hash, current: [...parsed.addresses, ...extra], currentVersion: 2, ...FRESH, maxChangesPerCall: 2 });
  assert.deepEqual(u.calls.map((c) => [c.signer, c.remove.length, c.delistingsLeft]), [['remover', 2, 3], ['remover', 2, 1], ['remover', 1, 0]]);
  u.calls.forEach((c, i) => assert.equal(decodeFunctionData({ abi, data: c.calldata }).args[0], 2n + BigInt(i)));
});

// ---- Codex #2543 r12: only an address-type detail is read as an address ----
test('parseSdnAdvanced: a digital-currency detail must be of the TEXT detail type', () => {
  const lookup = feature(E).replace('DetailTypeID="1432"', 'DetailTypeID="1431"');
  assert.throws(() => parseSdnAdvanced(withInProfile(lookup)), /is of type "LOOKUP", not TEXT/);
  const missing = feature(E).replace(' DetailTypeID="1432"', '');
  assert.throws(() => parseSdnAdvanced(withInProfile(missing)), /DetailTypeID null/);
  const unknown = feature(E).replace('DetailTypeID="1432"', 'DetailTypeID="99999"');
  assert.throws(() => parseSdnAdvanced(withInProfile(unknown)), /DetailTypeID "99999", which no <DetailType> defines/);
  assert.ok(parseSdnAdvanced(withInProfile(feature(E))).addresses.includes(E));
});

// ---- Codex #2543 r19: XML characters, non-empty references, the delisting witness ----
test('characters: a character outside XML\'s Char production refuses the file, literal or referenced', () => {
  const xml = FIXTURE.toString('utf8');
  for (const bad of ['&#0;', '&#x0;', '&#xD800;', '&#xFFFE;', '&#x1F;']) {
    assert.throws(() => parseSdnAdvanced(xml.replace('0x252a8bd2319d8a555b872990601221b3a2053bce', `${bad}x252a8bd2319d8a555b872990601221b3a2053bce`)), /not an XML character/, bad);
  }
  assert.throws(() => parseSdnAdvanced(xml.replace('<Year>', '<Year>\u0000')), /U\+0000 at offset \d+ is not an XML character/);
  // Tab, LF, CR and ordinary references still decode.
  assert.equal(decodeXmlText('a&#9;b&#x41;'), 'a\tbA');
});

test('references: an empty reference value refuses the file', () => {
  const xml = FIXTURE.toString('utf8');
  assert.throws(() => parseSdnAdvanced(xml.replace('<Reliability ID="1561">False</Reliability>', '<Reliability ID="1561"> </Reliability>')), /ID 1561 has an empty value/);
  assert.throws(() => parseSdnAdvanced(xml.replace('>Digital Currency Address - ETH</FeatureType>', '></FeatureType>')), /ID 345 has an empty value/);
});

test('buildUpdate: a delisting is refused while the address still appears in the source file', () => {
  // The address sits in the file but on no path the parser reads: whatever
  // dropped it, OFAC has not removed its record.
  const text = withInProfile(`<Other>${E}</Other>`);
  const parsed = parseSdnAdvanced(text);
  assert.ok(!parsed.addresses.includes(E));
  const hash = sourceHash(Buffer.from(text));
  assert.throws(() => buildConfirmed({ parsed, sourceHash: hash, current: [...parsed.addresses, E], currentVersion: 1, ...FRESH }), /still appears in the source file/);
  // An address absent from the file is a genuine delisting.
  const ok = buildConfirmed({ parsed, sourceHash: hash, current: [...parsed.addresses, C], currentVersion: 1, ...FRESH });
  assert.deepEqual(ok.remove, [C]);
  // An address the file carries only as OFAC-marked False may be delisted.
  const F = getAddress('0x1111111111111111111111111111111111111111');
  assert.ok(parsed.excludedFalse.some((e) => e.address === F));
  assert.deepEqual(buildConfirmed({ parsed, sourceHash: hash, current: [...parsed.addresses, F], currentVersion: 1, ...FRESH }).remove, [F]);
  // A False record cannot mask another mention of the same address (r20).
  const masked = withInProfile(`<Other>${F}</Other>`);
  const parsedMasked = parseSdnAdvanced(masked);
  assert.ok(parsedMasked.excludedFalse.some((e) => e.address === F));
  assert.throws(() => buildConfirmed({ parsed: parsedMasked, sourceHash: sourceHash(Buffer.from(masked)), current: [...parsedMasked.addresses, F], currentVersion: 1, ...FRESH }), /still appears in the source file/);
  // An entity-encoded mention is counted in decoded text even though the raw bytes miss it.
  const encoded = withInProfile(`<Other>&#x30;x${'1'.repeat(40)}</Other>`);
  const parsedEnc = parseSdnAdvanced(encoded);
  assert.throws(() => buildConfirmed({ parsed: parsedEnc, sourceHash: sourceHash(Buffer.from(encoded)), current: [...parsedEnc.addresses, F], currentVersion: 1, ...FRESH }), /still appears in the source file/);
  // A hand-built parsed object without the witness is refused, never skipped.
  assert.throws(() => buildConfirmed({ parsed: { ...parsed, hexRuns: undefined }, sourceHash: hash, current: [...parsed.addresses, C], currentVersion: 1, ...FRESH }), /no hexRuns/);
});

// ---- Codex #2543 r21: delistings need a second source; reliability is a closed vocabulary ----
test('buildUpdate: a delisting needs the operator\'s exact confirmation', () => {
  const parsed = parseSdnAdvanced(FIXTURE.toString('utf8'));
  const hash = sourceHash(FIXTURE);
  const base = { parsed, sourceHash: hash, current: [...parsed.addresses, C], currentVersion: 1, ...FRESH };
  // Unconfirmed: refused, naming the malformed values the file carries.
  assert.throws(() => buildUpdate(base), /does not name.*malformed digital-currency value/s);
  // Confirmed exactly: emitted.
  assert.deepEqual(buildUpdate({ ...base, confirmedDelistings: [C.toLowerCase()] }).remove, [C]);
  // A confirmation the diff does not delist: refused.
  assert.throws(() => buildUpdate({ ...base, confirmedDelistings: [C, D] }), /which the diff does not delist/);
  // No removals, no confirmation needed.
  assert.doesNotThrow(() => buildUpdate({ ...base, current: parsed.addresses }));
  // A corrupted listed address (one char changed) cannot become a silent delisting.
  const corrupted = FIXTURE.toString('utf8').replace(/1CAb8177ACe78b1B6B1c393371F4f2dCAE40CbEB/gi, '1CAb8177ACe78b1B6B1c393371F4f2dCAE40CbEZ');
  const p2 = parseSdnAdvanced(corrupted);
  assert.throws(() => buildUpdate({ parsed: p2, sourceHash: sourceHash(Buffer.from(corrupted)), current: [...p2.addresses, A], currentVersion: 1, ...FRESH }), /does not name/);
});

test('references: reliability must be one of OFAC\'s four values, with False defined', () => {
  const xml = FIXTURE.toString('utf8');
  assert.throws(() => parseSdnAdvanced(xml.replace('>False</Reliability>', '>FALSE</Reliability>')), /not one of Confirmed, False, Reported, Unknown/);
  assert.throws(() => parseSdnAdvanced(xml.replace('<Reliability ID="1561">False</Reliability>', '')), /does not define|which no <Reliability> defines|defined as False/);
});

