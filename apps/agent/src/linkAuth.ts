/**
 * #1033 hardening — wallet-ownership proof for the Telegram link
 * handshake.
 *
 * `POST /link/telegram` used to trust the wallet in the JSON body.
 * CORS is not an authentication boundary, so any HTTP caller could
 * issue a link code for ANY wallet and complete the bot handshake to
 * a chat THEY control — subscribing a victim wallet's loan / risk /
 * due-date alerts to an attacker's Telegram, and (since the handshake
 * seeds a thresholds row for first-time wallets) creating watcher
 * state the victim never asked for. The link request therefore
 * carries an EIP-191 `personal_sign` signature over the fixed
 * human-readable message below, naming the wallet, the chain and an
 * `issuedAt` timestamp; the Worker reconstructs the exact message and
 * verifies the wallet authorised it — plain ECDSA recovery for an
 * ordinary wallet, ERC-1271/6492 against the signed `chain_id`'s RPC
 * for a smart account (#2009, via the shared `walletSigVerify`
 * module). Same pattern and same replay window as the
 * diagnostics-erasure endpoints in `diagErasure.ts`.
 *
 * `/unlink/telegram` requires the same proof over its own action-
 * scoped message (round 5): a spoofed-Origin caller could otherwise
 * silently stop a victim wallet's HF / due-date alerts — alert
 * suppression right before a grace window is more than settings
 * churn. And a `PUT /thresholds` that DISABLES the due-date reminder
 * requires it too (round 6) — that flag now silences both due-date
 * lanes, so an unsigned opt-out would be the same suppression through
 * a side door. Every message differs in headline and body text, so a
 * captured signature for one action can never be replayed as another.
 *
 * #2754 — EVERY threshold write is signed now, over a message naming
 * exactly what the save changes (`buildAlertSettingsMessage`); the
 * mute-only message went with it. Before, plain writes trusted the
 * wallet in the body, so a caller with a spoofed Origin could rewrite
 * any wallet's bands and Push opt-in.
 *
 * #2753 — and every signed alert request is accepted ONCE. A valid
 * signature used to stay usable for the whole replay window, so one
 * captured link request could mint fresh link codes for ten minutes.
 * `authoriseAlertRequest` is the one entry the handlers call: it
 * verifies the signature, then claims the exact signed message in the
 * one-time-use ledger (`signedRequestUse.ts`) before anything acts on
 * it. The ledger is keyed on the message itself, so two different
 * requests in the same second are both accepted and a repeat of one
 * is refused.
 */

import type { Env } from './env';
import type { SlotOutcome } from './rateLimit';
import {
  LINK_SIGNATURE_MAX_AGE_SECONDS,
  buildAlertSettingsMessage,
  buildTelegramLinkMessage,
  type AlertSettingsChange,
  buildTelegramTestMessage,
  buildTelegramUnlinkMessage,
} from '@vaipakam/lib/alertsMessage';
import { claimSignedRequest, SignedRequestLedgerUnavailableError } from './signedRequestUse';
import {
  chainVerifyGate,
  limitedRefusal,
  isValidSignatureShape,
  verifyOnChain,
  verifyWalletSignature,
  type ChainSigChecker,
} from './walletSigVerify';

/* The four signed messages + their replay window live in
 * `@vaipakam/lib/alertsMessage` (#2014), the ONE source both this
 * Worker and the connected app import — the erasure family's
 * discipline, applied here. They were duplicated byte-for-byte in
 * `apps/app/src/data/alerts.ts`, held identical only by comments;
 * a one-sided edit rejected every affected signed request in
 * production with nothing catching it before deploy. Re-exported so
 * this module's existing surface (and its tests) are unchanged. */
export {
  LINK_SIGNATURE_MAX_AGE_SECONDS,
  buildAlertSettingsMessage,
  buildTelegramLinkMessage,
  buildTelegramTestMessage,
  buildTelegramUnlinkMessage,
};

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** The alert actions whose message names nothing but the wallet, the
 *  chain and the time. */
export type AlertAuthAction = 'link' | 'unlink' | 'test-alert';

/** What a signed alert request authorises: one of the fixed actions,
 *  or a settings save, whose message also names the values it saves. */
export type AlertAuthorisation =
  | AlertAuthAction
  | { action: 'save-settings'; settings: AlertSettingsChange };

const MESSAGE_BUILDERS: Record<
  AlertAuthAction,
  (wallet: string, chainId: number, issuedAt: number) => string
> = {
  link: buildTelegramLinkMessage,
  unlink: buildTelegramUnlinkMessage,
  'test-alert': buildTelegramTestMessage,
};

/** The exact message the wallet must have signed for `auth`. */
export function alertRequestMessage(
  req: SignedLinkRequest,
  auth: AlertAuthorisation,
): string {
  return typeof auth === 'string'
    ? MESSAGE_BUILDERS[auth](req.wallet, req.chain_id, req.issuedAt)
    : buildAlertSettingsMessage(req.wallet, req.chain_id, auth.settings, req.issuedAt);
}

export interface SignedLinkRequest {
  wallet: string;
  chain_id: number;
  issuedAt: number;
  signature: string;
}

export type LinkParseResult =
  | { ok: true; req: SignedLinkRequest }
  | { ok: false; reason: string };

/** Shape-validate a signed link request body. */
export function parseSignedLinkRequest(body: unknown): LinkParseResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, reason: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.wallet !== 'string' || !ADDRESS_RE.test(b.wallet)) {
    return { ok: false, reason: 'wallet must be a valid address' };
  }
  if (typeof b.chain_id !== 'number' || !Number.isFinite(b.chain_id)) {
    return { ok: false, reason: 'chain_id must be a number' };
  }
  if (
    typeof b.issuedAt !== 'number' ||
    !isFinite(b.issuedAt) ||
    b.issuedAt <= 0
  ) {
    return { ok: false, reason: 'issuedAt must be a positive unix-seconds number' };
  }
  // No longer fixed at 65 bytes (#2009): an ERC-6492 wrapper from a
  // counterfactual smart account is far longer. Shape + cap only —
  // whether it VERIFIES is the next step's question.
  if (!isValidSignatureShape(b.signature)) {
    return { ok: false, reason: 'signature must be 0x-prefixed hex' };
  }
  return {
    ok: true,
    req: {
      wallet: b.wallet,
      chain_id: b.chain_id,
      issuedAt: Math.floor(b.issuedAt),
      signature: b.signature,
    },
  };
}

export type LinkVerifyResult =
  | {
      ok: true;
      /** How the signature verified (#2013 round 3 P1) — 'ecdsa' is
       *  the wallet's universal key, 'chain' is a contract's
       *  approval on the SIGNED chain only. The unlink handler
       *  scopes its effect on this: chain-verified authority must
       *  not clear other chains' rows, whose contracts may have
       *  different controllers. */
      via: 'ecdsa' | 'chain';
    }
  | { ok: false; status: number; reason: string };

/**
 * Verify a parsed signed link request: the timestamp is inside the
 * replay window AND the wallet authorised the action-scoped message —
 * plain ECDSA for an ordinary wallet, ERC-1271/6492 against the
 * signed `chain_id`'s configured RPC for a smart account (#2009).
 * The chain to verify on comes from INSIDE the signed message, so a
 * caller cannot steer verification to a chain the signer never named.
 */
export async function verifySignedLinkRequest(
  req: SignedLinkRequest,
  nowSeconds: number,
  env: Env,
  auth: AlertAuthorisation = 'link',
  checker: ChainSigChecker = verifyOnChain,
  // The chain path's per-IP rate gate (#2013) — handlers pass
  // `chainVerifyGate(env, request)`.
  chainPathAllowed?: () => Promise<SlotOutcome>,
): Promise<LinkVerifyResult> {
  if (Math.abs(nowSeconds - req.issuedAt) > LINK_SIGNATURE_MAX_AGE_SECONDS) {
    return { ok: false, status: 400, reason: 'request timestamp is stale' };
  }
  const message = alertRequestMessage(req, auth);
  const verdict = await verifyWalletSignature(
    env,
    req.wallet,
    message,
    req.signature,
    req.chain_id,
    checker,
    chainPathAllowed,
  );
  if (verdict.ok) return { ok: true, via: verdict.via };
  if (verdict.reason === 'limited') {
    return { ok: false, ...limitedRefusal(verdict.slot) };
  }
  return verdict.reason === 'unavailable'
    ? {
        ok: false,
        status: 503,
        // Honest, not gag-relevant (see walletSigVerify's header): a
        // smart account on a chain this Worker cannot reach — or has
        // no RPC configured for — is unverifiable, not invalid.
        reason: 'signature verification temporarily unavailable',
      }
    : { ok: false, status: 401, reason: 'signature does not match wallet' };
}

/**
 * The one entry every signed alert handler calls (#2753): the
 * signature is verified, then the exact signed message is claimed in
 * the one-time-use ledger, and only a request that wins the claim
 * proceeds. A repeat of a request already accepted is 409; a ledger
 * this deployment cannot reach yet (its migration not applied) is 503,
 * never an unclaimed acceptance.
 *
 * The claim comes AFTER verification, so an unsigned or forged body
 * never writes to the ledger, and BEFORE the action, so two copies of
 * one request racing each other cannot both act.
 */
export async function authoriseAlertRequest(
  httpReq: Request,
  env: Env,
  req: SignedLinkRequest,
  auth: AlertAuthorisation,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  checker: ChainSigChecker = verifyOnChain,
): Promise<LinkVerifyResult> {
  const verified = await verifySignedLinkRequest(
    req,
    nowSeconds,
    env,
    auth,
    checker,
    chainVerifyGate(env, httpReq),
  );
  if (!verified.ok) return verified;
  let claimed: boolean;
  try {
    claimed = await claimSignedRequest(
      env.DB,
      alertRequestMessage(req, auth),
      req.issuedAt + LINK_SIGNATURE_MAX_AGE_SECONDS,
    );
  } catch (err) {
    if (err instanceof SignedRequestLedgerUnavailableError) {
      return {
        ok: false,
        status: 503,
        reason: 'signed-request storage migration pending — try again shortly',
      };
    }
    throw err;
  }
  if (!claimed) {
    return {
      ok: false,
      status: 409,
      reason: 'this signed request was already used — sign again',
    };
  }
  return verified;
}
