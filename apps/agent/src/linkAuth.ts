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
 * Plain threshold writes (bands / push / opted-in saves) stay
 * body-trusted — see the note on the handler in `index.ts`.
 */

import type { Env } from './env';
import {
  LINK_SIGNATURE_MAX_AGE_SECONDS,
  buildDueDateOptOutMessage,
  buildTelegramLinkMessage,
  buildTelegramTestMessage,
  buildTelegramUnlinkMessage,
} from '@vaipakam/lib/alertsMessage';
import {
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
  buildDueDateOptOutMessage,
  buildTelegramLinkMessage,
  buildTelegramTestMessage,
  buildTelegramUnlinkMessage,
};

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export type AlertAuthAction = 'link' | 'unlink' | 'mute-duedate' | 'test-alert';

const MESSAGE_BUILDERS: Record<
  AlertAuthAction,
  (wallet: string, chainId: number, issuedAt: number) => string
> = {
  link: buildTelegramLinkMessage,
  unlink: buildTelegramUnlinkMessage,
  'mute-duedate': buildDueDateOptOutMessage,
  'test-alert': buildTelegramTestMessage,
};

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
  action: AlertAuthAction = 'link',
  checker: ChainSigChecker = verifyOnChain,
  // The chain path's per-IP rate gate (#2013) — handlers pass
  // `chainVerifyGate(env, request)`.
  chainPathAllowed?: () => Promise<boolean>,
): Promise<LinkVerifyResult> {
  if (Math.abs(nowSeconds - req.issuedAt) > LINK_SIGNATURE_MAX_AGE_SECONDS) {
    return { ok: false, status: 400, reason: 'request timestamp is stale' };
  }
  const message = MESSAGE_BUILDERS[action](
    req.wallet,
    req.chain_id,
    req.issuedAt,
  );
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
    return {
      ok: false,
      status: 429,
      reason: 'too many verification attempts — try again shortly',
    };
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
