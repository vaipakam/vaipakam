/**
 * One-time use of a signed agent request (#2753).
 *
 * A wallet signature over an alert message proves the wallet asked for
 * that action, and the timestamp inside the message bounds WHEN it may
 * be presented. Neither stops the same signed request from being
 * presented again inside that window, so a request captured once (a
 * shared screen, a logged body, a proxy) could be replayed as often as
 * the caller liked: a captured link request minted a fresh link code on
 * every replay.
 *
 * So each accepted request is recorded here, keyed by the SHA-256 of
 * the exact message the wallet signed, and a second presentation of the
 * same message is refused. Keying on the message rather than on the
 * wallet and timestamp means two different requests made in the same
 * second are both accepted, while a repeat of one is not. A row is kept
 * until its request could no longer pass the timestamp check anyway, so
 * clearing old rows never frees a request that is still presentable.
 *
 * The ledger is the shared D1 table `signed_request_use`
 * (apps/indexer/migrations/0076). It holds no wallet, chain or content:
 * only the digest and when the row may go.
 */

/** The table is missing: this deployment's schema predates 0076.
 *  Callers refuse the request (503) rather than accept it unclaimed. */
export class SignedRequestLedgerUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`signed-request ledger unavailable: ${String(cause)}`);
    this.name = 'SignedRequestLedgerUnavailableError';
  }
}

/** A row outlives its request's last valid moment by this margin, so a
 *  clock difference between Worker isolates cannot free a request
 *  early. */
const RETENTION_MARGIN_SECONDS = 60;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isMissingLedger(err: unknown): boolean {
  return /no such table:?\s*signed_request_use/i.test(String(err));
}

/**
 * Claim `message` for one use. Returns `true` when this call recorded
 * it (the request may proceed) and `false` when it was already
 * recorded (a repeat). The insert is one statement, so two copies
 * racing each other cannot both win.
 *
 * `validUntil` is the last unix second at which the request could pass
 * the timestamp check.
 *
 * The same batch drops every row whose request can no longer be
 * presented, so the table stays bounded by recent traffic without a
 * pass on the cron tick, whose request allowance is already counted to
 * the last call (`periodicPreNotify.ts`). A batch is one subrequest.
 */
export async function claimSignedRequest(
  db: D1Database,
  message: string,
  validUntil: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const key = await sha256Hex(message);
  try {
    const [, claim] = await db.batch<{ message_sha256: string }>([
      db.prepare(`DELETE FROM signed_request_use WHERE expires_at < ?`).bind(nowSeconds),
      db
        .prepare(
          `INSERT INTO signed_request_use (message_sha256, expires_at)
           VALUES (?, ?)
           ON CONFLICT (message_sha256) DO NOTHING
           RETURNING message_sha256`,
        )
        .bind(key, validUntil + RETENTION_MARGIN_SECONDS),
    ]);
    return (claim?.results?.length ?? 0) > 0;
  } catch (err) {
    if (isMissingLedger(err)) throw new SignedRequestLedgerUnavailableError(err);
    throw err;
  }
}
