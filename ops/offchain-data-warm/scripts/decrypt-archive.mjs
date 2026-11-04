#!/usr/bin/env node
/**
 * decrypt-archive.mjs — the offline decrypt step of a restore (#1463, #1473;
 * design: docs/DesignsAndPlans/BackupSecurityDesign.md §6).
 *
 * It sits in front of `restore-from-archive.mjs`, which keeps taking a
 * DECRYPTED `archive.json` and is otherwise unchanged. Run it on the
 * operator's offline machine: it reads a private key, and nothing it reads or
 * writes may reach a server.
 *
 * WHAT IT REFUSES. A restore is the moment forged data would reach
 * production, so on any disagreement it stops and prints the evidence, never
 * restore-and-flag:
 *
 *   1. It lists every version of the period's ledger entries, hide markers
 *      included. A name with more than one version, a hide marker, or any
 *      other sign of tampering is refused, printing every version, unless
 *      the operator names the ledger version to trust (`--ledger-version`).
 *   2. The archive's B2 file id and its SHA-256 and length, computed here
 *      from the bytes, must equal one entry's. The ledger is what vouches
 *      for the archive, not its manifest.
 *   3. More than one entry for the period is refused, printing each with its
 *      server upload time, unless the operator names the entry to use
 *      (`--entry`). The runbook says to pick the newest entry written before
 *      the compromise began, and to stop if that time is unknown.
 *   4. After decrypting, the payload's own `createdAt` must fall in the
 *      period, and for the public-key format agree with the authenticated
 *      header, whose tier, period, time and recipients must agree with the
 *      ledger entry and the recipient set in force when it was written.
 *
 * WHICH KEY. That follows the archive's format: an archive in the public-key
 * format (it starts with `VPKARC\x02`) decrypts with a recipient private key
 * (`--key`, the passphrase-protected PKCS#8 PEM from the offline store); an
 * archive written before slice 2 is in the old symmetric format and decrypts
 * with the old AES key (`--legacy-key`, a file holding its 64 hex
 * characters). This tool keeps reading the old format for as long as any
 * old-format archive is retained, which for the yearly tier is indefinitely.
 *
 * WHAT VOUCHES FOR IT. That follows ledger coverage, whatever the format. An
 * archive with no ledger entry at all (one the watcher never saw, from before
 * the ledger began on 2026-10-28) needs `--pre-ledger-archive`, which skips
 * the ledger and says plainly that nothing vouches for the archive. Only an
 * old-format archive can predate the ledger, so the flag refuses any other.
 *
 * Usage:
 *   node --experimental-strip-types scripts/decrypt-archive.mjs \
 *     --archive <downloaded.bin> --file-id <B2 file id> \
 *     --tier <daily|monthly|yearly> --period <period> \
 *     (--key <private.pem> | --legacy-key <aes-key.hex>) --out <archive.json> \
 *     [--entry <file id>] [--ledger-version <ledger file id>] [--pre-ledger-archive]
 *
 * Environment:
 *   B2_LEDGER_READ_KEY_ID / B2_LEDGER_READ_KEY   a key confined to the ledger
 *       bucket, holding listFiles and readFileRetentions and nothing that
 *       writes, deletes or bypasses a retention
 *   LEDGER_BUCKET           default vaipakam-offchain-backup-ledger
 *   BACKUP_KEY_PASSPHRASE   the private key's passphrase; when unset, it is
 *       asked for on the terminal without echo. Never pass it as an argument.
 *
 * Exit codes: 0 decrypted and written; 1 refused (the evidence is printed);
 * 2 usage or setup error.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  GCM_TAG_BYTES,
  IV_BYTES,
  hasArchiveMagic,
  headerAgreement,
  isIsoTime,
  parseArchiveHeader,
  parseRecipientsFile,
  periodOfCreatedAt,
  strictBase64,
} from '../src/archiveFormat.ts';
import { isRealPeriod } from '../src/tiers.ts';
import { authorize, listAllVersions, requireScope } from './lib/b2-native.mjs';
import { LEDGER_PREFIX, NOT_DIGESTED, parseEntryName, readEntryInfo, readLedger } from './lib/ledger-rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** What the ledger read key may hold. It reads; it can change nothing. */
export const LEDGER_READ_KEY_SCOPE = {
  label: 'ledger read',
  allowed: ['listBuckets', 'listFiles', 'readFiles', 'readFileRetentions'],
  required: ['listFiles', 'readFileRetentions'],
};

/** A refusal: the evidence, one line each, and exit code 1. */
export class Refusal extends Error {
  constructor(lines) {
    super(lines[0]);
    this.lines = lines;
  }
}

class UsageError extends Error {}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown');

/** The command line, validated. Throws UsageError. */
export function parseCommandLine(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        archive: { type: 'string' },
        'file-id': { type: 'string' },
        tier: { type: 'string' },
        period: { type: 'string' },
        key: { type: 'string' },
        'legacy-key': { type: 'string' },
        out: { type: 'string' },
        entry: { type: 'string' },
        'ledger-version': { type: 'string' },
        'pre-ledger-archive': { type: 'boolean', default: false },
      },
    }));
  } catch (e) {
    throw new UsageError(e.message);
  }
  for (const need of ['archive', 'tier', 'period', 'out']) {
    if (!values[need]) throw new UsageError(`--${need} is required`);
  }
  if (!['daily', 'monthly', 'yearly'].includes(values.tier)) throw new UsageError('--tier is daily, monthly or yearly');
  if (!isRealPeriod(values.tier, values.period)) throw new UsageError(`--period ${values.period} is not a ${values.tier} period`);
  if (Boolean(values.key) === Boolean(values['legacy-key'])) throw new UsageError('give exactly one of --key and --legacy-key');
  if (values['pre-ledger-archive']) {
    for (const f of ['entry', 'ledger-version']) {
      if (values[f]) throw new UsageError(`--${f} chooses a ledger entry; --pre-ledger-archive skips the ledger`);
    }
  } else if (!values['file-id']) {
    throw new UsageError('--file-id is required: the ledger names each archive by its B2 file id');
  }
  return values;
}

/**
 * The ledger entry that vouches for this archive, or a refusal.
 *
 * `versions` is every version under the period's ledger prefix. Pure, so each
 * refusal is pinned by the tests without a B2 account.
 */
export function chooseEntry({ versions, tier, period, fileId, sha256, length, entry, ledgerVersion }) {
  const notes = [];
  const { recorded, tampered } = readLedger(versions);
  let candidates;
  if (ledgerVersion) {
    const v = versions.find((x) => x.fileId === ledgerVersion && x.action === 'upload');
    const named = v && parseEntryName(v.fileName);
    const info = named && named.tier === tier && named.period === period ? readEntryInfo(v, named) : null;
    if (!info) {
      throw new Refusal([`--ledger-version ${ledgerVersion} is not an entry version the watcher writes for ${tier} ${period}.`, ...listVersions(versions)]);
    }
    notes.push(`trusting ledger version ${ledgerVersion} (uploaded ${iso(v.uploadTimestamp)}) as named by --ledger-version; every other version is ignored`);
    candidates = [{ ...info, fileId: named.fileId }];
  } else {
    if (tampered.length > 0) {
      throw new Refusal([
        `The ledger for ${tier} ${period} shows tampering, so it cannot say which archive is genuine:`,
        ...tampered.map((t) => `  ${t.name}: ${t.why}`),
        'Every version under the period:',
        ...listVersions(versions),
        'Name the version to trust with --ledger-version <id> once you know which one the watcher wrote.',
      ]);
    }
    candidates = [...recorded.values()];
  }
  if (candidates.length === 0) {
    throw new Refusal([
      `The ledger holds no entry for ${tier} ${period}.`,
      'An archive from before the ledger began needs --pre-ledger-archive, and then nothing vouches for it.',
    ]);
  }
  if (candidates.length > 1 && !entry) {
    throw new Refusal([
      `The ledger holds ${candidates.length} entries for ${tier} ${period}; the nightly writes one. Each, by the time B2 stamped its upload:`,
      ...candidates.sort((a, b) => a.uploaded - b.uploaded).map(describe),
      'Pick the newest entry uploaded before the compromise began and name it with --entry <file id>. If that time is unknown, stop.',
    ]);
  }
  if (entry && entry !== fileId) {
    throw new Refusal([`--entry names ${entry}, but the archive given is ${fileId}. Download the archive the chosen entry names.`]);
  }
  const match = candidates.find((c) => c.fileId === fileId);
  if (!match) {
    throw new Refusal([`No ledger entry for ${tier} ${period} names the archive ${fileId}. The entries:`, ...candidates.map(describe)]);
  }
  if (match.sha256 === NOT_DIGESTED || match.sha256 !== sha256 || match.length !== length) {
    throw new Refusal([
      `The archive's bytes are not the ones the ledger recorded for ${fileId}.`,
      `  ledger:  sha256 ${match.sha256}, ${match.length} bytes`,
      `  archive: sha256 ${sha256}, ${length} bytes`,
    ]);
  }
  if (match.check !== 'match') notes.push(`the watcher recorded this archive's manifest check as ${match.check}`);
  return { entry: match, notes };
}

function describe(c) {
  return `  ${c.fileId}: uploaded ${iso(c.uploaded)}, sha256 ${c.sha256}, manifest ${c.check}, header ${c.header}`;
}

function listVersions(versions) {
  return [...versions]
    .sort((a, b) => a.uploadTimestamp - b.uploadTimestamp)
    .map((v) => `  ${String(v.fileName).replace(/[^0-9A-Za-z_./-]/g, '?')} ${v.action} ${v.fileId} at ${iso(v.uploadTimestamp)}`);
}

/** The SHA-256 of a public key's SPKI DER, as the header names recipients. */
function fingerprintOf(keyObject) {
  return createHash('sha256').update(createPublicKey(keyObject).export({ type: 'spki', format: 'der' })).digest('hex');
}

/**
 * Decrypt one archive. `privateKey` is a Node KeyObject for the public-key
 * format; `legacyKeyHex` the old AES key for the old one.
 *
 * @returns {Promise<{format: 'pk' | 'legacy', header: object | null, plaintext: Uint8Array}>}
 */
export async function openArchive(bytes, { privateKey, legacyKeyHex }) {
  if (hasArchiveMagic(bytes)) {
    if (!privateKey) throw new UsageError('this archive is in the public-key format: decrypt it with --key, a recipient private key');
    const parsed = parseArchiveHeader(bytes);
    if (!parsed.ok) throw new Refusal([`The archive's header is not well formed: ${parsed.reason}.`]);
    const mine = fingerprintOf(privateKey);
    const slot = parsed.header.recipients.find((r) => r.fingerprint === mine);
    if (!slot) {
      throw new Refusal([
        `This private key (${mine}) is not a recipient of the archive. It names:`,
        ...parsed.header.recipients.map((r) => `  ${r.fingerprint}`),
      ]);
    }
    const subtle = globalThis.crypto.subtle;
    const unwrapper = privateKey.toCryptoKey({ name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['unwrapKey']);
    let plaintext;
    try {
      const dataKey = await subtle.unwrapKey('raw', strictBase64(slot.wrappedKey), unwrapper, { name: 'RSA-OAEP' }, { name: 'AES-GCM' }, false, ['decrypt']);
      plaintext = await subtle.decrypt(
        { name: 'AES-GCM', iv: strictBase64(parsed.header.iv), additionalData: parsed.aad, tagLength: GCM_TAG_BYTES * 8 },
        dataKey,
        bytes.subarray(parsed.bodyOffset),
      );
    } catch {
      throw new Refusal(['The archive does not decrypt with this key: its data key, header or ciphertext has been altered.']);
    }
    return { format: 'pk', header: parsed.header, plaintext: new Uint8Array(plaintext) };
  }
  if (!legacyKeyHex) {
    throw new UsageError('this archive is not in the public-key format: an archive written before slice 2 decrypts with --legacy-key, the old AES key');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(legacyKeyHex)) throw new UsageError('the --legacy-key file must hold exactly 64 hex characters');
  if (bytes.length < IV_BYTES + GCM_TAG_BYTES) throw new Refusal(['The archive is too short to hold an IV and a GCM tag.']);
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey('raw', Buffer.from(legacyKeyHex, 'hex'), 'AES-GCM', false, ['decrypt']);
  try {
    const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, IV_BYTES) }, key, bytes.subarray(IV_BYTES));
    return { format: 'legacy', header: null, plaintext: new Uint8Array(plaintext) };
  } catch {
    throw new Refusal(['The archive does not decrypt with this AES key: wrong key, or the ciphertext has been altered.']);
  }
}

/**
 * Step 4: the payload's own `createdAt` against the period and, in the
 * public-key format, against the authenticated header and the ledger.
 */
export function checkPayload({ plaintext, header, tier, period, entry, recipients }) {
  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    throw new Refusal(['The decrypted archive is not UTF-8 JSON.']);
  }
  if (payload?.version !== 1 || !isIsoTime(payload.createdAt)) {
    throw new Refusal(['The decrypted archive does not state a version-1 createdAt.']);
  }
  if (periodOfCreatedAt(tier, payload.createdAt) !== period) {
    throw new Refusal([`The archive says it was created at ${payload.createdAt}, which is not in ${tier} ${period}.`]);
  }
  if (header) {
    if (header.createdAt !== payload.createdAt) {
      throw new Refusal([`The archive's header says ${header.createdAt} and its payload ${payload.createdAt}; the nightly writes one time to both.`]);
    }
    const agreed = headerAgreement(header, { tier, period, uploadedMs: entry.uploaded, file: recipients });
    if (agreed.verdict !== 'ok') throw new Refusal([`The archive's header disagrees with its ledger entry: ${agreed.reason}.`]);
  }
  return payload;
}

/** A passphrase from the environment, or from the terminal without echo. */
async function readPassphrase(env) {
  if (env.BACKUP_KEY_PASSPHRASE) return env.BACKUP_KEY_PASSPHRASE;
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new UsageError('the private key is passphrase-protected: set BACKUP_KEY_PASSPHRASE or run on a terminal');
  process.stderr.write('Private key passphrase: ');
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((done, fail) => {
    let s = '';
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish(() => done(s));
        if (ch === '\u0003') return finish(() => fail(new UsageError('cancelled')));
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1);
        else s += ch;
      }
    };
    const finish = (then) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      then();
    };
    stdin.on('data', onData);
  });
}

async function loadPrivateKey(path, env, askPassphrase) {
  const pem = readFileSync(path, 'utf8');
  const encrypted = pem.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----');
  try {
    return createPrivateKey(encrypted ? { key: pem, format: 'pem', passphrase: await askPassphrase(env) } : { key: pem, format: 'pem' });
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`the private key in ${path} could not be read${encrypted ? ' with that passphrase' : ''}`);
  }
}

/**
 * One run. Every input arrives as an argument, so the tests drive it against
 * an in-memory B2 and generated keys.
 */
export async function runDecrypt({ argv, env = process.env, fetchImpl = fetch, sleep, log = () => {}, askPassphrase = readPassphrase, recipientsPath } = {}) {
  const opts = parseCommandLine(argv);
  const bytes = new Uint8Array(readFileSync(opts.archive));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const recipients = parseRecipientsFile(JSON.parse(readFileSync(recipientsPath ?? resolve(HERE, '../backup-recipients/recipients.json'), 'utf8')));

  let entry = null;
  if (opts['pre-ledger-archive']) {
    if (hasArchiveMagic(bytes)) {
      throw new Refusal(['--pre-ledger-archive is for an archive from before the ledger began, and those are all in the old format; this one is not. Its ledger entry must vouch for it.']);
    }
    log('NOTHING VOUCHES FOR THIS ARCHIVE: --pre-ledger-archive skips the ledger, so its bytes are restored on your judgment alone.');
  } else {
    const io = { fetchImpl, ...(sleep ? { sleep } : {}) };
    const bucket = env.LEDGER_BUCKET || 'vaipakam-offchain-backup-ledger';
    if (!env.B2_LEDGER_READ_KEY_ID || !env.B2_LEDGER_READ_KEY) throw new UsageError('set B2_LEDGER_READ_KEY_ID and B2_LEDGER_READ_KEY: the ledger is what vouches for the archive');
    const auth = await authorize(env.B2_LEDGER_READ_KEY_ID, env.B2_LEDGER_READ_KEY, io);
    const bucketId = requireScope(auth, { ...LEDGER_READ_KEY_SCOPE, bucket });
    const versions = await listAllVersions(auth, bucketId, `${LEDGER_PREFIX}${opts.tier}/${opts.period}/`, io);
    const chosen = chooseEntry({
      versions,
      tier: opts.tier,
      period: opts.period,
      fileId: opts['file-id'],
      sha256,
      length: bytes.length,
      entry: opts.entry,
      ledgerVersion: opts['ledger-version'],
    });
    entry = chosen.entry;
    for (const n of chosen.notes) log(`note: ${n}`);
    log(`ledger: ${opts.tier} ${opts.period} ${entry.fileId}, uploaded ${iso(entry.uploaded)}, sha256 ${entry.sha256}`);
  }

  const keys = opts.key
    ? { privateKey: await loadPrivateKey(opts.key, env, askPassphrase) }
    : { legacyKeyHex: readFileSync(opts['legacy-key'], 'utf8').trim() };
  const opened = await openArchive(bytes, keys);
  const payload = checkPayload({ plaintext: opened.plaintext, header: opened.header, tier: opts.tier, period: opts.period, entry, recipients });
  // `wx`: never overwrite an earlier decrypt. 0600: it is plaintext.
  writeFileSync(opts.out, opened.plaintext, { flag: 'wx', mode: 0o600 });
  log(`decrypted the ${opened.format === 'pk' ? 'public-key' : 'old symmetric'}-format ${opts.tier} archive for ${opts.period} (created ${payload.createdAt}) to ${opts.out}`);
  return { format: opened.format, createdAt: payload.createdAt, entry };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const log = (line) => process.stdout.write(`${line}\n`);
  runDecrypt({ argv: process.argv.slice(2), log })
    .then(() => process.exit(0))
    .catch((e) => {
      if (e instanceof Refusal) {
        process.stderr.write(`REFUSED: ${e.lines.join('\n')}\n`);
        process.exit(1);
      }
      process.stderr.write(`decrypt-archive: ${e?.message ?? e}\n`);
      process.exit(2);
    });
}
