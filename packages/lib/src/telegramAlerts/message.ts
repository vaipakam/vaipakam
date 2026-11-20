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
import { TERMS_HOLDS, termsAnnouncedText, type TermsHold } from './termsCopy';
import { SECURITY_CHANGES, securityChangeText, type SecurityChange } from './securityCopy';
import {
  PROTECTION_STEPS,
  loanOpenedText,
  offerPostedText,
  protectionLoweredText,
  slotTermsText,
  type ProtectionStep,
  type TermsFields,
} from './platformCopy';
import { CLAIM_ENDS, CLAIM_STAGES, recoveryClaimEndedText, recoveryClaimOpenText, type ClaimEnd, type ClaimStage } from './recoveryClaimCopy';

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
  | { kind: 'standingSkipped'; loanId: number; instruction: StandingInstruction; reason: StandingSkipReason; missing: string | null }
  /** #3734 — a material change to the Terms was announced and this wallet,
   *  which has not accepted `version`, holds commitments that stop filling
   *  from `effectiveAt` (unix seconds) until it does. `holds` names them, in
   *  {@link TERMS_HOLDS} order, at least one. */
  | { kind: 'termsAnnounced'; version: number; effectiveAt: number; holds: TermsHold[] }
  /** #3756 — a recovery claim is open on the account (`wallet`): announced
   *  at `stage`, with the times the vault recorded (unix seconds), which
   *  never move. Sent to the owner and to every signer (`to`). */
  | { kind: 'recoveryClaim'; stage: ClaimStage; recovery: string; requestedAt: number; runnableAt: number; lapsesAt: number }
  /** #3756 — the claim asked at `requestedAt` ended (`end`). `by` names the
   *  key that cancelled it, when read; `pauseUntil` is when a new claim may
   *  be asked, null when no pause is in force. */
  | { kind: 'recoveryClaimEnded'; end: ClaimEnd; requestedAt: number; by: string | null; pauseUntil: number | null }
  /** #3346 — a change that loosens the account's protection was asked for.
   *  `subject` the address it names (a signer, a destination, a recovery
   *  address), `what` an asset and amount (written out), `seconds` a duration
   *  (a delay, a wait, an idle period; 0 = off), `at` when it takes effect
   *  (unix seconds), `by` who asked; each null where the change has none or
   *  the chain did not say. */
  | {
      kind: 'securityChange';
      change: SecurityChange;
      subject: string | null;
      what: string | null;
      seconds: number | null;
      at: number | null;
      by: string | null;
    }
  /** #3719 — the platform's own record of a loan the reader is a party to
   *  (`lender` says which side), built from the chain event. */
  | { kind: 'loanOpened'; loanId: string; lender: boolean; terms: TermsFields }
  /** #3719 — the reader's offer was posted or edited (`edit`); `lend` says
   *  whether it lends. */
  | { kind: 'offerPosted'; offerId: string; edit: boolean; lend: boolean; terms: TermsFields }
  /** #3719 — the rate terms of the reader's Auto-lend slot were set. */
  | { kind: 'slotTermsSet'; slot: number; terms: TermsFields }
  /** #3719 — a step that lowers the reader's protection. `subject` the
   *  address it names (a keeper, an approved operator), `ref` a loan, offer
   *  or token id, `lend` / `collateral` a pair's assets, `level` / `previous`
   *  an access level, `seconds` a waiting time, `at` when it takes effect; each null where the step has
   *  none or the chain did not say. */
  | {
      kind: 'protectionLowered';
      step: ProtectionStep;
      subject: string | null;
      ref: string | null;
      lend: string | null;
      collateral: string | null;
      level: number | null;
      previous: number | null;
      seconds: number | null;
      at: number | null;
    };

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
 *  an amount or token label needs (`–` joins the two ends of a range). No `/`
 *  or `:`, so no link can be formed. */
const PLAIN = /^[\p{L}\p{N} .,#×()_\-…?–]{1,96}$/u;
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
    case 'termsAnnounced': {
      if (!isInt(a.version, 1, 2 ** 32 - 1) || !isInt(a.effectiveAt, 1, 2 ** 40)) return null;
      if (!Array.isArray(a.holds) || a.holds.length === 0) return null;
      // Every hold known, none twice, in catalogue order.
      const holds = TERMS_HOLDS.filter((h) => (a.holds as unknown[]).includes(h));
      if (holds.length !== a.holds.length) return null;
      return { kind: 'termsAnnounced', version: a.version, effectiveAt: a.effectiveAt, holds };
    }
    case 'recoveryClaim': {
      if (!(CLAIM_STAGES as readonly unknown[]).includes(a.stage)) return null;
      if (typeof a.recovery !== 'string' || !ADDRESS.test(a.recovery)) return null;
      if (!isInt(a.requestedAt, 1, 2 ** 40) || !isInt(a.runnableAt, 1, 2 ** 40) || !isInt(a.lapsesAt, 1, 2 ** 40)) return null;
      // The vault's own order: asked, then runnable, then the lapse.
      if (!(a.requestedAt <= a.runnableAt && a.runnableAt <= a.lapsesAt)) return null;
      return {
        kind: 'recoveryClaim',
        stage: a.stage as ClaimStage,
        recovery: a.recovery.toLowerCase(),
        requestedAt: a.requestedAt,
        runnableAt: a.runnableAt,
        lapsesAt: a.lapsesAt,
      };
    }
    case 'recoveryClaimEnded': {
      if (!(CLAIM_ENDS as readonly unknown[]).includes(a.end)) return null;
      if (!isInt(a.requestedAt, 1, 2 ** 40)) return null;
      if (a.by !== null && (typeof a.by !== 'string' || !ADDRESS.test(a.by))) return null;
      if (a.pauseUntil !== null && !isInt(a.pauseUntil, 1, 2 ** 40)) return null;
      return {
        kind: 'recoveryClaimEnded',
        end: a.end as ClaimEnd,
        requestedAt: a.requestedAt,
        by: a.by === null ? null : (a.by as string).toLowerCase(),
        pauseUntil: a.pauseUntil as number | null,
      };
    }
    case 'securityChange': {
      if (!(SECURITY_CHANGES as readonly unknown[]).includes(a.change)) return null;
      const addr = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' && ADDRESS.test(v) ? v.toLowerCase() : undefined);
      const subject = addr(a.subject);
      const by = addr(a.by);
      const what = plainOrNull(a.what);
      if (subject === undefined || by === undefined || what === undefined) return null;
      if (a.seconds !== null && !isInt(a.seconds, 0, 2 ** 40)) return null;
      if (a.at !== null && !isInt(a.at, 1, 2 ** 40)) return null;
      return { kind: 'securityChange', change: a.change as SecurityChange, subject, what, seconds: a.seconds as number | null, at: a.at as number | null, by };
    }
    case 'loanOpened': {
      const terms = parseTerms(a.terms);
      if (!terms || !isId(a.loanId) || typeof a.lender !== 'boolean') return null;
      return { kind: 'loanOpened', loanId: a.loanId, lender: a.lender, terms };
    }
    case 'offerPosted': {
      const terms = parseTerms(a.terms);
      if (!terms || !isId(a.offerId) || typeof a.edit !== 'boolean' || typeof a.lend !== 'boolean') return null;
      return { kind: 'offerPosted', offerId: a.offerId, edit: a.edit, lend: a.lend, terms };
    }
    case 'slotTermsSet': {
      const terms = parseTerms(a.terms);
      if (!terms || !isInt(a.slot, 0, 255)) return null;
      return { kind: 'slotTermsSet', slot: a.slot, terms };
    }
    case 'protectionLowered': {
      if (!(PROTECTION_STEPS as readonly unknown[]).includes(a.step)) return null;
      const subject = addrOrNull(a.subject);
      const lend = plainOrNull(a.lend);
      const collateral = plainOrNull(a.collateral);
      if (subject === undefined || lend === undefined || collateral === undefined) return null;
      if (a.ref !== null && !isId(a.ref)) return null;
      if (a.level !== null && !isInt(a.level, 0, 255)) return null;
      if (a.previous !== null && !isInt(a.previous, 0, 255)) return null;
      if (a.seconds !== null && !isInt(a.seconds, 0, 2 ** 40)) return null;
      if (a.at !== null && !isInt(a.at, 1, 2 ** 40)) return null;
      return {
        kind: 'protectionLowered',
        step: a.step as ProtectionStep,
        subject,
        ref: a.ref as string | null,
        lend,
        collateral,
        level: a.level as number | null,
        previous: a.previous as number | null,
        seconds: a.seconds as number | null,
        at: a.at as number | null,
      };
    }
    default:
      return null;
  }
}

/** A loan, offer or token id: a decimal uint256. */
const isId = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v);
const addrOrNull = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' && ADDRESS.test(v) ? v.toLowerCase() : undefined);
const isBps = (v: unknown): v is number => isInt(v, 0, 1_000_000);

/** #3719 — the terms of a loan, offer or slot. A rate, term or asset the
 *  event did not carry is null and renders as "unknown"; never left out. */
function parseTerms(raw: unknown): TermsFields | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as Record<string, unknown>;
  const lend = plainOrNull(t.lend);
  const collateral = plainOrNull(t.collateral);
  if (lend === undefined || collateral === undefined) return null;
  if (t.rateBps !== null && !isBps(t.rateBps)) return null;
  if (t.rateMaxBps !== null && !isBps(t.rateMaxBps)) return null;
  if (t.days !== null && !isInt(t.days, 0, 100_000)) return null;
  if (t.marginBps !== null && !isInt(t.marginBps, -1_000_000, 1_000_000)) return null;
  const integrator = t.integrator === 'none' ? 'none' : addrOrNull(t.integrator);
  if (integrator === undefined) return null;
  if (!isInt(t.warnings, 0, 7)) return null;
  return {
    lend,
    collateral,
    rateBps: t.rateBps as number | null,
    rateMaxBps: t.rateMaxBps as number | null,
    days: t.days as number | null,
    marginBps: t.marginBps as number | null,
    integrator,
    warnings: t.warnings,
  };
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
    case 'securityChange':
      return securityChangeText(
        ctx.locale,
        a.change,
        w,
        c,
        {
          subject: a.subject,
          what: a.what,
          hours: a.seconds === null ? null : Math.round(a.seconds / 360) / 10,
          at: a.at === null ? null : utcMinute(a.at),
          by: a.by,
        },
        `${ctx.appOrigin}/`,
      );
    case 'recoveryClaim':
      return recoveryClaimOpenText(ctx.locale, a.stage, w, c, a.recovery, utcMinute(a.requestedAt), utcMinute(a.runnableAt), utcMinute(a.lapsesAt), `${ctx.appOrigin}/`);
    case 'recoveryClaimEnded':
      return recoveryClaimEndedText(ctx.locale, a.end, a.by, w, c, a.pauseUntil === null ? null : utcMinute(a.pauseUntil), `${ctx.appOrigin}/`);
    case 'loanOpened':
      return loanOpenedText(ctx.locale, c, a.loanId, a.lender, a.terms, `${ctx.appOrigin}/positions/${a.loanId}`);
    case 'offerPosted':
      return offerPostedText(ctx.locale, c, a.offerId, a.edit, a.lend, a.terms, `${ctx.appOrigin}/offers`);
    case 'slotTermsSet':
      return slotTermsText(ctx.locale, c, a.slot, a.terms, `${ctx.appOrigin}/lend`);
    case 'protectionLowered':
      return protectionLoweredText(
        ctx.locale,
        c,
        a.step,
        { subject: a.subject, ref: a.ref, lend: a.lend, collateral: a.collateral, level: a.level, previous: a.previous, seconds: a.seconds },
        a.at === null ? null : utcMinute(a.at),
        `${ctx.appOrigin}/`,
      );
    case 'termsAnnounced':
      return termsAnnouncedText(ctx.locale, ctx.chainName, a.version, utcMinute(a.effectiveAt), a.holds, `${ctx.appOrigin}/`);
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
