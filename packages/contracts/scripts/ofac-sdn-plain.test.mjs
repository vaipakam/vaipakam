// ofac-sdn-plain.test.mjs — #2443: OFAC's plain SDN.XML as the delister's
// second witness, against the committed fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSdnAdvancedFile } from './ofac-sanctions-diff.mjs';
import { createSdnPlainParser, parseSdnPlainFile, parseSdnPlainStream, plainWitness } from './ofac-sdn-plain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAIN = join(HERE, 'fixtures', 'sdn_plain.sample.xml');
const ADVANCED = join(HERE, 'fixtures', 'sdn_advanced.sample.xml');
const XML = readFileSync(PLAIN, 'utf8');

const parse = (xml) => {
  const p = createSdnPlainParser();
  p.write(xml);
  return p.end();
};
const without = (s, from, to) => {
  const i = s.indexOf(from);
  const j = s.indexOf(to, i) + to.length;
  assert.ok(i >= 0 && j > i, `fixture carries ${from}`);
  return s.slice(0, i) + s.slice(j);
};

test('parses the fixture: date, record count, every EVM digital-currency address', async () => {
  const { parsed, sourceHash, byteLength } = await parseSdnPlainFile(PLAIN);
  assert.equal(parsed.publicationDate, 20260307);
  assert.equal(parsed.recordCount, 3);
  assert.deepEqual(parsed.addresses, ['0x1111111111111111111111111111111111111111', '0x1CAb8177ACe78b1B6B1c393371F4f2dCAE40CbEB', '0x252A8Bd2319d8A555b872990601221B3a2053Bce']);
  // A 0x value under a non-currency id type is not a digital-currency record.
  assert.deepEqual(parsed.malformed, []);
  assert.match(sourceHash, /^0x[0-9a-f]{64}$/);
  assert.equal(byteLength, Buffer.byteLength(XML));
});

test('the result does not depend on where the input is cut', async () => {
  const whole = parse(XML);
  const bytes = Buffer.from(XML);
  async function* pieces(n) {
    for (let i = 0; i < bytes.length; i += n) yield bytes.subarray(i, i + n);
  }
  for (const n of [1, 7, 41, 1000]) {
    const { parsed } = await parseSdnPlainStream(pieces(n));
    assert.deepEqual(parsed, whole, `cut every ${n} bytes`);
  }
});

test('refuses a file whose declared record count differs from its entries', () => {
  const short = without(XML, '<sdnEntry>\n    <uid>38</uid>', '</sdnEntry>\n');
  assert.throws(() => parse(short), /declares 3 records but carries 2/);
});

test('refuses a truncated file, another document, and a moved or unreadable record', () => {
  assert.throws(() => parse(XML.slice(0, XML.length - 40)), /incomplete XML|never closed/);
  assert.throws(() => parse(XML.replace('exports/XML">', 'exports/XMLX">')), /unexpected element <sdnList> in namespace/);
  assert.throws(() => parse(XML.replace('<sdnList ', '<other ').replace('</sdnList>', '</other>')), /unexpected root element/);
  // An idNumber outside its <id> is a record that moved.
  const moved = XML.replace('<uid>38</uid>', '<uid>38</uid>\n    <idNumber>0x2222222222222222222222222222222222222222</idNumber>');
  assert.throws(() => parse(moved), /<idNumber> found at sdnList\/sdnEntry\/idNumber/);
  const noNumber = XML.replace('<idNumber>0x1111111111111111111111111111111111111111</idNumber>', '');
  assert.throws(() => parse(noNumber), /carries no <idNumber>/);
  const twoNumbers = XML.replace('<idNumber>0x1111111111111111111111111111111111111111</idNumber>', '<idNumber>0x1111111111111111111111111111111111111111</idNumber><idNumber>0x2</idNumber>');
  assert.throws(() => parse(twoNumbers), /two <idNumber>/);
  const foreign = XML.replace('<uid>38</uid>', '<uid>38</uid><x:note xmlns:x="urn:x">hi</x:note>');
  assert.throws(() => parse(foreign), /namespace "urn:x"/);
});

test('refuses an ambiguous or impossible publication date, and an empty list', () => {
  assert.throws(() => parse(XML.replace('<Record_Count>', '<Publish_Date>03/08/2026</Publish_Date><Record_Count>')), /Publish_Date> appears more than once/);
  assert.throws(() => parse(XML.replace('03/07/2026', '02/30/2026')), /not a valid date/);
  assert.throws(() => parse(XML.replace('03/07/2026', '2026-03-07')), /no readable <Publish_Date>/);
  const noEvm = XML.replaceAll(/<idNumber>0x[0-9a-fA-F]{40}<\/idNumber>/g, '<idNumber>TNotEvm</idNumber>');
  assert.throws(() => parse(noEvm), /no EVM-format digital-currency address/);
});

test('refuses bytes that are not valid UTF-8', async () => {
  const bytes = Buffer.from(XML);
  const at = bytes.indexOf('SAMPLE');
  bytes[at] = 0xff;
  await assert.rejects(parseSdnPlainStream([bytes]), /not valid UTF-8/);
});

test('plainWitness: checks the two files agree, then splits delistings by whether the plain file still mentions them', async () => {
  // The advanced fixture carries malformed values on purpose (its own test
  // covers them); with them, no delisting is judged at all — see below.
  const { parsed: fixture } = await parseSdnAdvancedFile(ADVANCED);
  const advanced = { ...fixture, malformed: [] };
  const plain = parse(XML);
  const gone = '0x000000000000000000000000000000000000dEaD';
  // 0x1111… is a False-reliability record in the advanced file, listed in
  // the plain file: allowed, and still mentioned.
  assert.deepEqual(plainWitness(plain, advanced, [gone, '0x1111111111111111111111111111111111111111']), {
    absent: [gone],
    stillMentioned: ['0x1111111111111111111111111111111111111111'],
  });
  // Mentioned anywhere counts — a remark, in any case.
  const remark = parse(XML.replace('<uid>38</uid>', '<uid>38</uid><remarks>was 0x000000000000000000000000000000000000DEAD</remarks>'));
  assert.deepEqual(plainWitness(remark, advanced, [gone]).stillMentioned, [gone]);
  // A mention split across decoded pieces of one value — text then CDATA, or
  // around a comment — is still a mention, wherever the input is cut.
  for (const split of ['0x00000000000000000000<![CDATA[0000000000000000dEaD]]>', '0x00000000000000000000<!-- x -->0000000000000000dEaD']) {
    const xml = XML.replace('<uid>38</uid>', `<uid>38</uid><remarks>${split}</remarks>`);
    assert.deepEqual(plainWitness(parse(xml), advanced, [gone]).stillMentioned, [gone], split);
    const { parsed } = await parseSdnPlainStream((function* () {
      const bytes = Buffer.from(xml);
      for (let i = 0; i < bytes.length; i += 13) yield bytes.subarray(i, i + 13);
    })());
    assert.deepEqual(plainWitness(parsed, advanced, [gone]).stillMentioned, [gone], `${split}, cut every 13 bytes`);
  }
  assert.throws(() => plainWitness({ ...plain, publicationDate: 20260308 }, advanced, []), /plain SDN file is publication 20260308 but the advanced file is 20260307/);
  const missing = parse(XML.replace('0x252a8bd2319d8a555b872990601221b3a2053bce', 'TNotEvm'));
  assert.throws(() => plainWitness(missing, advanced, []), /advanced file lists 0x252A8Bd2319d8A555b872990601221B3a2053Bce, which the plain file does not/);
  const extra = parse(XML.replace('<uid>196541</uid>\n        <idType>Digital Currency Address - TRX</idType>\n        <idNumber>TJ5usJLLwjwn7Pw3TPbdzreG7dvgKzfQ5y', '<uid>196541</uid>\n        <idType>Digital Currency Address - ETH</idType>\n        <idNumber>0x3333333333333333333333333333333333333333'));
  assert.throws(() => plainWitness(extra, advanced, []), /plain file lists 0x3333333333333333333333333333333333333333, which the advanced file does not/);
});

test('plainWitness: a value either file cannot read as an address stops every unattended delisting', async () => {
  const { parsed: fixture } = await parseSdnAdvancedFile(ADVANCED);
  const advanced = { ...fixture, malformed: [] };
  const gone = '0x000000000000000000000000000000000000dEaD';
  // A damaged 39-digit copy of the address being delisted, as a currency
  // record in the plain file: the 40-digit witness cannot see it, so the
  // parser's own "could not read this" is what stops the delisting.
  const damaged = parse(XML.replace('<uid>196541</uid>\n        <idType>Digital Currency Address - TRX</idType>\n        <idNumber>TJ5usJLLwjwn7Pw3TPbdzreG7dvgKzfQ5y', '<uid>196541</uid>\n        <idType>Digital Currency Address - ETH</idType>\n        <idNumber>0x000000000000000000000000000000000000dEa'));
  assert.deepEqual(damaged.malformed, [{ value: '0x000000000000000000000000000000000000dEa', asset: 'ETH' }]);
  assert.throws(() => plainWitness(damaged, advanced, [gone]), /refusing an unattended delisting: .*"0x000000000000000000000000000000000000dEa" \(ETH, plain file\).*a person must review/s);
  // The advanced file's malformed values stop it just the same, named.
  assert.throws(() => plainWitness(parse(XML), fixture, [gone]), /3 digital-currency value\(s\).*"0x123" \(ETH, advanced file\).*"0X1CAb8177ACe78b1B6B1c393371F4f2dCAE40CbEB" \(ARB, advanced file\)/s);
  // Nothing to delist: nothing to judge.
  assert.deepEqual(plainWitness(damaged, fixture, []), { absent: [], stillMentioned: [] });
  // A parse with no malformed list is not trusted to have none.
  const { malformed, ...unlisted } = parse(XML);
  assert.throws(() => plainWitness(unlisted, advanced, []), /no malformed-value list/);
});
