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
import {
  STANDING_INSTRUCTIONS,
  STANDING_SKIP_REASONS,
  standingCopy,
  type StandingInstruction,
  type StandingSkipReason,
} from './standingCopy';

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
  | { kind: 'payout'; what: string; recipient: string; releaseAt: number; code: string; lockHint: boolean }
  /** #3681 — the reserve an instruction spends is too low for what it will
   *  next pay. `missing` (an amount with its token) is the shortfall of the
   *  payment reserve against what is due at `dueAt`, or null when the reserve
   *  is EMPTY. A top-up has no amount due, so it is only ever reported empty;
   *  `dueAt` is when the repayment or interest falls due, null for a top-up. */
  | { kind: 'standingReserveLow'; loanId: number; instruction: StandingInstruction; missing: string | null; dueAt: number | null }
  /** #3681 — a collateral top-up ran (`CollateralTopUpRun`). Amounts are
   *  written out with their token; `hfAfter` is null when the contract could
   *  not read it (the event's 0). */
  | { kind: 'standingTopUp'; loanId: number; amount: string; hfBefore: number; hfAfter: number | null; reserveLeft: string }
  /** #3681 — an instruction landed and changed nothing
   *  (`StandingInstructionSkipped`). `missing` is the reserve's shortfall when
   *  the reason is a short reserve and the keeper could write it out. */
  | { kind: 'standingSkipped'; loanId: number; instruction: StandingInstruction; reason: StandingSkipReason; missing: string | null };

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

/** `s` reduced to what a free field of a message accepts (`PLAIN`): every
 *  other character dropped, spaces collapsed, at most 96 characters. Null when
 *  nothing is left. The keeper fills a payout's asset description from a
 *  token's own symbol, which any deployer chooses, so it reduces it here
 *  rather than have the agent refuse the whole alert. */
export function plainField(s: string): string | null {
  const kept = [...s.replace(/\s+/g, ' ')].filter((ch) => PLAIN.test(ch)).join('').trim();
  const cut = [...kept].slice(0, 96).join('').trim();
  return cut.length > 0 && PLAIN.test(cut) ? cut : null;
}
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
    case 'standingReserveLow': {
      if (!isInt(a.loanId, 0, Number.MAX_SAFE_INTEGER) || !isInstruction(a.instruction)) return null;
      const missing = plainOrNull(a.missing);
      const dueAt = a.dueAt === null ? null : isInt(a.dueAt, 1, 2 ** 40) ? a.dueAt : undefined;
      if (missing === undefined || dueAt === undefined) return null;
      // A top-up spends no known amount at no known time: only "empty" fits.
      if (a.instruction === 'topUp' && (missing !== null || dueAt !== null)) return null;
      // A short reserve is always short of something due at a time.
      if (missing !== null && dueAt === null) return null;
      return { kind: 'standingReserveLow', loanId: a.loanId, instruction: a.instruction, missing, dueAt };
    }
    case 'standingTopUp': {
      if (!isInt(a.loanId, 0, Number.MAX_SAFE_INTEGER)) return null;
      const amount = plainOrNull(a.amount);
      const reserveLeft = plainOrNull(a.reserveLeft);
      if (!amount || !reserveLeft || !isHf(a.hfBefore)) return null;
      if (a.hfAfter !== null && !isHf(a.hfAfter)) return null;
      return { kind: 'standingTopUp', loanId: a.loanId, amount, hfBefore: a.hfBefore, hfAfter: a.hfAfter as number | null, reserveLeft };
    }
    case 'standingSkipped': {
      if (!isInt(a.loanId, 0, Number.MAX_SAFE_INTEGER) || !isInstruction(a.instruction)) return null;
      if (!(STANDING_SKIP_REASONS as readonly unknown[]).includes(a.reason)) return null;
      const missing = plainOrNull(a.missing);
      if (missing === undefined) return null;
      // Only a short reserve has a shortfall to state.
      if (missing !== null && a.reason !== 'reserveShort') return null;
      return { kind: 'standingSkipped', loanId: a.loanId, instruction: a.instruction, reason: a.reason as StandingSkipReason, missing };
    }
    default:
      return null;
  }
}

const isInstruction = (v: unknown): v is StandingInstruction => (STANDING_INSTRUCTIONS as readonly unknown[]).includes(v);
const isHf = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e6;

/** A free amount field: the checked text (a bare domain's dot made a leader),
 *  null when the field is null, undefined when it is out of shape. */
function plainOrNull(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'string' || !PLAIN.test(v)) return undefined;
  return v.replace(DOMAIN_DOT, '\u2024');
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
    case 'standingReserveLow': {
      const s = standingCopy(ctx.locale);
      const l = s.loan(a.loanId, ctx.chainName);
      const link = loanLink(ctx.appOrigin, a.loanId);
      const when = a.dueAt === null ? null : utcMinute(a.dueAt);
      // The parser admits a shortfall only for the repayment or interest, with a time.
      const text =
        a.missing !== null && a.instruction !== 'topUp' && when !== null
          ? s.lowShort(l, a.instruction, a.missing, when, link)
          : s.lowEmpty(l, a.instruction, when, link);
      return { text, title: s.pushTitle };
    }
    case 'standingTopUp': {
      const s = standingCopy(ctx.locale);
      const text = s.topUpRan(
        s.loan(a.loanId, ctx.chainName),
        a.amount,
        a.hfBefore.toFixed(2),
        a.hfAfter === null ? null : a.hfAfter.toFixed(2),
        a.reserveLeft,
        loanLink(ctx.appOrigin, a.loanId),
      );
      return { text, title: s.pushTitle };
    }
    case 'standingSkipped': {
      const s = standingCopy(ctx.locale);
      return {
        text: s.skipped(s.loan(a.loanId, ctx.chainName), a.instruction, a.reason, a.missing, loanLink(ctx.appOrigin, a.loanId)),
        title: s.pushTitle,
      };
    }
  }
}

/** A loan's page in the app, on the agent's own origin. */
const loanLink = (origin: string, loanId: number): string => `${origin}/loans/${loanId}`;
/** Unix seconds as `YYYY-MM-DD HH:MM`, UTC. */
const utcMinute = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ');

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
