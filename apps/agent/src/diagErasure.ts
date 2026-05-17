/**
 * 2026-05-17 — T-075: user-initiated erasure of server-side
 * error-capture records (GDPR Art-17 right-to-erasure for the
 * `diag_errors` D1 table).
 *
 * Three endpoints live here:
 *
 *   POST /diag/erasure         — a user erases their own records.
 *   POST /diag/erasure/status  — a user checks whether anything was
 *                                retained (uniform unless lawful
 *                                disclosure was explicitly enabled).
 *   POST /diag/legal-hold      — protocol-admin only: place / lift a
 *                                hold, toggle the per-wallet
 *                                disclosure flag. Authenticated by a
 *                                wallet signature whose signer holds
 *                                on-chain `ADMIN_ROLE` (see
 *                                `diagAdminAuth.ts`) — no shared
 *                                secret. Every action is appended to
 *                                the `diag_legal_hold_audit` table.
 *
 * ── How a user is authenticated ──────────────────────────────────
 *
 * There is no account system. Ownership of a wallet is proven by an
 * EIP-191 `personal_sign` signature over a fixed, human-readable
 * message (see {@link buildErasureMessage}) that names the wallet
 * and an `issuedAt` timestamp. The Worker reconstructs the exact
 * message from the request body, recovers the signing address, and
 * requires it to equal the claimed wallet. The timestamp bounds
 * replay to a short window. The signature is not a transaction and
 * costs the user no gas.
 *
 * ── Why a keyed hash is the deletion key ─────────────────────────
 *
 * `diag_errors` rows carry a *redacted* wallet (`0x…abcd`) for
 * triage display, which is NOT unique. Deleting by it would erase
 * unrelated users' rows on a nibble collision. The real key is
 * `wallet_hash = HMAC(fullWallet, DIAG_WALLET_HMAC_KEY)` (see
 * `diagHash.ts`) — recomputed here from the signed wallet, it
 * matches exactly that user's rows and no one else's.
 *
 * ── The two gag-order-safe invariants ────────────────────────────
 *
 *  1. **The erasure endpoint NEVER branches its response.** It
 *     returns the same uniform `{status:'processed'}` whether it
 *     deleted 100 rows, deleted 0, or skipped everything under a
 *     legal hold. The response cannot tip off a user that their
 *     records are under a (possibly gagged) retention order.
 *
 *  2. **Disclosure is a separate, explicitly-gated action.** The
 *     status endpoint only ever surfaces a "retained by law" note
 *     when an operator has set `disclosure_allowed = 1` for that
 *     wallet-hash. By default — and for every gagged hold — it
 *     returns the same uniform payload as a user with no hold at
 *     all. The flag only ever moves toward MORE disclosure, by a
 *     deliberate human action, so a gag is always safe.
 *
 * Malformed requests (bad JSON, bad signature, stale timestamp) DO
 * get a distinct 4xx — that reveals nothing about retention, only
 * that the request itself was not well-formed.
 */

import { recoverMessageAddress, type Hex } from 'viem';
import type { Env } from './env';
import { isHexAddress, walletHash } from './diagHash';
import { isProtocolAdmin, type AdminVerifier } from './diagAdminAuth';
import {
  sha256Hex,
  storeLegalDocument,
  validateLegalDocument,
} from './diagLegalDoc';

// ─── Tunables ──────────────────────────────────────────────────────

/**
 * Replay window for a signed erasure / status request. A signature
 * older (or further in the future) than this is rejected. Erasure
 * is idempotent so replay is not dangerous, but bounding the window
 * limits how long a leaked signature stays usable against the
 * status endpoint.
 */
const SIGNATURE_MAX_AGE_SECONDS = 10 * 60;

/** EIP-191 `personal_sign` signature: `0x` + 65 bytes = 132 chars. */
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

/**
 * The note returned by the status endpoint when a hold exists,
 * `disclosure_allowed = 1`, and the operator did not supply a
 * custom `disclosure_note`. Deliberately non-specific — it confirms
 * retention and points to support without enumerating which records
 * or why.
 */
const DEFAULT_DISCLOSURE_NOTE =
  'Some of your error-diagnostics records have been retained as ' +
  'required by law and could not be erased. Please contact support ' +
  'if you would like more information.';

// ─── Canonical signed message ──────────────────────────────────────

/**
 * Build the exact message a user signs to authorise erasure /
 * status. This string MUST be byte-identical between the wallet
 * prompt the frontend shows and the reconstruction here, or
 * signature recovery yields a different address and the request is
 * rejected. The wallet is lower-cased so a checksummed and an
 * all-lowercase spelling of the same address produce the same
 * message.
 *
 * NOTE: when the frontend erasure UI is built (follow-up), this
 * builder should move to `packages/lib` so both sides import one
 * source of truth — the same single-source discipline the repo
 * applies to ABIs. Until then the format is frozen here and
 * mirrored in the PIA doc.
 *
 * @param wallet   Full EVM address (validated by the caller).
 * @param issuedAt Unix seconds the request was signed at.
 */
export function buildErasureMessage(wallet: string, issuedAt: number): string {
  return [
    'Vaipakam — Erase my error-diagnostics records',
    '',
    'I request erasure of the server-side error-capture records',
    'associated with the wallet below. Signing this message proves',
    'ownership of the wallet. It is not a transaction and costs no gas.',
    '',
    `Wallet: ${wallet.toLowerCase()}`,
    `Issued at (unix): ${issuedAt}`,
  ].join('\n');
}

// ─── Request parsing + signature verification ──────────────────────

interface SignedRequest {
  wallet: string;
  issuedAt: number;
  signature: string;
}

type ParseResult =
  | { ok: true; req: SignedRequest }
  | { ok: false; reason: string };

/** Shape-validate a signed erasure / status request body. */
function parseSignedRequest(body: unknown): ParseResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, reason: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  if (!isHexAddress(b.wallet)) {
    return { ok: false, reason: 'wallet must be a valid address' };
  }
  if (
    typeof b.issuedAt !== 'number' ||
    !isFinite(b.issuedAt) ||
    b.issuedAt <= 0
  ) {
    return { ok: false, reason: 'issuedAt must be a positive unix-seconds number' };
  }
  if (typeof b.signature !== 'string' || !SIGNATURE_RE.test(b.signature)) {
    return { ok: false, reason: 'signature must be a 65-byte hex string' };
  }
  return {
    ok: true,
    req: {
      wallet: b.wallet,
      issuedAt: Math.floor(b.issuedAt),
      signature: b.signature,
    },
  };
}

type VerifyResult =
  | { ok: true }
  | { ok: false; status: number; reason: string };

/**
 * Verify a parsed signed request: the timestamp is inside the
 * replay window AND the signature recovers to the claimed wallet.
 */
async function verifySignedRequest(
  req: SignedRequest,
  nowSeconds: number,
): Promise<VerifyResult> {
  if (Math.abs(nowSeconds - req.issuedAt) > SIGNATURE_MAX_AGE_SECONDS) {
    return { ok: false, status: 400, reason: 'request timestamp is stale' };
  }
  const message = buildErasureMessage(req.wallet, req.issuedAt);
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({
      message,
      signature: req.signature as Hex,
    });
  } catch {
    // A structurally-valid-looking hex string that isn't a real
    // signature lands here.
    return { ok: false, status: 400, reason: 'signature is not recoverable' };
  }
  if (recovered.toLowerCase() !== req.wallet.toLowerCase()) {
    return { ok: false, status: 400, reason: 'signature does not match wallet' };
  }
  return { ok: true };
}

// ─── D1 helpers ────────────────────────────────────────────────────

interface LegalHoldRow {
  disclosure_allowed: number;
  disclosure_note: string | null;
}

/** Read the legal-hold row for a wallet-hash, or null if not held. */
async function getLegalHold(
  db: D1Database,
  walletHashHex: string,
): Promise<LegalHoldRow | null> {
  return db
    .prepare(
      `SELECT disclosure_allowed, disclosure_note
         FROM diag_legal_holds
        WHERE wallet_hash = ?`,
    )
    .bind(walletHashHex)
    .first<LegalHoldRow>();
}

// ─── Endpoint: POST /diag/erasure ──────────────────────────────────

/**
 * Erase the caller's error-capture records.
 *
 * Always returns the uniform `{status:'processed'}` on a valid
 * request — see invariant 1 in the file header. Held records are
 * silently skipped; the caller cannot tell from the response.
 */
export async function handleDiagErasure(
  req: Request,
  env: Env,
  corsOrigin: string,
): Promise<Response> {
  // The keyed hash is the deletion key — without the HMAC secret the
  // feature cannot function. This is a config error, not a retention
  // signal, so a distinct 503 is fine.
  if (!env.DIAG_WALLET_HMAC_KEY) {
    return json({ error: 'erasure_not_configured' }, 503, corsOrigin);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400, corsOrigin);
  }
  const parsed = parseSignedRequest(body);
  if (!parsed.ok) {
    return json({ error: 'invalid_request', reason: parsed.reason }, 400, corsOrigin);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const verified = await verifySignedRequest(parsed.req, nowSeconds);
  if (!verified.ok) {
    return json(
      { error: 'verification_failed', reason: verified.reason },
      verified.status,
      corsOrigin,
    );
  }

  const hash = await walletHash(parsed.req.wallet, env.DIAG_WALLET_HMAC_KEY);
  const hold = await getLegalHold(env.DB, hash);

  // Legal hold present → retain everything for this wallet-hash.
  // Hold absent → delete every row keyed to this wallet-hash.
  // Either way the response below is identical.
  if (!hold) {
    await env.DB
      .prepare(`DELETE FROM diag_errors WHERE wallet_hash = ?`)
      .bind(hash)
      .run();
  }

  // INVARIANT 1: uniform response, no branching, no row counts.
  return json({ status: 'processed' }, 200, corsOrigin);
}

// ─── Endpoint: POST /diag/erasure/status ───────────────────────────

/**
 * Report erasure status for the caller's wallet.
 *
 * Returns the uniform `{status:'processed'}` UNLESS a legal hold
 * exists for the wallet-hash AND an operator has set
 * `disclosure_allowed = 1` — only then is the retained-by-law note
 * surfaced. A gagged hold (`disclosure_allowed = 0`) is
 * indistinguishable from no hold at all. See invariant 2.
 */
export async function handleDiagErasureStatus(
  req: Request,
  env: Env,
  corsOrigin: string,
): Promise<Response> {
  if (!env.DIAG_WALLET_HMAC_KEY) {
    return json({ error: 'erasure_not_configured' }, 503, corsOrigin);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400, corsOrigin);
  }
  const parsed = parseSignedRequest(body);
  if (!parsed.ok) {
    return json({ error: 'invalid_request', reason: parsed.reason }, 400, corsOrigin);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const verified = await verifySignedRequest(parsed.req, nowSeconds);
  if (!verified.ok) {
    return json(
      { error: 'verification_failed', reason: verified.reason },
      verified.status,
      corsOrigin,
    );
  }

  const hash = await walletHash(parsed.req.wallet, env.DIAG_WALLET_HMAC_KEY);
  const hold = await getLegalHold(env.DB, hash);

  if (hold && hold.disclosure_allowed === 1) {
    return json(
      {
        status: 'retained_by_law',
        note: hold.disclosure_note ?? DEFAULT_DISCLOSURE_NOTE,
      },
      200,
      corsOrigin,
    );
  }

  // No hold, OR a hold whose disclosure was not explicitly enabled
  // (the gag-safe default). Same payload either way — the caller
  // cannot distinguish the two cases.
  return json({ status: 'processed' }, 200, corsOrigin);
}

// ─── Endpoint: POST /diag/legal-hold (protocol-admin only) ─────────

interface LegalHoldRequest {
  action: 'place' | 'lift' | 'set-disclosure';
  wallet: string;
  holdReason?: string;
  disclosureAllowed?: boolean;
  disclosureNote?: string;
  /** SHA-256 (hex) of the legal document being uploaded with this
   *  action — the document's content identity. The admin signs
   *  THIS (not the storage locator): the locator is assigned by the
   *  Worker on upload, the hash is what legally pins "this exact
   *  order". Required for `place`; required whenever a document part
   *  is present; absent for a documentless `lift` / `set-disclosure`. */
  legalDocSha256?: string;
  issuedAt: number;
  signature: string;
}

/** SHA-256 hex digest: 64 lowercase/uppercase hex chars. */
const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/;

/**
 * The exact message a protocol admin signs to authorise a legal-hold
 * action. Every field that affects the outcome — action, target
 * wallet, reason, disclosure flag + note, the uploaded document's
 * SHA-256, timestamp — is in the message, so the signature is bound
 * to this specific action and cannot be lifted onto a different one.
 *
 * Note the message carries the document's **hash**, not its storage
 * locator: the locator (`legal_doc_ref`) is assigned by the Worker
 * when it files the upload, so it cannot be pre-signed; the hash is
 * the document's content identity and is what the admin attests to.
 * Reconstructed verbatim by the Worker; must stay byte-stable.
 */
export function buildLegalHoldMessage(req: LegalHoldRequest): string {
  return [
    'Vaipakam — Protocol admin: diagnostics legal hold',
    '',
    'I authorise the legal-hold action below on the server-side',
    'error-diagnostics records. This is a protocol-admin action.',
    '',
    `Action: ${req.action}`,
    `Target wallet: ${req.wallet.toLowerCase()}`,
    `Reason: ${req.holdReason ?? ''}`,
    `Disclosure allowed: ${
      req.disclosureAllowed === undefined ? '' : String(req.disclosureAllowed)
    }`,
    `Disclosure note: ${req.disclosureNote ?? ''}`,
    `Legal document SHA-256: ${req.legalDocSha256 ?? ''}`,
    `Issued at (unix): ${req.issuedAt}`,
  ].join('\n');
}

function parseLegalHoldRequest(
  body: unknown,
): { ok: true; req: LegalHoldRequest } | { ok: false; reason: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, reason: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  if (b.action !== 'place' && b.action !== 'lift' && b.action !== 'set-disclosure') {
    return { ok: false, reason: "action must be 'place', 'lift' or 'set-disclosure'" };
  }
  if (!isHexAddress(b.wallet)) {
    return { ok: false, reason: 'wallet must be a valid address' };
  }
  if (b.action === 'place' && (typeof b.holdReason !== 'string' || !b.holdReason)) {
    return { ok: false, reason: 'holdReason is required to place a hold' };
  }
  if (
    b.action === 'set-disclosure' &&
    typeof b.disclosureAllowed !== 'boolean'
  ) {
    return { ok: false, reason: 'disclosureAllowed (boolean) is required' };
  }
  // A `place` must carry the SHA-256 of the legal document being
  // uploaded with it — no hold without a recorded legal basis. (The
  // matching `document` part is checked in the handler; here we only
  // validate the hash field.)
  if (
    b.action === 'place' &&
    (typeof b.legalDocSha256 !== 'string' || !SHA256_HEX_RE.test(b.legalDocSha256))
  ) {
    return { ok: false, reason: 'legalDocSha256 is required to place a hold' };
  }
  if (
    b.legalDocSha256 !== undefined &&
    (typeof b.legalDocSha256 !== 'string' || !SHA256_HEX_RE.test(b.legalDocSha256))
  ) {
    return { ok: false, reason: 'legalDocSha256 must be a 64-char hex string' };
  }
  if (
    typeof b.issuedAt !== 'number' ||
    !isFinite(b.issuedAt) ||
    b.issuedAt <= 0
  ) {
    return { ok: false, reason: 'issuedAt must be a positive unix-seconds number' };
  }
  if (typeof b.signature !== 'string' || !SIGNATURE_RE.test(b.signature)) {
    return { ok: false, reason: 'signature must be a 65-byte hex string' };
  }
  return {
    ok: true,
    req: {
      action: b.action,
      wallet: b.wallet,
      holdReason: typeof b.holdReason === 'string' ? b.holdReason : undefined,
      disclosureAllowed:
        typeof b.disclosureAllowed === 'boolean' ? b.disclosureAllowed : undefined,
      disclosureNote:
        typeof b.disclosureNote === 'string' ? b.disclosureNote : undefined,
      legalDocSha256:
        typeof b.legalDocSha256 === 'string' ? b.legalDocSha256 : undefined,
      issuedAt: Math.floor(b.issuedAt),
      signature: b.signature,
    },
  };
}

/** Append one row to the immutable legal-hold audit trail. This
 *  table is never updated or deleted from — it is the defensible
 *  record of which admin took which hold action, when, and which
 *  legal document authorised it. */
async function appendLegalHoldAudit(
  db: D1Database,
  at: number,
  action: string,
  walletHashHex: string,
  adminWallet: string,
  detail: string,
  legalDocRef: string | null,
  legalDocSha256: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO diag_legal_hold_audit
         (at, action, wallet_hash, admin_wallet, detail,
          legal_doc_ref, legal_doc_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      at,
      action,
      walletHashHex,
      adminWallet.toLowerCase(),
      detail,
      legalDocRef,
      legalDocSha256,
    )
    .run();
}

/**
 * Place / lift a legal hold and toggle the per-wallet disclosure
 * flag. Protocol-admin only.
 *
 * Auth: the request is signed (EIP-191) by the admin's wallet over
 * {@link buildLegalHoldMessage}; the Worker recovers the signer and
 * requires it to hold the on-chain `ADMIN_ROLE` (`verifyAdmin`,
 * default {@link isProtocolAdmin}). No shared secret — the contract's
 * access-control state is the source of truth, exactly as the
 * `apps/defi` protocol console determines admin status. The endpoint
 * is naturally inert before deploy: with no RPC / deployment
 * configured, `verifyAdmin` finds no admin and every call is 403.
 *
 * The admin supplies the user's full wallet address (taken from the
 * legal order); the wallet-hash is derived server-side so the
 * `diag_legal_holds` key always matches the capture / erasure paths.
 *
 * Legal document. A `place` MUST upload the authorising document
 * (the e-signed order / scanned letter). The request is then
 * `multipart/form-data` — a `payload` part (the signed JSON) plus a
 * `document` part (the PDF). The Worker hashes the PDF server-side,
 * requires that hash to equal the `legalDocSha256` the admin signed
 * (so the upload is bound to the signature — sign hash X, upload
 * file Y is rejected), and files it in the private `DIAG_LEGAL_DOCS`
 * R2 bucket; the bucket key becomes the hold's `legal_doc_ref`. A
 * documentless `lift` / `set-disclosure` may be sent as plain JSON.
 * Every successful action is appended to `diag_legal_hold_audit` —
 * an immutable trail of which admin did what, when, and on what
 * legal basis. The response echoes the recorded `legalDocRef` +
 * `legalDocSha256` so the console can show the admin what was filed.
 *
 * @param verifyAdmin Injectable for tests; production omits it and
 *                    the real on-chain check is used.
 */
export async function handleDiagLegalHold(
  req: Request,
  env: Env,
  corsOrigin: string,
  verifyAdmin: AdminVerifier = isProtocolAdmin,
): Promise<Response> {
  if (!env.DIAG_WALLET_HMAC_KEY) {
    return json({ error: 'erasure_not_configured' }, 503, corsOrigin);
  }

  // The request is either pure JSON (a documentless lift /
  // set-disclosure) or multipart/form-data carrying the signed
  // `payload` JSON plus a `document` PDF part (always for `place`).
  let payloadRaw: unknown;
  let documentBytes: ArrayBuffer | null = null;
  if ((req.headers.get('content-type') ?? '').includes('multipart/form-data')) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json({ error: 'invalid_form' }, 400, corsOrigin);
    }
    const payloadField = form.get('payload');
    if (typeof payloadField !== 'string') {
      return json(
        { error: 'invalid_request', reason: 'missing payload part' },
        400,
        corsOrigin,
      );
    }
    try {
      payloadRaw = JSON.parse(payloadField);
    } catch {
      return json({ error: 'invalid_json' }, 400, corsOrigin);
    }
    const docField = form.get('document');
    if (docField && typeof docField !== 'string') {
      documentBytes = await docField.arrayBuffer();
    }
  } else {
    try {
      payloadRaw = await req.json();
    } catch {
      return json({ error: 'invalid_json' }, 400, corsOrigin);
    }
  }

  const parsed = parseLegalHoldRequest(payloadRaw);
  if (!parsed.ok) {
    return json({ error: 'invalid_request', reason: parsed.reason }, 400, corsOrigin);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - parsed.req.issuedAt) > SIGNATURE_MAX_AGE_SECONDS) {
    return json(
      { error: 'verification_failed', reason: 'request timestamp is stale' },
      400,
      corsOrigin,
    );
  }

  // Recover the signing wallet from the EIP-191 signature.
  let signer: string;
  try {
    signer = await recoverMessageAddress({
      message: buildLegalHoldMessage(parsed.req),
      signature: parsed.req.signature as Hex,
    });
  } catch {
    return json(
      { error: 'verification_failed', reason: 'signature is not recoverable' },
      400,
      corsOrigin,
    );
  }

  // Authorize: the signer must hold the on-chain ADMIN_ROLE.
  if (!(await verifyAdmin(env, signer))) {
    return json(
      { error: 'unauthorized', reason: 'signer is not a protocol admin' },
      403,
      corsOrigin,
    );
  }

  const { action, wallet, holdReason, disclosureAllowed, disclosureNote } =
    parsed.req;

  // ── Legal document ──────────────────────────────────────────────
  // When a `document` part is present (always for `place`, optional
  // for the others) it is validated, hashed server-side, checked
  // against the signed hash, and filed in the private R2 bucket.
  let docRef: string | null = null;
  let docSha: string | null = null;
  if (documentBytes) {
    const valid = validateLegalDocument(documentBytes);
    if (!valid.ok) {
      return json({ error: 'invalid_document', reason: valid.reason }, 400, corsOrigin);
    }
    const computed = await sha256Hex(documentBytes);
    // Bind the upload to the signature — the admin signed this hash.
    if (computed !== (parsed.req.legalDocSha256 ?? '').toLowerCase()) {
      return json(
        {
          error: 'document_hash_mismatch',
          reason: 'uploaded document does not match the signed hash',
        },
        400,
        corsOrigin,
      );
    }
    if (!env.DIAG_LEGAL_DOCS) {
      return json({ error: 'legal_doc_storage_not_configured' }, 503, corsOrigin);
    }
    docRef = await storeLegalDocument(env.DIAG_LEGAL_DOCS, documentBytes, computed);
    docSha = computed;
  }
  if (action === 'place' && !docRef) {
    return json(
      {
        error: 'document_required',
        reason: 'a legal document must be uploaded to place a hold',
      },
      400,
      corsOrigin,
    );
  }

  const hash = await walletHash(wallet, env.DIAG_WALLET_HMAC_KEY);

  if (action === 'place') {
    // Upsert — re-placing a hold refreshes the reason, the cited
    // legal document, and the timestamp; it leaves any existing
    // disclosure flag untouched.
    await env.DB
      .prepare(
        `INSERT INTO diag_legal_holds
           (wallet_hash, hold_reason, disclosure_allowed, disclosure_note,
            legal_doc_ref, legal_doc_sha256, created_at, updated_at)
         VALUES (?, ?, 0, NULL, ?, ?, ?, ?)
         ON CONFLICT(wallet_hash) DO UPDATE SET
           hold_reason      = excluded.hold_reason,
           legal_doc_ref    = excluded.legal_doc_ref,
           legal_doc_sha256 = excluded.legal_doc_sha256,
           updated_at       = excluded.updated_at`,
      )
      .bind(hash, holdReason ?? '', docRef, docSha, nowSeconds, nowSeconds)
      .run();
    await appendLegalHoldAudit(
      env.DB, nowSeconds, 'place', hash, signer, holdReason ?? '',
      docRef, docSha,
    );
    return json(
    { ok: true, legalDocRef: docRef, legalDocSha256: docSha },
    200,
    corsOrigin,
  );
  }

  if (action === 'lift') {
    await env.DB
      .prepare(`DELETE FROM diag_legal_holds WHERE wallet_hash = ?`)
      .bind(hash)
      .run();
    await appendLegalHoldAudit(
      env.DB, nowSeconds, 'lift', hash, signer, '', docRef, docSha,
    );
    return json(
    { ok: true, legalDocRef: docRef, legalDocSha256: docSha },
    200,
    corsOrigin,
  );
  }

  // action === 'set-disclosure' — toggle the per-wallet disclosure
  // flag on an existing hold. Returns 404 if no hold exists, so an
  // admin can't accidentally arm disclosure for a wallet that was
  // never held.
  const existing = await getLegalHold(env.DB, hash);
  if (!existing) {
    return json({ error: 'no_hold_for_wallet' }, 404, corsOrigin);
  }
  await env.DB
    .prepare(
      `UPDATE diag_legal_holds
          SET disclosure_allowed = ?, disclosure_note = ?, updated_at = ?
        WHERE wallet_hash = ?`,
    )
    .bind(disclosureAllowed ? 1 : 0, disclosureNote ?? null, nowSeconds, hash)
    .run();
  await appendLegalHoldAudit(
    env.DB,
    nowSeconds,
    'set-disclosure',
    hash,
    signer,
    `disclosure_allowed=${disclosureAllowed ? 1 : 0}; note=${disclosureNote ?? ''}`,
    docRef,
    docSha,
  );
  return json(
    { ok: true, legalDocRef: docRef, legalDocSha256: docSha },
    200,
    corsOrigin,
  );
}

// ─── Response helpers ──────────────────────────────────────────────

function json(data: unknown, status: number, corsOrigin: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': corsOrigin,
    },
  });
}
