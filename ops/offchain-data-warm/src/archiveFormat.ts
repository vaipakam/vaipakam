/**
 * The public-key archive format (#1463; design:
 * docs/DesignsAndPlans/BackupSecurityDesign.md §3).
 *
 * WHAT IT IS. Each archive gets a fresh random AES-256-GCM data key. The
 * Worker wraps that key with RSA-OAEP (4096-bit modulus, SHA-256) once for
 * each recipient in the set in force, then drops it. Nothing the Worker holds
 * can unwrap it again, so the Worker cannot decrypt anything it wrote. The
 * private keys live offline and never reach Cloudflare, GitHub or any server.
 *
 *   7 bytes   magic `VPKARC` + version byte 0x02
 *   4 bytes   header length n, big-endian
 *   n bytes   header, UTF-8 JSON (`ArchiveHeader`)
 *   rest      AES-256-GCM ciphertext followed by its 16-byte tag
 *
 * The whole prefix and header, magic included, is the GCM additional
 * authenticated data, so nobody without the data key can change a genuine
 * archive's stated period or recipients without the decryption failing. That
 * is all the header authentication buys: anyone holding the public keys can
 * build a new archive with any header. Telling a forged archive from a
 * genuine one is the ledger's job (design §5), not the format's.
 *
 * WHO USES THIS MODULE. The Worker seals with it; the backup watcher and the
 * offline `scripts/decrypt-archive.mjs` parse the header with the same code,
 * so the three cannot disagree about what a well-formed archive is. It
 * imports nothing, so `node --experimental-strip-types` loads it without the
 * Worker bundler, and uses only WebCrypto, which both runtimes provide. The
 * decryption itself lives in the offline tool: no code that opens an archive,
 * old format or new, is part of the Worker.
 */

/** `VPKARC` followed by the format version, 2. */
export const ARCHIVE_MAGIC = Uint8Array.of(0x56, 0x50, 0x4b, 0x41, 0x52, 0x43, 0x02);
/** The magic and the four-byte header length. */
export const PREFIX_BYTES = ARCHIVE_MAGIC.length + 4;
/** The scheme every header names, and every manifest declares. */
export const PK_SCHEME = 'RSA-OAEP-256/A256GCM';
/**
 * The largest header the Worker writes and the watcher accepts. A header with
 * two recipients is about 1.6 KB; this leaves room for a rotation overlap and
 * stays small enough that the watcher never holds more than this of an
 * archive in memory to check it.
 */
export const MAX_HEADER_BYTES = 16_384;
/** The most recipients one set may hold, which keeps a header under the bound. */
export const MAX_RECIPIENTS = 8;
export const IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;
export const RSA_MODULUS_BITS = 4096;
/** An RSA-OAEP output is exactly one modulus long. */
export const WRAPPED_KEY_BYTES = RSA_MODULUS_BITS / 8;

export type ArchiveTier = 'daily' | 'monthly' | 'yearly';
const TIERS: readonly ArchiveTier[] = ['daily', 'monthly', 'yearly'];

export interface HeaderRecipient {
  /** SHA-256 of the recipient public key's SPKI DER, lowercase hex. */
  fingerprint: string;
  /** The data key wrapped to that public key, base64. */
  wrappedKey: string;
}

export interface ArchiveHeader {
  scheme: typeof PK_SCHEME;
  /** The 12-byte GCM IV, base64. */
  iv: string;
  /** When the nightly run started, as the archive's plaintext also states it. */
  createdAt: string;
  tier: ArchiveTier;
  /** `YYYY-MM-DD`, `YYYY-MM` or `YYYY`, by tier. */
  period: string;
  recipients: HeaderRecipient[];
}

export interface Recipient {
  name: string;
  fingerprint: string;
  /** The public key's SPKI DER, base64 (a PEM body without its line breaks). */
  spki: string;
}

export interface RecipientSet {
  set: number;
  /** From when the Worker writes to this set, ISO-8601 UTC. */
  effectiveFrom: string;
  recipients: Recipient[];
}

export interface RecipientsFile {
  kind: 'vaipakam-backup-recipients';
  version: 1;
  sets: RecipientSet[];
}

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const PERIOD: Record<ArchiveTier, RegExp> = {
  daily: /^\d{4}-\d{2}-\d{2}$/,
  monthly: /^\d{4}-\d{2}$/,
  yearly: /^\d{4}$/,
};
const PERIOD_CHARS: Record<ArchiveTier, number> = { daily: 10, monthly: 7, yearly: 4 };

/** A canonical ISO-8601 UTC time with milliseconds, as `Date.toISOString` writes it. */
export function isIsoTime(s: unknown): s is string {
  return typeof s === 'string' && ISO_MS.test(s) && new Date(Date.parse(s)).toISOString() === s;
}

/** The period a run started at `createdAt` writes for `tier`. */
export function periodOfCreatedAt(tier: ArchiveTier, createdAt: string): string {
  return createdAt.slice(0, PERIOD_CHARS[tier]);
}

/** The bytes of canonical base64, or null for anything else. */
export function strictBase64(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  let bin: string;
  try {
    bin = atob(s);
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  // Canonical only: unused trailing bits set would decode to the same bytes
  // from a second spelling.
  return toBase64(out) === s ? out : null;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function exactKeys(o: unknown, keys: string[]): o is Record<string, unknown> {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return false;
  const got = Object.keys(o).sort();
  const want = [...keys].sort();
  return got.length === want.length && got.every((k, i) => k === want[i]);
}

/** Does `bytes` start with this format's magic? */
export function hasArchiveMagic(bytes: Uint8Array): boolean {
  return bytes.length >= ARCHIVE_MAGIC.length && ARCHIVE_MAGIC.every((b, i) => bytes[i] === b);
}

export type HeaderParse =
  | { ok: true; header: ArchiveHeader; aad: Uint8Array; bodyOffset: number }
  | { ok: false; reason: string };

/**
 * The header of an archive in this format, checked for shape only.
 *
 * `bytes` may be the whole archive or only its first
 * `PREFIX_BYTES + MAX_HEADER_BYTES` bytes (the watcher reads no more), so the
 * archive's full length is passed apart. Whether the header agrees with the
 * archive's name, its upload time and the recipient set in force is a
 * separate question (`headerAgreement`), because the restore and the watcher
 * ask it with different evidence.
 */
export function parseArchiveHeader(bytes: Uint8Array, totalLength: number = bytes.length): HeaderParse {
  if (!hasArchiveMagic(bytes)) return { ok: false, reason: 'it does not start with the format magic' };
  if (bytes.length < PREFIX_BYTES) return { ok: false, reason: 'it ends inside the header length' };
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(ARCHIVE_MAGIC.length, false);
  if (n === 0 || n > MAX_HEADER_BYTES) return { ok: false, reason: `its header length ${n} is outside 1..${MAX_HEADER_BYTES}` };
  if (bytes.length < PREFIX_BYTES + n) return { ok: false, reason: 'it ends inside the header' };
  if (totalLength < PREFIX_BYTES + n + GCM_TAG_BYTES) return { ok: false, reason: 'it is too short to hold a GCM tag after the header' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + n)));
  } catch {
    return { ok: false, reason: 'its header is not UTF-8 JSON' };
  }
  if (!exactKeys(parsed, ['scheme', 'iv', 'createdAt', 'tier', 'period', 'recipients'])) {
    return { ok: false, reason: 'its header does not carry exactly the format fields' };
  }
  const h = parsed;
  if (h.scheme !== PK_SCHEME) return { ok: false, reason: 'its header names another scheme' };
  if (strictBase64(h.iv)?.length !== IV_BYTES) return { ok: false, reason: `its IV is not ${IV_BYTES} bytes of base64` };
  if (!isIsoTime(h.createdAt)) return { ok: false, reason: 'its createdAt is not an ISO-8601 UTC time' };
  if (typeof h.tier !== 'string' || !TIERS.includes(h.tier as ArchiveTier)) return { ok: false, reason: 'its tier is not one the nightly writes' };
  const tier = h.tier as ArchiveTier;
  if (typeof h.period !== 'string' || !PERIOD[tier].test(h.period)) return { ok: false, reason: `its period is not a ${tier} period` };
  if (!Array.isArray(h.recipients) || h.recipients.length === 0 || h.recipients.length > MAX_RECIPIENTS) {
    return { ok: false, reason: `it does not name 1..${MAX_RECIPIENTS} recipients` };
  }
  const seen = new Set<string>();
  for (const r of h.recipients as unknown[]) {
    if (!exactKeys(r, ['fingerprint', 'wrappedKey']) || typeof r.fingerprint !== 'string' || !HEX64.test(r.fingerprint)) {
      return { ok: false, reason: 'a recipient entry is not a fingerprint and a wrapped key' };
    }
    if (seen.has(r.fingerprint)) return { ok: false, reason: 'it names one recipient twice' };
    seen.add(r.fingerprint);
    if (strictBase64(r.wrappedKey)?.length !== WRAPPED_KEY_BYTES) {
      return { ok: false, reason: `a wrapped key is not ${WRAPPED_KEY_BYTES} bytes of base64` };
    }
  }
  return {
    ok: true,
    header: h as unknown as ArchiveHeader,
    aad: bytes.slice(0, PREFIX_BYTES + n),
    bodyOffset: PREFIX_BYTES + n,
  };
}

/**
 * Validate `recipients.json` as parsed. Throws on anything the Worker or the
 * watcher must not act on: a set out of order, a duplicate key, a field the
 * file does not define. The fingerprints are checked against the keys by
 * `importRecipientKey`, which needs WebCrypto and so is async.
 */
export function parseRecipientsFile(json: unknown): RecipientsFile {
  const fail = (why: string): never => {
    throw new Error(`backup-recipients/recipients.json: ${why}`);
  };
  if (!exactKeys(json, ['kind', 'version', 'sets'])) fail('expected exactly kind, version and sets');
  const f = json as Record<string, unknown>;
  if (f.kind !== 'vaipakam-backup-recipients' || f.version !== 1) fail('not a version-1 recipients file');
  if (!Array.isArray(f.sets) || f.sets.length === 0) fail('it holds no recipient set');
  let previous = -Infinity;
  (f.sets as unknown[]).forEach((s, i) => {
    if (!exactKeys(s, ['set', 'effectiveFrom', 'recipients'])) fail(`set ${i + 1}: expected exactly set, effectiveFrom and recipients`);
    const set = s as Record<string, unknown>;
    // Sets are appended, never edited or removed, so their numbers are the
    // positions they were appended at.
    if (set.set !== i + 1) fail(`set ${i + 1} is numbered ${String(set.set)}`);
    if (!isIsoTime(set.effectiveFrom)) fail(`set ${i + 1}: effectiveFrom is not an ISO-8601 UTC time with milliseconds`);
    const from = Date.parse(set.effectiveFrom as string);
    if (!(from > previous)) fail(`set ${i + 1} does not take effect after set ${i}`);
    previous = from;
    if (!Array.isArray(set.recipients) || set.recipients.length === 0 || set.recipients.length > MAX_RECIPIENTS) {
      fail(`set ${i + 1}: expected 1..${MAX_RECIPIENTS} recipients`);
    }
    const names = new Set<string>();
    const prints = new Set<string>();
    for (const r of set.recipients as unknown[]) {
      if (!exactKeys(r, ['name', 'fingerprint', 'spki'])) fail(`set ${i + 1}: a recipient is not exactly name, fingerprint and spki`);
      const rr = r as Record<string, unknown>;
      if (typeof rr.name !== 'string' || !NAME.test(rr.name) || names.has(rr.name)) fail(`set ${i + 1}: recipient name ${String(rr.name)} is invalid or repeated`);
      if (typeof rr.fingerprint !== 'string' || !HEX64.test(rr.fingerprint) || prints.has(rr.fingerprint)) {
        fail(`set ${i + 1}: recipient ${String(rr.name)} has an invalid or repeated fingerprint`);
      }
      if (!strictBase64(rr.spki)) fail(`set ${i + 1}: recipient ${String(rr.name)} has a key that is not canonical base64`);
      names.add(rr.name as string);
      prints.add(rr.fingerprint as string);
    }
  });
  return json as RecipientsFile;
}

/**
 * The set in force at `atMs`: the newest whose `effectiveFrom` is not later.
 * Null before the first set, when no archive in this format is expected.
 */
export function recipientSetAt(file: RecipientsFile, atMs: number): RecipientSet | null {
  let found: RecipientSet | null = null;
  for (const s of file.sets) if (Date.parse(s.effectiveFrom) <= atMs) found = s;
  return found;
}

/**
 * One recipient's public key, imported for wrapping, after checking that the
 * committed fingerprint is the key's and that the key is the RSA-4096 key the
 * format specifies. A file edited by hand cannot pair one key's fingerprint
 * with another key.
 */
export async function importRecipientKey(r: Recipient): Promise<CryptoKey> {
  const der = strictBase64(r.spki);
  if (!der) throw new Error(`recipient ${r.name}: its key is not base64`);
  const digest = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', der)));
  if (digest !== r.fingerprint) {
    throw new Error(`recipient ${r.name}: the committed fingerprint ${r.fingerprint} is not its key's (${digest})`);
  }
  const key = await crypto.subtle.importKey('spki', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['wrapKey']);
  // The two runtimes type `algorithm` differently; the fields are standard.
  const alg = key.algorithm as unknown as { modulusLength: number; publicExponent: Uint8Array };
  const e = alg.publicExponent;
  if (alg.modulusLength !== RSA_MODULUS_BITS || !(e.length === 3 && e[0] === 1 && e[1] === 0 && e[2] === 1)) {
    throw new Error(`recipient ${r.name}: expected an RSA-${RSA_MODULUS_BITS} key with exponent 65537`);
  }
  return key;
}

/** The prefix and header bytes for `header`, which are also the GCM AAD. */
export function encodeHeader(header: ArchiveHeader): Uint8Array {
  // Field order is fixed so equal headers encode to equal bytes.
  const json = new TextEncoder().encode(
    JSON.stringify({
      scheme: header.scheme,
      iv: header.iv,
      createdAt: header.createdAt,
      tier: header.tier,
      period: header.period,
      recipients: header.recipients.map((r) => ({ fingerprint: r.fingerprint, wrappedKey: r.wrappedKey })),
    }),
  );
  if (json.length > MAX_HEADER_BYTES) throw new Error(`archive header is ${json.length} bytes, over ${MAX_HEADER_BYTES}`);
  const out = new Uint8Array(PREFIX_BYTES + json.length);
  out.set(ARCHIVE_MAGIC, 0);
  new DataView(out.buffer).setUint32(ARCHIVE_MAGIC.length, json.length, false);
  out.set(json, PREFIX_BYTES);
  return out;
}

/**
 * Encrypt one archive to every recipient in `set`.
 *
 * Each call draws its own data key and IV, so the same plaintext sealed twice
 * (the January monthly and the yearly) gives two unrelated archives.
 */
export async function sealArchive(args: {
  set: RecipientSet;
  plaintext: Uint8Array;
  tier: ArchiveTier;
  period: string;
  createdAt: string;
}): Promise<Uint8Array> {
  const { set, plaintext, tier, period, createdAt } = args;
  if (!PERIOD[tier].test(period) || periodOfCreatedAt(tier, createdAt) !== period) {
    throw new Error(`archive period ${period} is not the ${tier} period of ${createdAt}`);
  }
  // Extractable only so it can be wrapped; it is never exported in the clear
  // and goes out of scope when this call returns.
  const dataKey = (await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt'])) as CryptoKey;
  const recipients: HeaderRecipient[] = [];
  for (const r of set.recipients) {
    const pub = await importRecipientKey(r);
    const wrapped = new Uint8Array(await crypto.subtle.wrapKey('raw', dataKey, pub, { name: 'RSA-OAEP' }));
    recipients.push({ fingerprint: r.fingerprint, wrappedKey: toBase64(wrapped) });
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const aad = encodeHeader({ scheme: PK_SCHEME, iv: toBase64(iv), createdAt, tier, period, recipients });
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: GCM_TAG_BYTES * 8 }, dataKey, plaintext),
  );
  const out = new Uint8Array(aad.length + ct.length);
  out.set(aad, 0);
  out.set(ct, aad.length);
  return out;
}

/**
 * How long a nightly run may take from its start (the header's `createdAt`)
 * to an archive's upload. Generous on purpose: it bounds a header that claims
 * a time unrelated to its upload, not the Worker's speed.
 */
export const MAX_RUN_MS = 60 * 60 * 1000;
/** How far B2's upload stamp may run behind the Worker's clock. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

export type HeaderAgreement =
  | { verdict: 'ok' }
  | { verdict: 'wrong-period' | 'wrong-recipients'; reason: string };

/**
 * Does a well-formed header agree with what is known about the archive from
 * outside it: the tier and period its name (or ledger entry) gives, the time
 * B2 stamped its upload, and the recipient set in force then?
 *
 * The set is judged at the run's start and at the upload, and either passes:
 * the Worker picks its set when the run starts, so a rotation that takes
 * effect while a run is in flight must not read as a wrong-key write. Judging
 * against the set in force then, never today's, keeps a rotation from turning
 * every older archive into an alert.
 */
export function headerAgreement(
  header: ArchiveHeader,
  known: { tier: string; period: string; uploadedMs: number; file: RecipientsFile },
): HeaderAgreement {
  if (header.tier !== known.tier || header.period !== known.period) {
    return { verdict: 'wrong-period', reason: `its header names ${header.tier} ${header.period}, not ${known.tier} ${known.period}` };
  }
  if (periodOfCreatedAt(header.tier, header.createdAt) !== header.period) {
    return { verdict: 'wrong-period', reason: `its header's createdAt ${header.createdAt} is not in ${header.period}` };
  }
  const created = Date.parse(header.createdAt);
  if (created < known.uploadedMs - MAX_RUN_MS || created > known.uploadedMs + CLOCK_SKEW_MS) {
    return { verdict: 'wrong-period', reason: `its header's createdAt ${header.createdAt} is not within the run that uploaded it` };
  }
  const named = new Set(header.recipients.map((r) => r.fingerprint));
  const matches = (s: RecipientSet | null) =>
    s !== null && s.recipients.length === named.size && s.recipients.every((r) => named.has(r.fingerprint));
  if (!matches(recipientSetAt(known.file, created)) && !matches(recipientSetAt(known.file, known.uploadedMs))) {
    return { verdict: 'wrong-recipients', reason: 'its header does not name exactly the recipient set in force when it was written' };
  }
  return { verdict: 'ok' };
}
