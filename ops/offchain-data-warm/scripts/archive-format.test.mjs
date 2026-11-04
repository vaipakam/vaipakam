/**
 * node:test suite for the public-key archive format (#1463; design:
 * docs/DesignsAndPlans/BackupSecurityDesign.md §3).
 *
 * The committed recipients are checked as committed; everything that needs a
 * private key uses keys generated here, because the real ones are offline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  ARCHIVE_MAGIC,
  GCM_TAG_BYTES,
  MAX_HEADER_BYTES,
  MAX_RECIPIENTS,
  PK_SCHEME,
  PREFIX_BYTES,
  encodeHeader,
  headerAgreement,
  importRecipientKey,
  parseArchiveHeader,
  parseRecipientsFile,
  recipientSetAt,
  sealArchive,
  toBase64,
} from '../src/archiveFormat.ts';
import { ARCHIVE_FORMAT_OVERHEAD_BYTES } from '../src/limits.ts';
import { openArchive } from './decrypt-archive.mjs';
import { recipientsFile, testRecipient } from './test-helpers/keys.mjs';

const committed = JSON.parse(readFileSync(new URL('../backup-recipients/recipients.json', import.meta.url), 'utf8'));
const A = testRecipient('a');
const B = testRecipient('b');
const SET_A = { set: 1, effectiveFrom: '2026-11-01T00:00:00.000Z', recipients: [A.recipient] };
const CREATED = '2026-11-10T03:17:00.000Z';
const UPLOADED = Date.parse(CREATED) + 60_000;
const text = (s) => new TextEncoder().encode(s);
const payload = text(JSON.stringify({ version: 1, createdAt: CREATED }));
const seal = (over = {}) => sealArchive({ set: SET_A, plaintext: payload, tier: 'daily', period: '2026-11-10', createdAt: CREATED, ...over });

// ── The committed recipients ────────────────────────────────────────────

test('the committed recipients validate, and every fingerprint is its key\'s RSA-4096 SPKI', async () => {
  const file = parseRecipientsFile(committed);
  assert.ok(file.sets.length >= 1);
  for (const set of file.sets) {
    // Two recipients from the start: losing every private key loses every archive.
    assert.ok(set.recipients.length >= 2, `set ${set.set} has fewer than two recipients`);
    for (const r of set.recipients) {
      const der = Buffer.from(r.spki, 'base64');
      assert.equal(createHash('sha256').update(der).digest('hex'), r.fingerprint, r.name);
      await importRecipientKey(r);
    }
  }
});

test('a fingerprint that is not its key\'s, or a key that is not RSA-4096, is refused', async () => {
  await assert.rejects(importRecipientKey({ ...A.recipient, fingerprint: B.recipient.fingerprint }), /not its key's/);
  const { generateKeyPairSync } = await import('node:crypto');
  const small = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' });
  await assert.rejects(
    importRecipientKey({ name: 'small', fingerprint: createHash('sha256').update(small).digest('hex'), spki: small.toString('base64') }),
    /RSA-4096/,
  );
});

test('the recipients file is append-only in shape: numbered in order, later sets later', () => {
  const ok = recipientsFile([
    { effectiveFrom: '2026-11-01T00:00:00.000Z', recipients: [A.recipient] },
    { effectiveFrom: '2026-12-01T00:00:00.000Z', recipients: [A.recipient, B.recipient] },
  ]);
  parseRecipientsFile(ok);
  const bad = (mut) => {
    const f = structuredClone(ok);
    mut(f);
    return () => parseRecipientsFile(f);
  };
  assert.throws(bad((f) => (f.sets[1].set = 3)), /numbered/);
  assert.throws(bad((f) => (f.sets[1].effectiveFrom = '2026-10-01T00:00:00.000Z')), /after set 1/);
  assert.throws(bad((f) => (f.sets[1].effectiveFrom = '2026-12-01')), /ISO-8601/);
  assert.throws(bad((f) => f.sets[1].recipients.push(A.recipient)), /invalid or repeated/);
  assert.throws(bad((f) => (f.sets[0].recipients[0].extra = 1)), /exactly name/);
  assert.throws(bad((f) => (f.sets = [])), /no recipient set/);
  assert.throws(bad((f) => (f.sets[0].recipients = Array(MAX_RECIPIENTS + 1).fill(A.recipient))), /recipients/);
});

test('the set in force is the newest one already in effect, and none before the first', () => {
  const f = parseRecipientsFile(recipientsFile([
    { effectiveFrom: '2026-11-01T00:00:00.000Z', recipients: [A.recipient] },
    { effectiveFrom: '2026-12-01T00:00:00.000Z', recipients: [B.recipient] },
  ]));
  assert.equal(recipientSetAt(f, Date.UTC(2026, 9, 31)), null);
  assert.equal(recipientSetAt(f, Date.UTC(2026, 10, 1)).set, 1);
  assert.equal(recipientSetAt(f, Date.UTC(2026, 11, 1)).set, 2);
});

// ── The format ──────────────────────────────────────────────────────────

test('a sealed archive opens with its recipient key and states its tier, period and time', async () => {
  const sealed = await seal();
  assert.deepEqual([...sealed.subarray(0, ARCHIVE_MAGIC.length)], [...ARCHIVE_MAGIC]);
  const parsed = parseArchiveHeader(sealed);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.header.scheme, PK_SCHEME);
  assert.deepEqual([parsed.header.tier, parsed.header.period, parsed.header.createdAt], ['daily', '2026-11-10', CREATED]);
  assert.deepEqual(parsed.header.recipients.map((r) => r.fingerprint), [A.recipient.fingerprint]);
  const opened = await openArchive(sealed, { privateKey: A.privateKey });
  assert.deepEqual([...opened.plaintext], [...payload]);
});

test('nobody but a recipient opens it, and no header byte can change without the decryption failing', async () => {
  const sealed = await seal();
  await assert.rejects(openArchive(sealed, { privateKey: B.privateKey }), /not a recipient/);
  // The period, in the authenticated header, rewritten in place.
  const parsed = parseArchiveHeader(sealed);
  const header = { ...parsed.header, period: '2026-11-09', createdAt: '2026-11-09T03:17:00.000Z' };
  const forged = new Uint8Array([...encodeHeader(header), ...sealed.subarray(parsed.bodyOffset)]);
  await assert.rejects(openArchive(forged, { privateKey: A.privateKey }), /does not decrypt/);
  const flipped = Uint8Array.from(sealed);
  flipped[flipped.length - 1] ^= 1;
  await assert.rejects(openArchive(flipped, { privateKey: A.privateKey }), /does not decrypt/);
});

test('the same plaintext sealed twice gives unrelated archives, so a January pair is never equal', async () => {
  const monthly = await seal({ tier: 'monthly', period: '2027-01', createdAt: '2027-01-01T03:17:00.000Z' });
  const yearly = await seal({ tier: 'yearly', period: '2027', createdAt: '2027-01-01T03:17:00.000Z' });
  const ivOf = (a) => parseArchiveHeader(a).header.iv;
  assert.notEqual(ivOf(monthly), ivOf(yearly));
  assert.notEqual(Buffer.from(monthly).toString('hex'), Buffer.from(yearly).toString('hex'));
});

test('a period that is not the run\'s own is refused at sealing', async () => {
  await assert.rejects(seal({ period: '2026-11-09' }), /not the daily period/);
});

test('every way a header can be malformed is refused by name', async () => {
  const sealed = await seal();
  const parsed = parseArchiveHeader(sealed);
  const withHeader = (h) => new Uint8Array([...encodeHeader(h), ...new Uint8Array(GCM_TAG_BYTES)]);
  const rawHeader = (json) => {
    const b = text(json);
    const out = new Uint8Array(PREFIX_BYTES + b.length + GCM_TAG_BYTES);
    out.set(ARCHIVE_MAGIC);
    new DataView(out.buffer).setUint32(ARCHIVE_MAGIC.length, b.length);
    out.set(b, PREFIX_BYTES);
    return out;
  };
  const h = parsed.header;
  const cases = [
    [Buffer.from('random bytes, no magic'), /magic/],
    [sealed.subarray(0, 9), /header length/],
    [sealed.subarray(0, parsed.bodyOffset - 1), /inside the header/],
    [sealed.subarray(0, parsed.bodyOffset + 3), /GCM tag/],
    [rawHeader('{'), /not UTF-8 JSON/],
    [withHeader({ ...h, scheme: 'other' }), /another scheme/],
    [withHeader({ ...h, iv: toBase64(new Uint8Array(8)) }), /IV/],
    [withHeader({ ...h, createdAt: '2026-11-10' }), /createdAt/],
    // The right shape and no such time: refused, never thrown (Codex #3152 r1).
    [withHeader({ ...h, createdAt: '2026-13-04T03:17:00.000Z' }), /createdAt/],
    [withHeader({ ...h, createdAt: '2026-02-30T03:17:00.000Z' }), /createdAt/],
    [withHeader({ ...h, tier: 'weekly' }), /tier/],
    [withHeader({ ...h, period: '2026-11' }), /period/],
    [withHeader({ ...h, recipients: [] }), /recipients/],
    [withHeader({ ...h, recipients: [h.recipients[0], h.recipients[0]] }), /twice/],
    [withHeader({ ...h, recipients: [{ ...h.recipients[0], wrappedKey: 'AAAA' }] }), /wrapped key/],
    [rawHeader(JSON.stringify({ ...h, extra: 1 })), /exactly the format fields/],
  ];
  for (const [bytes, why] of cases) {
    const r = parseArchiveHeader(bytes);
    assert.equal(r.ok, false, String(why));
    assert.match(r.reason, why);
  }
  const huge = new Uint8Array(PREFIX_BYTES + 4);
  huge.set(ARCHIVE_MAGIC);
  new DataView(huge.buffer).setUint32(ARCHIVE_MAGIC.length, MAX_HEADER_BYTES + 1);
  assert.match(parseArchiveHeader(huge, 1e9).reason, /outside/);
});

test('the header is judged against the archive\'s name, its upload time and the set in force then', async () => {
  const file = parseRecipientsFile(recipientsFile([
    { effectiveFrom: '2026-11-01T00:00:00.000Z', recipients: [A.recipient] },
    { effectiveFrom: '2026-11-10T03:17:30.000Z', recipients: [B.recipient] },
  ]));
  const { header } = parseArchiveHeader(await seal());
  const known = { tier: 'daily', period: '2026-11-10', uploadedMs: UPLOADED, file };
  // Set 2 took effect mid-run: the set at the run's start still passes.
  assert.deepEqual(headerAgreement(header, known), { verdict: 'ok' });
  assert.equal(headerAgreement(header, { ...known, period: '2026-11-09' }).verdict, 'wrong-period');
  assert.equal(headerAgreement(header, { ...known, uploadedMs: UPLOADED + 2 * 3_600_000 }).verdict, 'wrong-period');
  assert.equal(headerAgreement(header, { ...known, uploadedMs: Date.parse(CREATED) - 3_600_000 }).verdict, 'wrong-period');
  // Written to set 1 a day after set 2 took over: a wrong-key write.
  const late = parseArchiveHeader(await seal({ period: '2026-11-11', createdAt: '2026-11-11T03:17:00.000Z' })).header;
  assert.equal(headerAgreement(late, { ...known, period: '2026-11-11', uploadedMs: Date.parse('2026-11-11T03:18:00.000Z') }).verdict, 'wrong-recipients');
  // A subset or a superset of the set is not the set.
  const both = parseArchiveHeader(await seal({ set: { ...SET_A, recipients: [A.recipient, B.recipient] } })).header;
  assert.equal(headerAgreement(both, known).verdict, 'wrong-recipients');
});

test('the stored-size bound covers the largest header the format allows', () => {
  assert.equal(ARCHIVE_FORMAT_OVERHEAD_BYTES, PREFIX_BYTES + MAX_HEADER_BYTES + GCM_TAG_BYTES);
});

test('a header with the most recipients a set may hold is within the bound', async () => {
  const many = Array.from({ length: MAX_RECIPIENTS }, (_, i) => ({ ...A.recipient, name: `r${i}`, fingerprint: createHash('sha256').update(String(i)).digest('hex') }));
  const h = { ...parseArchiveHeader(await seal()).header };
  h.recipients = many.map((r) => ({ fingerprint: r.fingerprint, wrappedKey: h.recipients[0].wrappedKey }));
  assert.ok(encodeHeader(h).length <= PREFIX_BYTES + MAX_HEADER_BYTES);
});
