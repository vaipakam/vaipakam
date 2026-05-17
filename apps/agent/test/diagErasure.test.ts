import { describe, it, expect, beforeEach } from 'vitest';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  buildErasureMessage,
  buildLegalHoldMessage,
  handleDiagErasure,
  handleDiagErasureStatus,
  handleDiagLegalHold,
} from '../src/diagErasure';
import { walletHash } from '../src/diagHash';
import { sha256Hex } from '../src/diagLegalDoc';
import type { Env } from '../src/env';

// ─── Fixtures ──────────────────────────────────────────────────────

const HMAC_KEY = 'unit-test-hmac-key';
const CORS = 'https://defi.vaipakam.com';

// Anvil's first two well-known dev keys — fine in a test, never a
// real key.
const ACCOUNT_A: PrivateKeyAccount = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const ACCOUNT_B: PrivateKeyAccount = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

// ─── In-memory D1 fake ─────────────────────────────────────────────
//
// SQL-aware just enough for the five statements diagErasure.ts
// issues. Keyword-matches the prepared SQL to a backing operation.

interface ErrorRow {
  id: string;
  wallet_hash: string | null;
}
interface HoldRow {
  wallet_hash: string;
  hold_reason: string;
  disclosure_allowed: number;
  disclosure_note: string | null;
  legal_doc_ref?: string | null;
  legal_doc_sha256?: string | null;
  created_at: number;
  updated_at: number;
}

interface AuditRow {
  at: number;
  action: string;
  wallet_hash: string;
  admin_wallet: string;
  detail: string | null;
  legal_doc_ref: string | null;
  legal_doc_sha256: string | null;
}

class FakeD1 {
  errors: ErrorRow[] = [];
  holds: HoldRow[] = [];
  audit: AuditRow[] = [];
  prepare(sql: string) {
    return new FakeStmt(this, sql);
  }
}

class FakeStmt {
  private args: unknown[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}

  bind(...a: unknown[]): this {
    this.args = a;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const s = this.sql;
    if (s.includes('diag_legal_holds') && s.includes('SELECT')) {
      const wh = this.args[0] as string;
      return (this.db.holds.find((h) => h.wallet_hash === wh) ?? null) as T | null;
    }
    throw new Error('FakeD1: unhandled first(): ' + s);
  }

  async run(): Promise<void> {
    const s = this.sql;
    if (s.includes('DELETE FROM diag_errors')) {
      const wh = this.args[0] as string;
      this.db.errors = this.db.errors.filter((e) => e.wallet_hash !== wh);
      return;
    }
    if (s.includes('INSERT INTO diag_legal_holds')) {
      const [wallet_hash, hold_reason, legal_doc_ref, legal_doc_sha256, created_at, updated_at] =
        this.args as [string, string, string | null, string | null, number, number];
      const existing = this.db.holds.find((h) => h.wallet_hash === wallet_hash);
      if (existing) {
        existing.hold_reason = hold_reason;
        existing.legal_doc_ref = legal_doc_ref;
        existing.legal_doc_sha256 = legal_doc_sha256;
        existing.updated_at = updated_at;
      } else {
        this.db.holds.push({
          wallet_hash,
          hold_reason,
          disclosure_allowed: 0,
          disclosure_note: null,
          legal_doc_ref,
          legal_doc_sha256,
          created_at,
          updated_at,
        });
      }
      return;
    }
    if (s.includes('DELETE FROM diag_legal_holds')) {
      const wh = this.args[0] as string;
      this.db.holds = this.db.holds.filter((h) => h.wallet_hash !== wh);
      return;
    }
    if (s.includes('UPDATE diag_legal_holds')) {
      const [disclosure_allowed, disclosure_note, updated_at, wallet_hash] =
        this.args as [number, string | null, number, string];
      const h = this.db.holds.find((x) => x.wallet_hash === wallet_hash);
      if (h) {
        h.disclosure_allowed = disclosure_allowed;
        h.disclosure_note = disclosure_note;
        h.updated_at = updated_at;
      }
      return;
    }
    if (s.includes('INSERT INTO diag_legal_hold_audit')) {
      const [at, action, wallet_hash, admin_wallet, detail, legal_doc_ref, legal_doc_sha256] =
        this.args as [number, string, string, string, string | null, string | null, string | null];
      this.db.audit.push({
        at, action, wallet_hash, admin_wallet, detail, legal_doc_ref, legal_doc_sha256,
      });
      return;
    }
    throw new Error('FakeD1: unhandled run(): ' + s);
  }

  async all<T>(): Promise<{ results: T[] }> {
    throw new Error('FakeD1: unhandled all(): ' + this.sql);
  }
}

// ─── In-memory R2 fake ─────────────────────────────────────────────
//
// The legal-hold endpoint stores uploaded PDFs in an R2 bucket. In a
// unit test there is no Cloudflare runtime, so this stands in: a
// plain Map, the same approach as `FakeD1`. The only method the
// handler calls is `put`.

class FakeR2 {
  store = new Map<string, ArrayBuffer>();
  async put(key: string, value: ArrayBuffer): Promise<void> {
    this.store.set(key, value);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function makeEnv(
  db: FakeD1,
  overrides: Partial<Env> = {},
): Env {
  return {
    DB: db as unknown as D1Database,
    DIAG_WALLET_HMAC_KEY: HMAC_KEY,
    DIAG_LEGAL_DOCS: new FakeR2() as unknown as R2Bucket,
    FRONTEND_ORIGIN: CORS,
    ...overrides,
  } as Env;
}

/** An `AdminVerifier` stub — `handleDiagLegalHold` takes one so tests
 *  don't need to mock an RPC. `adminOf(ACCOUNT_A)` authorises only
 *  A; `denyAll` authorises nobody. */
function adminOf(...accounts: PrivateKeyAccount[]) {
  const set = new Set(accounts.map((a) => a.address.toLowerCase()));
  return async (_env: Env, address: string): Promise<boolean> =>
    set.has(address.toLowerCase());
}
const denyAll = async (): Promise<boolean> => false;

/** A distinct minimal "PDF" — starts with the `%PDF-` magic so it
 *  passes `validateLegalDocument`; the marker makes each one's hash
 *  unique. */
function pdfBytes(marker: string): Uint8Array {
  return new Uint8Array([
    0x25, 0x50, 0x44, 0x46, 0x2d, // '%PDF-'
    ...new TextEncoder().encode(marker),
  ]);
}

/** Build a signed legal-hold payload. `signer` produces the
 *  signature; the on-chain admin check is mocked separately via
 *  `adminOf`. For a `place`, pass `legalDocSha256` (the hash of the
 *  PDF that will be uploaded alongside). */
async function signedLegalHold(
  signer: PrivateKeyAccount,
  req: {
    action: 'place' | 'lift' | 'set-disclosure';
    wallet: string;
    holdReason?: string;
    disclosureAllowed?: boolean;
    disclosureNote?: string;
    legalDocSha256?: string;
    issuedAt?: number;
  },
): Promise<Record<string, unknown>> {
  const issuedAt = req.issuedAt ?? nowSec();
  const full: Parameters<typeof buildLegalHoldMessage>[0] = {
    ...req,
    issuedAt,
    signature: '0x',
  };
  const signature = await signer.signMessage({
    message: buildLegalHoldMessage(full),
  });
  return { ...req, issuedAt, signature };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** A `multipart/form-data` POST: the signed `payload` JSON plus an
 *  optional `document` PDF part — the shape the protocol console
 *  sends for a `place`. */
function postMultipart(
  path: string,
  payload: unknown,
  document?: Uint8Array,
): Request {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  if (document) {
    form.append(
      'document',
      new Blob([document], { type: 'application/pdf' }),
      'order.pdf',
    );
  }
  return new Request('https://agent.test' + path, {
    method: 'POST',
    body: form,
  });
}

/** Build a body whose signature is genuinely produced by `account`. */
async function signedBody(
  account: PrivateKeyAccount,
  issuedAt: number = nowSec(),
  walletOverride?: string,
): Promise<{ wallet: string; issuedAt: number; signature: string }> {
  const wallet = walletOverride ?? account.address;
  const message = buildErasureMessage(wallet, issuedAt);
  const signature = await account.signMessage({ message });
  return { wallet, issuedAt, signature };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://agent.test' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** Seed N error rows for an address; returns the address's hash. */
async function seedErrors(db: FakeD1, address: string, count: number): Promise<string> {
  const hash = await walletHash(address, HMAC_KEY);
  for (let i = 0; i < count; i++) {
    db.errors.push({ id: `${address}-${i}`, wallet_hash: hash });
  }
  return hash;
}

// ─── buildErasureMessage ───────────────────────────────────────────

describe('buildErasureMessage', () => {
  it('lower-cases the wallet so checksummed and lowercase agree', () => {
    const checksummed = '0xAbC0000000000000000000000000000000000123';
    const msg = buildErasureMessage(checksummed, 1747000000);
    expect(msg).toContain('Wallet: ' + checksummed.toLowerCase());
    expect(buildErasureMessage(checksummed.toLowerCase(), 1747000000)).toBe(msg);
  });

  it('is a stable, frozen format (drift would break every signature)', () => {
    expect(
      buildErasureMessage('0x1111000000000000000000000000000000001111', 1747000000),
    ).toBe(
      [
        'Vaipakam — Erase my error-diagnostics records',
        '',
        'I request erasure of the server-side error-capture records',
        'associated with the wallet below. Signing this message proves',
        'ownership of the wallet. It is not a transaction and costs no gas.',
        '',
        'Wallet: 0x1111000000000000000000000000000000001111',
        'Issued at (unix): 1747000000',
      ].join('\n'),
    );
  });
});

// ─── POST /diag/erasure ────────────────────────────────────────────

describe('handleDiagErasure', () => {
  let db: FakeD1;
  beforeEach(() => {
    db = new FakeD1();
  });

  it('deletes the caller’s records on a valid signed request', async () => {
    await seedErrors(db, ACCOUNT_A.address, 3);
    await seedErrors(db, ACCOUNT_B.address, 2);

    const res = await handleDiagErasure(
      post('/diag/erasure', await signedBody(ACCOUNT_A)),
      makeEnv(db),
      CORS,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'processed' });
    // A's rows gone, B's untouched.
    expect(db.errors.filter((e) => e.id.startsWith(ACCOUNT_A.address))).toHaveLength(0);
    expect(db.errors.filter((e) => e.id.startsWith(ACCOUNT_B.address))).toHaveLength(2);
  });

  it('INVARIANT: a legal hold retains records but the response is byte-identical', async () => {
    // Baseline — no hold, capture the exact response.
    await seedErrors(db, ACCOUNT_A.address, 3);
    const noHoldRes = await handleDiagErasure(
      post('/diag/erasure', await signedBody(ACCOUNT_A)),
      makeEnv(db),
      CORS,
    );
    const noHoldBody = await noHoldRes.text();

    // Held case — fresh DB, place a hold, then erase.
    const db2 = new FakeD1();
    const hash = await seedErrors(db2, ACCOUNT_A.address, 3);
    db2.holds.push({
      wallet_hash: hash,
      hold_reason: 'court order 2026-XYZ',
      disclosure_allowed: 0,
      disclosure_note: null,
      created_at: nowSec(),
      updated_at: nowSec(),
    });
    const heldRes = await handleDiagErasure(
      post('/diag/erasure', await signedBody(ACCOUNT_A)),
      makeEnv(db2),
      CORS,
    );
    const heldBody = await heldRes.text();

    // The records were NOT deleted...
    expect(db2.errors).toHaveLength(3);
    // ...but the response is indistinguishable from the no-hold case.
    expect(heldRes.status).toBe(noHoldRes.status);
    expect(heldBody).toBe(noHoldBody);
  });

  it('rejects a stale timestamp with 400', async () => {
    const res = await handleDiagErasure(
      post('/diag/erasure', await signedBody(ACCOUNT_A, nowSec() - 3600)),
      makeEnv(db),
      CORS,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('verification_failed');
  });

  it('rejects a signature that recovers to a different wallet with 400', async () => {
    // A signs a message naming B's wallet → recovery yields A ≠ B.
    const body = await signedBody(ACCOUNT_A, nowSec(), ACCOUNT_B.address);
    const res = await handleDiagErasure(
      post('/diag/erasure', body),
      makeEnv(db),
      CORS,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a malformed signature with 400', async () => {
    const res = await handleDiagErasure(
      post('/diag/erasure', {
        wallet: ACCOUNT_A.address,
        issuedAt: nowSec(),
        signature: '0x' + 'ab'.repeat(65),
      }),
      makeEnv(db),
      CORS,
    );
    expect(res.status).toBe(400);
  });

  it('returns 503 when the HMAC key is not configured', async () => {
    const res = await handleDiagErasure(
      post('/diag/erasure', await signedBody(ACCOUNT_A)),
      makeEnv(db, { DIAG_WALLET_HMAC_KEY: undefined }),
      CORS,
    );
    expect(res.status).toBe(503);
  });
});

// ─── POST /diag/erasure/status ─────────────────────────────────────

describe('handleDiagErasureStatus', () => {
  let db: FakeD1;
  beforeEach(() => {
    db = new FakeD1();
  });

  it('returns the uniform payload when there is no hold', async () => {
    const res = await handleDiagErasureStatus(
      post('/diag/erasure/status', await signedBody(ACCOUNT_A)),
      makeEnv(db),
      CORS,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'processed' });
  });

  it('GAG-SAFE: a hold with disclosure off is indistinguishable from no hold', async () => {
    const hash = await walletHash(ACCOUNT_A.address, HMAC_KEY);
    db.holds.push({
      wallet_hash: hash,
      hold_reason: 'gagged investigation',
      disclosure_allowed: 0,
      disclosure_note: null,
      created_at: nowSec(),
      updated_at: nowSec(),
    });
    const res = await handleDiagErasureStatus(
      post('/diag/erasure/status', await signedBody(ACCOUNT_A)),
      makeEnv(db),
      CORS,
    );
    expect(await res.json()).toEqual({ status: 'processed' });
  });

  it('surfaces the retained-by-law note only when disclosure is enabled', async () => {
    const hash = await walletHash(ACCOUNT_A.address, HMAC_KEY);
    db.holds.push({
      wallet_hash: hash,
      hold_reason: 'tax retention',
      disclosure_allowed: 1,
      disclosure_note: 'Records retained per a 2026 retention order.',
      created_at: nowSec(),
      updated_at: nowSec(),
    });
    const res = await handleDiagErasureStatus(
      post('/diag/erasure/status', await signedBody(ACCOUNT_A)),
      makeEnv(db),
      CORS,
    );
    expect(await res.json()).toEqual({
      status: 'retained_by_law',
      note: 'Records retained per a 2026 retention order.',
    });
  });

  it('falls back to the default note when disclosure_note is null', async () => {
    const hash = await walletHash(ACCOUNT_A.address, HMAC_KEY);
    db.holds.push({
      wallet_hash: hash,
      hold_reason: 'tax retention',
      disclosure_allowed: 1,
      disclosure_note: null,
      created_at: nowSec(),
      updated_at: nowSec(),
    });
    const res = await handleDiagErasureStatus(
      post('/diag/erasure/status', await signedBody(ACCOUNT_A)),
      makeEnv(db),
      CORS,
    );
    const body = await res.json() as { status: string; note: string };
    expect(body.status).toBe('retained_by_law');
    expect(body.note.length).toBeGreaterThan(0);
  });
});

// ─── POST /diag/legal-hold ─────────────────────────────────────────
//
// ACCOUNT_A is the protocol admin (the request signer + the address
// the injected verifier authorises). ACCOUNT_B is the held user.

describe('handleDiagLegalHold', () => {
  let db: FakeD1;
  beforeEach(() => {
    db = new FakeD1();
  });

  // The real on-chain ADMIN_ROLE check is mocked: A is an admin.
  const verify = adminOf(ACCOUNT_A);

  /** Place a hold the normal way — multipart upload of a PDF whose
   *  hash the admin signed. Returns the Response + the PDF's hash. */
  async function placeHold(
    env: Env,
    marker: string,
    holdReason = 'court order ' + marker,
  ): Promise<{ res: Response; sha: string }> {
    const pdf = pdfBytes(marker);
    const sha = await sha256Hex(pdf);
    const res = await handleDiagLegalHold(
      postMultipart(
        '/diag/legal-hold',
        await signedLegalHold(ACCOUNT_A, {
          action: 'place',
          wallet: ACCOUNT_B.address,
          holdReason,
          legalDocSha256: sha,
        }),
        pdf,
      ),
      env,
      CORS,
      verify,
    );
    return { res, sha };
  }

  it('places (with an uploaded PDF), then lifts — and audits both', async () => {
    const { res: placeRes } = await placeHold(makeEnv(db), 'order-1');
    expect(placeRes.status).toBe(200);
    const hash = await walletHash(ACCOUNT_B.address, HMAC_KEY);
    expect(db.holds.find((h) => h.wallet_hash === hash)?.disclosure_allowed).toBe(0);

    const liftRes = await handleDiagLegalHold(
      post('/diag/legal-hold', await signedLegalHold(ACCOUNT_A, {
        action: 'lift',
        wallet: ACCOUNT_B.address,
      })),
      makeEnv(db),
      CORS,
      verify,
    );
    expect(liftRes.status).toBe(200);
    expect(db.holds).toHaveLength(0);

    // Both actions are on the immutable audit trail, attributed to
    // the signing admin.
    expect(db.audit.map((r) => r.action)).toEqual(['place', 'lift']);
    expect(db.audit.every((r) => r.admin_wallet === ACCOUNT_A.address.toLowerCase())).toBe(true);
    expect(db.audit.every((r) => r.wallet_hash === hash)).toBe(true);
  });

  it('uploads the PDF to R2 and auto-records ref + hash on hold, audit, response', async () => {
    const r2 = new FakeR2();
    const env = makeEnv(db, { DIAG_LEGAL_DOCS: r2 as unknown as R2Bucket });
    const { res, sha } = await placeHold(env, 'order-2', 'court order 2026-XYZ');
    expect(res.status).toBe(200);

    const expectedRef = `legal-holds/${sha}.pdf`;
    // The PDF is in R2 under its content-addressed key.
    expect(r2.store.has(expectedRef)).toBe(true);
    // ref + hash auto-recorded on the hold — hold_reason kept too.
    const hash = await walletHash(ACCOUNT_B.address, HMAC_KEY);
    const hold = db.holds.find((h) => h.wallet_hash === hash);
    expect(hold?.hold_reason).toBe('court order 2026-XYZ');
    expect(hold?.legal_doc_ref).toBe(expectedRef);
    expect(hold?.legal_doc_sha256).toBe(sha);
    // ...on the audit row...
    const auditRow = db.audit.find((r) => r.action === 'place');
    expect(auditRow?.legal_doc_ref).toBe(expectedRef);
    expect(auditRow?.legal_doc_sha256).toBe(sha);
    // ...and echoed back so the console can show the admin.
    expect(await res.json()).toMatchObject({
      ok: true,
      legalDocRef: expectedRef,
      legalDocSha256: sha,
    });
  });

  it('toggles the per-wallet disclosure flag via set-disclosure', async () => {
    await placeHold(makeEnv(db), 'order-3', 'tax retention');
    const res = await handleDiagLegalHold(
      post('/diag/legal-hold', await signedLegalHold(ACCOUNT_A, {
        action: 'set-disclosure',
        wallet: ACCOUNT_B.address,
        disclosureAllowed: true,
        disclosureNote: 'custom note',
      })),
      makeEnv(db),
      CORS,
      verify,
    );
    expect(res.status).toBe(200);
    const hash = await walletHash(ACCOUNT_B.address, HMAC_KEY);
    const hold = db.holds.find((h) => h.wallet_hash === hash);
    expect(hold?.disclosure_allowed).toBe(1);
    expect(hold?.disclosure_note).toBe('custom note');
    expect(db.audit.some((r) => r.action === 'set-disclosure')).toBe(true);
  });

  it('returns 404 for set-disclosure on a wallet with no hold', async () => {
    const res = await handleDiagLegalHold(
      post('/diag/legal-hold', await signedLegalHold(ACCOUNT_A, {
        action: 'set-disclosure',
        wallet: ACCOUNT_B.address,
        disclosureAllowed: true,
      })),
      makeEnv(db),
      CORS,
      verify,
    );
    expect(res.status).toBe(404);
  });

  it('requires a document to place a hold (400 when none is uploaded)', async () => {
    // A `place` sent as plain JSON — no `document` part. Otherwise
    // a well-formed, validly-signed request.
    const pdf = pdfBytes('order-6');
    const sha = await sha256Hex(pdf);
    const res = await handleDiagLegalHold(
      post('/diag/legal-hold', await signedLegalHold(ACCOUNT_A, {
        action: 'place',
        wallet: ACCOUNT_B.address,
        holdReason: 'order with no document uploaded',
        legalDocSha256: sha,
      })),
      makeEnv(db),
      CORS,
      verify,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('document_required');
    expect(db.holds).toHaveLength(0);
  });

  it('rejects an uploaded document whose hash != the signed hash', async () => {
    // Admin signs the hash of PDF X but uploads PDF Y.
    const pdfX = pdfBytes('the-real-order');
    const shaX = await sha256Hex(pdfX);
    const pdfY = pdfBytes('a-different-document');
    const res = await handleDiagLegalHold(
      postMultipart(
        '/diag/legal-hold',
        await signedLegalHold(ACCOUNT_A, {
          action: 'place',
          wallet: ACCOUNT_B.address,
          holdReason: 'order',
          legalDocSha256: shaX,
        }),
        pdfY,
      ),
      makeEnv(db),
      CORS,
      verify,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('document_hash_mismatch');
    expect(db.holds).toHaveLength(0);
  });

  it('rejects a document that is not a PDF with 400', async () => {
    const notPdf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const sha = await sha256Hex(notPdf);
    const res = await handleDiagLegalHold(
      postMultipart(
        '/diag/legal-hold',
        await signedLegalHold(ACCOUNT_A, {
          action: 'place',
          wallet: ACCOUNT_B.address,
          holdReason: 'order',
          legalDocSha256: sha,
        }),
        notPdf,
      ),
      makeEnv(db),
      CORS,
      verify,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('invalid_document');
  });

  it('returns 503 when the R2 document store is not configured', async () => {
    const pdf = pdfBytes('order-10');
    const sha = await sha256Hex(pdf);
    const res = await handleDiagLegalHold(
      postMultipart(
        '/diag/legal-hold',
        await signedLegalHold(ACCOUNT_A, {
          action: 'place',
          wallet: ACCOUNT_B.address,
          holdReason: 'order',
          legalDocSha256: sha,
        }),
        pdf,
      ),
      makeEnv(db, { DIAG_LEGAL_DOCS: undefined }),
      CORS,
      verify,
    );
    expect(res.status).toBe(503);
  });

  it('rejects a malformed legalDocSha256 with 400', async () => {
    const res = await handleDiagLegalHold(
      post('/diag/legal-hold', {
        action: 'place',
        wallet: ACCOUNT_B.address,
        holdReason: 'x',
        legalDocSha256: 'not-a-hash',
        issuedAt: nowSec(),
        signature: '0x' + 'ab'.repeat(65),
      }),
      makeEnv(db),
      CORS,
      verify,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a signer who does not hold ADMIN_ROLE with 403', async () => {
    // B signs a well-formed lift, but the verifier only knows A.
    const res = await handleDiagLegalHold(
      post('/diag/legal-hold', await signedLegalHold(ACCOUNT_B, {
        action: 'lift',
        wallet: ACCOUNT_B.address,
      })),
      makeEnv(db),
      CORS,
      verify,
    );
    expect(res.status).toBe(403);
  });

  it('rejects everyone when no wallet holds ADMIN_ROLE (pre-deploy state)', async () => {
    const res = await handleDiagLegalHold(
      post('/diag/legal-hold', await signedLegalHold(ACCOUNT_A, {
        action: 'lift',
        wallet: ACCOUNT_B.address,
      })),
      makeEnv(db),
      CORS,
      denyAll,
    );
    expect(res.status).toBe(403);
  });

  it('rejects a malformed signature with 400', async () => {
    const res = await handleDiagLegalHold(
      post('/diag/legal-hold', {
        action: 'lift',
        wallet: ACCOUNT_B.address,
        issuedAt: nowSec(),
        signature: '0x' + 'ab'.repeat(65),
      }),
      makeEnv(db),
      CORS,
      verify,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a stale request with 400', async () => {
    const res = await handleDiagLegalHold(
      post('/diag/legal-hold', await signedLegalHold(ACCOUNT_A, {
        action: 'lift',
        wallet: ACCOUNT_B.address,
        issuedAt: nowSec() - 3600,
      })),
      makeEnv(db),
      CORS,
      verify,
    );
    expect(res.status).toBe(400);
  });

  it('returns 503 when the HMAC key is not configured', async () => {
    const res = await handleDiagLegalHold(
      post('/diag/legal-hold', await signedLegalHold(ACCOUNT_A, {
        action: 'lift',
        wallet: ACCOUNT_B.address,
      })),
      makeEnv(db, { DIAG_WALLET_HMAC_KEY: undefined }),
      CORS,
      verify,
    );
    expect(res.status).toBe(503);
  });

  it('end-to-end: hold blocks erasure, lifting it restores erasure', async () => {
    await seedErrors(db, ACCOUNT_B.address, 4);

    // Admin places a hold (with the uploaded order) → B's erasure retains.
    await placeHold(makeEnv(db), 'order-e2e');
    await handleDiagErasure(
      post('/diag/erasure', await signedBody(ACCOUNT_B)),
      makeEnv(db),
      CORS,
    );
    expect(db.errors).toHaveLength(4);

    // Admin lifts the hold → B's erasure now deletes.
    await handleDiagLegalHold(
      post('/diag/legal-hold', await signedLegalHold(ACCOUNT_A, {
        action: 'lift',
        wallet: ACCOUNT_B.address,
      })),
      makeEnv(db),
      CORS,
      verify,
    );
    await handleDiagErasure(
      post('/diag/erasure', await signedBody(ACCOUNT_B)),
      makeEnv(db),
      CORS,
    );
    expect(db.errors).toHaveLength(0);
  });
});
