/**
 * #1722 — the Telegram messages the keeper asks the agent to send, as data.
 *
 * The agent is the only Worker that talks to Telegram: it holds the bot token
 * and the wallet-to-chat links. The keeper decides WHAT to say (a health
 * factor crossed a band, a LOCK came to an outcome, a protected payout was
 * queued) and posts it to the agent's keeper-only route as one of the
 * {@link TelegramAlert} shapes below. The agent validates it, renders it in
 * the owner's language from the shared catalogues here, and sends it to the
 * chat linked to the wallet.
 *
 * WHY DATA AND NOT TEXT. Whoever holds the keeper's route token could
 * otherwise send any text to every linked chat, a phishing channel into the
 * one place an owner trusts for alerts. As data, the route can only ever send
 * the protocol's own fixed wording, and every value filled into it is checked
 * here: addresses are addresses, numbers are numbers, and the few free fields
 * (an asset description, a refusal name) are limited to a plain character set
 * that cannot form a link (no `/`, `:` or `@`, and a dot before a letter is
 * shown as a one-dot leader, so a bare domain is never linked). The app link in a message is the agent's own configured
 * origin, never a value from the request.
 */
import { formatAlert, pushTitle } from './hfCopy';
import { protectedCopy, shortAddress } from './protectedCopy';

/** The LOCK outcomes the keeper reports (`protectedTelegram.ts`). */
export const LOCK_OUTCOMES = ['locked', 'locked-again', 'already-locked', 'not-protected', 'not-allowed', 'expired', 'refused'] as const;
export type LockOutcomeKind = (typeof LOCK_OUTCOMES)[number];

/** One message, as the keeper posts it. `wallet` names the vault the message
 *  is about; the agent sends to the chat linked to `wallet` on `chainId`
 *  unless `to` names the wallet whose chat receives it (a protected account's
 *  manager). */
export type TelegramAlert =
  | { kind: 'hf'; band: 'warn' | 'alert' | 'critical'; loanId: number; hf: number }
  | { kind: 'preGrace'; loanId: number; hoursToEnd: number }
  | { kind: 'lock'; outcome: LockOutcomeKind; reason?: string }
  | { kind: 'locked'; by: string | null }
  | { kind: 'replacement'; nominee: string; by: string }
  | { kind: 'payout'; what: string; recipient: string; releaseAt: number; code: string; lockHint: boolean };

/** A message with where it goes. */
export interface AddressedAlert {
  chainId: number;
  wallet: string;
  /** The wallet whose chat receives it; `wallet` when absent. */
  to?: string;
  alert: TelegramAlert;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Free text filled into a message: letters, digits, spaces and the few marks
 *  an amount or token label needs. No `/` or `:`, so no link can be formed. */
const PLAIN = /^[\p{L}\p{N} .,#×()_\-…?]{1,96}$/u;
/** A dot before a letter, as in a bare domain (`evil.example`). Telegram makes
 *  a bare domain a link, so such a dot is shown as a one-dot leader (`․`),
 *  which keeps a token label such as `USDC.e` readable and never links. */
const DOMAIN_DOT = /\.(?=\p{L})/gu;
const NAME = /^[A-Za-z0-9_]{1,64}$/;
const CODE = /^[A-Z0-9-]{1,24}$/;

const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Parse one posted message; null when any field is out of shape. */
export function parseAddressedAlert(raw: unknown): AddressedAlert | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isInt(r.chainId, 1, 2 ** 40)) return null;
  if (typeof r.wallet !== 'string' || !ADDRESS.test(r.wallet)) return null;
  if (r.to !== undefined && (typeof r.to !== 'string' || !ADDRESS.test(r.to))) return null;
  const alert = parseAlert(r.alert);
  if (!alert) return null;
  return { chainId: r.chainId, wallet: r.wallet.toLowerCase(), ...(r.to ? { to: (r.to as string).toLowerCase() } : {}), alert };
}

function parseAlert(raw: unknown): TelegramAlert | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  switch (a.kind) {
    case 'hf':
      if (a.band !== 'warn' && a.band !== 'alert' && a.band !== 'critical') return null;
      if (!isInt(a.loanId, 0, Number.MAX_SAFE_INTEGER)) return null;
      if (typeof a.hf !== 'number' || !Number.isFinite(a.hf) || a.hf < 0 || a.hf > 1e6) return null;
      return { kind: 'hf', band: a.band, loanId: a.loanId, hf: a.hf };
    case 'preGrace':
      if (!isInt(a.loanId, 0, Number.MAX_SAFE_INTEGER) || !isInt(a.hoursToEnd, 0, 24 * 365)) return null;
      return { kind: 'preGrace', loanId: a.loanId, hoursToEnd: a.hoursToEnd };
    case 'lock':
      if (!(LOCK_OUTCOMES as readonly unknown[]).includes(a.outcome)) return null;
      if (a.outcome === 'refused') {
        if (typeof a.reason !== 'string' || !NAME.test(a.reason)) return null;
        return { kind: 'lock', outcome: 'refused', reason: a.reason };
      }
      return { kind: 'lock', outcome: a.outcome as LockOutcomeKind };
    case 'locked':
      if (a.by !== null && (typeof a.by !== 'string' || !ADDRESS.test(a.by))) return null;
      return { kind: 'locked', by: a.by === null ? null : (a.by as string).toLowerCase() };
    case 'replacement':
      if (typeof a.nominee !== 'string' || !ADDRESS.test(a.nominee)) return null;
      if (typeof a.by !== 'string' || !ADDRESS.test(a.by)) return null;
      return { kind: 'replacement', nominee: a.nominee.toLowerCase(), by: a.by.toLowerCase() };
    case 'payout':
      if (typeof a.what !== 'string' || !PLAIN.test(a.what)) return null;
      if (typeof a.recipient !== 'string' || !ADDRESS.test(a.recipient)) return null;
      if (!isInt(a.releaseAt, 0, 2 ** 40)) return null;
      if (typeof a.code !== 'string' || !CODE.test(a.code)) return null;
      if (typeof a.lockHint !== 'boolean') return null;
      return { kind: 'payout', what: a.what.replace(DOMAIN_DOT, '\u2024'), recipient: a.recipient.toLowerCase(), releaseAt: a.releaseAt, code: a.code, lockHint: a.lockHint };
    default:
      return null;
  }
}

/** What the agent fills in that the keeper does not choose. */
export interface RenderContext {
  locale: string | null | undefined;
  /** A chain's display name ("Base Sepolia"); the id when unknown. */
  chainName: string;
  /** The app's own origin, from the agent's configuration. */
  appOrigin: string;
}

/** The text and the Push title of a message. */
export function renderTelegramAlert(m: AddressedAlert, ctx: RenderContext): { text: string; title: string } {
  const a = m.alert;
  const copy = protectedCopy(ctx.locale);
  const w = shortAddress(m.wallet);
  const c = m.chainId;
  switch (a.kind) {
    case 'hf':
      return {
        text: formatAlert(a.band, ctx.locale, { chainName: ctx.chainName, loanId: a.loanId, hf: a.hf, frontendOrigin: ctx.appOrigin }),
        title: pushTitle(a.band, ctx.locale),
      };
    case 'preGrace':
      return { text: formatPreGraceWarning(ctx.chainName, a.loanId, a.hoursToEnd, ctx.appOrigin), title: 'Auto-refinance: no match found yet' };
    case 'lock': {
      const text =
        a.outcome === 'locked'
          ? copy.lockDone(w, c)
          : a.outcome === 'locked-again'
            ? copy.lockAgain(w, c)
            : a.outcome === 'already-locked'
              ? copy.lockAlready(w, c)
              : a.outcome === 'not-protected'
                ? copy.lockNotProtected(w, c)
                : a.outcome === 'not-allowed'
                  ? copy.lockNotAllowed(w, c)
                  : a.outcome === 'expired'
                    ? copy.lockExpired(w, c)
                    : copy.lockRefused(w, c, a.reason ?? 'unknown');
      return { text, title: copy.pushTitle };
    }
    case 'locked':
      return {
        text: a.by === null || a.by === m.wallet || a.by === m.to ? copy.alertLockedByOwner(w, c) : copy.alertLockedBy(w, c, a.by),
        title: copy.pushTitle,
      };
    case 'replacement':
      return { text: copy.alertReplacement(w, c, a.nominee, a.by), title: copy.pushTitle };
    case 'payout': {
      const when = new Date(a.releaseAt * 1000).toISOString().slice(0, 16).replace('T', ' ');
      return { text: copy.alertPayout(w, c, a.what, a.recipient, when, a.code, a.lockHint), title: copy.pushTitle };
    }
  }
}

/** The pre-grace warning (moved from the keeper's pre-grace watcher). English
 *  only for now, as it was. */
export function formatPreGraceWarning(chainName: string, loanId: number, hoursToEnd: number, frontendOrigin: string): string {
  return [
    `⚠️ Auto-refinance pre-grace warning`,
    ``,
    `Your loan #${loanId} on ${chainName} enters its grace period in ~${hoursToEnd}h.`,
    `Auto-refinance is best-effort — if no compatible lender offer is matched before grace expires, your loan will default.`,
    ``,
    `What to do now:`,
    `• Open ${frontendOrigin}/loans/${loanId} to review terms`,
    `• Tighten your refinance caps if the market has moved`,
    `• Or repay manually before grace ends to avoid liquidation`,
  ].join('\n');
}
