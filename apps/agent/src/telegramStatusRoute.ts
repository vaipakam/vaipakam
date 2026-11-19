/**
 * #3573 — the owner's own Telegram status, read from the agent.
 *
 * The apps used to show "linked" from a flag kept in the browser, which is
 * wrong whenever the link changed somewhere else: another device, a chat
 * removed after the protected-mode wait, or links the agent no longer holds.
 * The agent's Telegram state is the one source, so the apps read it here.
 *
 * Whether a wallet has Telegram alerts, and when a protected owner's chat is
 * about to change, is the owner's own business, so the read is not open:
 *
 *   - `POST /telegram/status` takes a signed request (the frozen
 *     `buildTelegramStatusMessage`), answers the status of the signed chain,
 *     and issues a read pass.
 *   - `POST /telegram/status/pass` takes that pass and a chain id and answers
 *     the status again, so the app can refresh the card without asking for
 *     another signature each time it is shown.
 *
 * A pass is 32 random bytes; only its SHA-256 is kept, in the agent's
 * Telegram state, with the scope the signer had: a plain wallet signature
 * covers every chain, a smart account's approval covers the signed chain
 * only (the same rule unlinking and the alert phrase follow). A pass reads;
 * it changes nothing, and it lasts {@link READ_PASS_TTL_SEC}.
 *
 * The answer never carries a chat id or the alert phrase: only whether a chat
 * is linked, the removal or move pending for it and when it takes effect,
 * and whether a phrase is set.
 */
import type { LinkStatus, ReadPassScope } from './telegramState/store';

/** How long a read pass lasts: one working day of the app left open. */
export const READ_PASS_TTL_SEC = 12 * 3600;

/** The length of a pass, in characters of base64url (32 bytes). */
const PASS_CHARS = 43;
const PASS_RE = /^[A-Za-z0-9_-]{43}$/;

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The digest a pass is kept under. */
export async function readPassHash(pass: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pass)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A fresh pass and its digest. */
export async function newReadPass(): Promise<{ pass: string; hash: string }> {
  const pass = base64url(crypto.getRandomValues(new Uint8Array(32)));
  if (pass.length !== PASS_CHARS) throw new Error('read pass length');
  return { pass, hash: await readPassHash(pass) };
}

/** The pass request body: `{ pass, chain_id }`, or a reason it is not one. */
export function parsePassRequest(
  body: unknown,
): { ok: true; pass: string; chainId: number } | { ok: false; reason: string } {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'body' };
  const b = body as Record<string, unknown>;
  if (typeof b.pass !== 'string' || !PASS_RE.test(b.pass)) return { ok: false, reason: 'pass' };
  const chainId = b.chain_id;
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) {
    return { ok: false, reason: 'chain_id' };
  }
  return { ok: true, pass: b.pass, chainId };
}

/** What the status routes need from the agent's Telegram state. */
export interface StatusStatePort {
  issueReadPass(passHash: string, wallet: string, chainId: number | null, expiresAt: number, now: number): Promise<void>;
  readPassScope(passHash: string, now: number): Promise<ReadPassScope | null>;
  linkStatus(wallet: string, chainId: number): Promise<LinkStatus>;
}

/** The answer to the signed read: the signed chain's status and a pass. */
export interface SignedStatusAnswer {
  wallet: string;
  status: LinkStatus;
  pass: string;
  passExpiresAt: number;
  /** `wallet`: the pass reads every chain; `chain`: the signed one only. */
  scope: 'wallet' | 'chain';
}

/** After an authorised signed read: issue a pass under the signer's scope
 *  and answer the signed chain's status. */
export async function answerSignedStatus(
  state: StatusStatePort,
  wallet: string,
  chainId: number,
  via: 'ecdsa' | 'chain',
  now: number,
): Promise<SignedStatusAnswer> {
  const { pass, hash } = await newReadPass();
  const expiresAt = now + READ_PASS_TTL_SEC;
  const scope = via === 'chain' ? 'chain' : 'wallet';
  await state.issueReadPass(hash, wallet, scope === 'chain' ? chainId : null, expiresAt, now);
  return {
    wallet: wallet.toLowerCase(),
    status: await state.linkStatus(wallet, chainId),
    pass,
    passExpiresAt: expiresAt,
    scope,
  };
}

/** The answer to a pass read: the status, or why the pass cannot read it. */
export type PassStatusAnswer =
  | { ok: true; wallet: string; status: LinkStatus }
  | { ok: false; error: 'pass-expired' | 'pass-other-chain' };

/** Read `chainId`'s status with a pass. An unknown or expired pass, and a
 *  chain-scoped pass asked about another chain, are refused. */
export async function answerPassStatus(
  state: StatusStatePort,
  pass: string,
  chainId: number,
  now: number,
): Promise<PassStatusAnswer> {
  const scope = await state.readPassScope(await readPassHash(pass), now);
  if (!scope) return { ok: false, error: 'pass-expired' };
  if (scope.chainId !== null && scope.chainId !== chainId) return { ok: false, error: 'pass-other-chain' };
  return { ok: true, wallet: scope.wallet, status: await state.linkStatus(scope.wallet, chainId) };
}
