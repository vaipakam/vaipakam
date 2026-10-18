/**
 * #2443 — OFAC's PLAIN SDN list (`SDN.XML`), read as the sanctions delister's
 * SECOND witness that an address left the list.
 *
 * The list records each publication by the SHA-256 of Treasury's SDN Advanced
 * XML, and the diff tool reads that file. A delisting is the one change an
 * unattended key may only PROPOSE, and the advanced file alone cannot tell a
 * record OFAC removed from one the file lost or the parser dropped (Codex
 * #2543 r14–r21). The legacy `SDN.XML` is a separate export of the same
 * publication, in a different schema, so it is read here by its own
 * extraction and asked the same question independently: an address the
 * delister proposes must be ABSENT from it too (owner decision D-C,
 * 2026-10-18, docs/DesignsAndPlans/SanctionsDelistingTimelockDesign.md).
 *
 * What is shared with the advanced parser, and what is not: the TOKENIZER
 * (`createXmlScanner` — the structural well-formedness pass: every tag
 * terminated, every element closed in order, one root, no DOCTYPE, invalid
 * UTF-8 refused) is the same code, since a second tokenizer would be a second
 * set of XML rules to get wrong. The EXTRACTION — which paths are read, what
 * a record is, what the publication date is — is written separately against
 * this schema.
 *
 * WHAT IT REFUSES, AND WHY:
 *   - A root other than OFAC's `sdnList` in its exact namespace, and any
 *     element outside that namespace: a different document, or a revised
 *     schema, is not what these paths were checked against.
 *   - A file whose declared `Record_Count` differs from the `sdnEntry`
 *     elements it carries. The plain file states its own size, so a
 *     truncated or spliced copy that is still well-formed is caught here —
 *     and a SHORT file is exactly the failure that would make every address
 *     look "absent".
 *   - A missing or repeated `Publish_Date` / `Record_Count`, or a date that
 *     is not a real calendar day.
 *   - A digital-currency id with no `idNumber`: a record it cannot read is
 *     refused, never skipped.
 *   - A node of the record structure (`idList`, `id`, `idType`, `idNumber`,
 *     `sdnEntry`, `publshInformation`, …) found anywhere but on its path, so a
 *     moved record refuses the file instead of vanishing from it.
 *   - A file with no EVM-format digital-currency address at all.
 *
 * {@link plainWitness} then compares the two files and splits a proposed set
 * of delistings into those absent from the plain file and those it still
 * mentions.
 */
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { getAddress } from 'viem';
import { createXmlScanner, isPublicationDate } from './ofac-sanctions-diff.mjs';

export const OFAC_SDN_PLAIN_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML';
/** The plain file's root namespace, matched exactly. */
export const OFAC_SDN_PLAIN_NAMESPACE = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML';

const DCA_PREFIX = 'Digital Currency Address - ';
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_PREFIX_RE = /^0x/i;
const HEX_RUN_RE = /[0-9a-fA-F]{40,}/g;
const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const isHexDigit = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

/**
 * The ONLY paths read, as full paths from the root. In the 2026-10-15
 * publication each of these element names occurs only on its path.
 */
export const SDN_PLAIN_PATHS = Object.freeze({
  publishInformation: 'sdnList/publshInformation',
  publishDate: 'sdnList/publshInformation/Publish_Date',
  recordCount: 'sdnList/publshInformation/Record_Count',
  entry: 'sdnList/sdnEntry',
  idList: 'sdnList/sdnEntry/idList',
  id: 'sdnList/sdnEntry/idList/id',
  idType: 'sdnList/sdnEntry/idList/id/idType',
  idNumber: 'sdnList/sdnEntry/idList/id/idNumber',
});

/** Every element name on a read path, mapped to the one path it may sit on. */
const ANCHORED = new Map(Object.values(SDN_PLAIN_PATHS).map((p) => [p.slice(p.lastIndexOf('/') + 1), p]));
/** Paths that must appear exactly once. */
const SINGLETONS = new Set([SDN_PLAIN_PATHS.publishInformation, SDN_PLAIN_PATHS.publishDate, SDN_PLAIN_PATHS.recordCount]);

/**
 * The plain-file parser, fed decoded text in pieces: `write(chunk)`, then
 * `end()` returns the parse. Wherever the pieces are cut, the result is that
 * of one whole-document pass (the tokenizer's guarantee).
 */
export function createSdnPlainParser() {
  const path = [];
  const hexRuns = { raw: [], text: [] };
  let hexTail = '';
  const countRaw = (s) => {
    for (const run of s.match(HEX_RUN_RE) ?? []) hexRuns.raw.push(run.toLowerCase());
  };
  const seen = new Map();
  let publishDate;
  let recordCount;
  let entries = 0;
  let id = null; // { type, number } of the <id> being read
  let reading = null;
  let buf = null;
  const evm = new Map(); // lowercase -> checksummed
  const malformed = [];

  const scanner = createXmlScanner(
    {
      open(name, attrs, depth, ns) {
        if (ns !== OFAC_SDN_PLAIN_NAMESPACE) {
          throw new Error(`unexpected element <${name}> in namespace ${JSON.stringify(ns)} — OFAC's SDN.XML carries only elements in ${OFAC_SDN_PLAIN_NAMESPACE}`);
        }
        path.push(name);
        const at = path.join('/');
        if (reading) throw new Error(`unexpected <${name}> inside <${reading}>`);
        const anchor = ANCHORED.get(name);
        if (anchor !== undefined && anchor !== at) {
          throw new Error(`<${name}> found at ${at}, but the schema places it only at ${anchor} — refusing a file whose records may have moved`);
        }
        if (SINGLETONS.has(at)) {
          const n = (seen.get(at) ?? 0) + 1;
          if (n > 1) throw new Error(`<${at}> appears more than once — refusing an ambiguous publication`);
          seen.set(at, n);
        }
        switch (at) {
          case SDN_PLAIN_PATHS.publishDate:
          case SDN_PLAIN_PATHS.recordCount:
          case SDN_PLAIN_PATHS.idType:
          case SDN_PLAIN_PATHS.idNumber:
            reading = at;
            buf = '';
            break;
          case SDN_PLAIN_PATHS.entry:
            entries++;
            break;
          case SDN_PLAIN_PATHS.id:
            id = { type: undefined, number: undefined };
            break;
          default:
        }
      },
      text(value) {
        if (reading) buf += value;
        for (const run of value.match(HEX_RUN_RE) ?? []) hexRuns.text.push(run.toLowerCase());
      },
      close() {
        const at = path.join('/');
        path.pop();
        if (reading === at) {
          const value = buf.trim();
          if (at === SDN_PLAIN_PATHS.publishDate) publishDate = value;
          else if (at === SDN_PLAIN_PATHS.recordCount) recordCount = value;
          else if (at === SDN_PLAIN_PATHS.idType) {
            if (id.type !== undefined) throw new Error('an <id> carries two <idType> elements');
            id.type = value;
          } else {
            if (id.number !== undefined) throw new Error('an <id> carries two <idNumber> elements');
            id.number = value;
          }
          reading = null;
          buf = null;
        } else if (at === SDN_PLAIN_PATHS.id) {
          if (id.type?.startsWith(DCA_PREFIX)) {
            const asset = id.type.slice(DCA_PREFIX.length);
            if (!id.number) throw new Error(`a "${id.type}" <id> carries no <idNumber> — refusing a file whose digital-currency records do not resolve`);
            if (EVM_RE.test(id.number)) {
              const a = getAddress(id.number.toLowerCase());
              evm.set(a.toLowerCase(), a);
            } else if (HEX_PREFIX_RE.test(id.number)) malformed.push({ value: id.number, asset });
          }
          id = null;
        }
      },
    },
    'sdnList',
  );

  return {
    write(chunk) {
      const joined = hexTail + chunk;
      let cut = joined.length;
      while (cut > 0 && isHexDigit(joined.charCodeAt(cut - 1))) cut--;
      countRaw(joined.slice(0, cut));
      hexTail = joined.slice(cut);
      scanner.write(chunk);
    },
    end() {
      countRaw(hexTail);
      hexTail = '';
      scanner.end();
      const m = DATE_RE.exec(publishDate ?? '');
      if (!m) throw new Error(`no readable <Publish_Date> (got ${JSON.stringify(publishDate ?? null)}) — cannot identify the publication`);
      const publicationDate = Number(m[3]) * 10000 + Number(m[1]) * 100 + Number(m[2]);
      if (!isPublicationDate(publicationDate)) throw new Error(`<Publish_Date> ${publishDate} is not a valid date`);
      if (!/^\d+$/.test(recordCount ?? '')) throw new Error(`no readable <Record_Count> (got ${JSON.stringify(recordCount ?? null)})`);
      if (Number(recordCount) !== entries) {
        throw new Error(`the file declares ${recordCount} records but carries ${entries} <sdnEntry> elements — refusing a truncated or altered file`);
      }
      if (evm.size === 0) throw new Error('no EVM-format digital-currency address found — refusing an empty list');
      const addresses = [...evm.values()].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
      return { publicationDate, recordCount: entries, addresses, malformed, hexRuns };
    },
  };
}

/** Parse the plain file from its bytes as they arrive (any async iterable of
 *  byte chunks), hashing exactly what is parsed and refusing invalid UTF-8. */
export async function parseSdnPlainStream(chunks) {
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parser = createSdnPlainParser();
  let byteLength = 0;
  const decode = (bytes, stream) => {
    try {
      return decoder.decode(bytes, { stream });
    } catch {
      throw new Error('the plain SDN file is not valid UTF-8 — refusing a file whose bytes were corrupted');
    }
  };
  for await (const chunk of chunks) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    hash.update(bytes);
    byteLength += bytes.length;
    parser.write(decode(bytes, true));
  }
  parser.write(decode(undefined, false));
  return { parsed: parser.end(), sourceHash: `0x${hash.digest('hex')}`, byteLength };
}

/** {@link parseSdnPlainStream} over a file on disk, in 1 MiB pieces. */
export function parseSdnPlainFile(path) {
  return parseSdnPlainStream(createReadStream(path, { highWaterMark: 1 << 20 }));
}

/**
 * The plain file's verdict on a set of proposed delistings, after checking
 * that the two files describe the same publication:
 *   - the same publication date;
 *   - every EVM address the advanced file lists is in the plain file (a plain
 *     file missing one is incomplete, and its "absent" would mean nothing);
 *   - every EVM address the plain file lists is in the advanced file, or is
 *     one the advanced file carries only as OFAC-marked False records (the
 *     plain schema has no reliability field).
 * A disagreement throws: two exports of one publication that differ are not
 * a basis for an unattended delisting.
 *
 * Returns `{ absent, stillMentioned }`. An address is absent only when its 40
 * hex digits appear NOWHERE in the plain file, in the raw text or in decoded
 * text — the advanced file's witness rule, applied with no exceptions here.
 */
export function plainWitness(plain, advanced, removals) {
  if (plain.publicationDate !== advanced.publicationDate) {
    throw new Error(`the plain SDN file is publication ${plain.publicationDate} but the advanced file is ${advanced.publicationDate} — OFAC published between the two downloads, or one is stale`);
  }
  const p = new Set(plain.addresses.map((a) => a.toLowerCase()));
  const adv = new Set(advanced.addresses.map((a) => a.toLowerCase()));
  const falseOnly = new Set((advanced.excludedFalse ?? []).map((e) => e.address.toLowerCase()));
  const missing = advanced.addresses.filter((a) => !p.has(a.toLowerCase()));
  const extra = plain.addresses.filter((a) => !adv.has(a.toLowerCase()) && !falseOnly.has(a.toLowerCase()));
  if (missing.length || extra.length) {
    const parts = [];
    if (missing.length) parts.push(`the advanced file lists ${missing.join(', ')}, which the plain file does not`);
    if (extra.length) parts.push(`the plain file lists ${extra.join(', ')}, which the advanced file does not`);
    throw new Error(`the two OFAC files disagree: ${parts.join('; ')}`);
  }
  const mentioned = (body) => plain.hexRuns.raw.some((r) => r.includes(body)) || plain.hexRuns.text.some((r) => r.includes(body));
  const absent = [];
  const stillMentioned = [];
  for (const a of removals) (mentioned(a.toLowerCase().slice(2)) ? stillMentioned : absent).push(a);
  return { absent, stillMentioned };
}
