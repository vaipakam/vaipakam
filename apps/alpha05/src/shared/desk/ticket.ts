/**
 * The desk's order ticket (OFF-74): an exact-rate offer or request on the
 * market the desk shows, typed in one compact form and handed to the same
 * posting review the guided flows use (RB-REVIEW), so consent, the dry run
 * and the risk warning are the guided flows' own.
 *
 * The market fixes the lending token, the collateral token and the term.
 * The ticket adds the side, the amount, the collateral, the rate, how long
 * it stays open and how matches may fill it. A partial or
 * immediate-or-cancel ticket also takes the smallest single fill, because
 * the protocol fills a match only between the offer's smallest and largest
 * amount: without one, every fill would be the whole amount whatever the
 * mode said. Everything else is the guided flows' default, stated on the
 * ticket: full-term interest, no partial repayment, interest paid at
 * repayment, no collateral range, no fee tariff and no price guard. A ticket is always posted on the chain; gasless signed
 * orders are a later update, and the ticket says so (mode posted = mode
 * shown).
 *
 * Only the FIRST thing that stops the ticket is reported, beneath the
 * action, in a fixed order: the wallet, the network, the market, the reads
 * the ticket needs, the term, then each field in the order it is typed.
 */
import { formatUnits } from 'viem';
import {
  DEFAULT_INPUT,
  durationOk,
  expiresAt,
  fillModeBlock,
  parseAmount,
  parseRateBps,
  type ExpiryChoice,
  type FillMode,
  type FillModeBlock,
  type ParseError,
  type PostSide,
} from '../post/postModel';
import type { PostDraft } from '../post/postReview';

type Hex = `0x${string}`;

/** The expiry presets the ticket offers, shortest first; a custom number
 *  of days is the guided flows' option. */
export const TICKET_EXPIRIES = ['1d', '7d', '30d', 'never'] as const satisfies readonly ExpiryChoice[];
export type TicketExpiry = (typeof TICKET_EXPIRIES)[number];

/** What the reader typed, kept as text so nothing is rounded on the way. */
export interface TicketInput {
  side: PostSide;
  amount: string;
  collateral: string;
  /** The yearly rate in percent, as typed ("8.5"). */
  rate: string;
  expiry: TicketExpiry;
  fillMode: FillMode;
  /** The smallest single fill, as typed; read only for a partial or
   *  immediate-or-cancel ticket (all or none is one fill of the whole). */
  minFill: string;
}

export const DEFAULT_TICKET: TicketInput = { side: 'lender', amount: '', collateral: '', rate: '', expiry: '7d', fillMode: 'aon', minFill: '' };

/** The market a ticket posts on. */
export interface TicketMarket {
  lending: Hex;
  collateral: Hex;
  durationDays: number;
}

/** What the ticket needs read before it can be reviewed. `null` while a
 *  read is still in flight; a failed read carries its reason. */
export interface TicketContext {
  connected: boolean;
  /** The wallet is on a served network, and on the one the desk shows. */
  sameNetwork: boolean;
  market: TicketMarket | null;
  /** The longest term open and the list fee (`readPostFormInputs`). */
  config: { maxDurationDays: bigint } | { failed: string } | null;
  /** The two tokens' decimals. */
  decimals: { lending: number; collateral: number } | { failed: string } | null;
  /** Whether the Terms in force could be read (a needed acceptance is not
   *  a blocker: the review asks for it first). */
  terms: 'ready' | 'loading' | { failed: string };
}

export type TicketField = 'amount' | 'collateral' | 'minFill';

export type TicketBlocker =
  | { code: 'connect' }
  | { code: 'network' }
  | { code: 'no-market' }
  | { code: 'loading' }
  | { code: 'unread'; reason: string }
  | { code: 'term-closed'; maxDays: bigint }
  | { code: 'field'; field: TicketField; error: ParseError }
  | { code: 'rate'; error: ParseError | 'high' }
  | { code: 'min-fill' }
  | { code: 'fill'; block: FillModeBlock }
  | { code: 'terms-unread'; reason: string };

/** `amount` is the whole amount; `minFill` the smallest single fill, equal
 *  to `amount` for an all-or-none ticket. */
export type TicketCheck = { ok: true; amount: bigint; minFill: bigint; collateral: bigint; rateBps: bigint } | { ok: false; blocker: TicketBlocker };

/** The ticket's verdict: the parsed figures, or the first thing in the way. */
export function checkTicket(input: TicketInput, ctx: TicketContext): TicketCheck {
  const stop = (blocker: TicketBlocker): TicketCheck => ({ ok: false, blocker });
  if (!ctx.connected) return stop({ code: 'connect' });
  if (!ctx.sameNetwork) return stop({ code: 'network' });
  if (ctx.market === null) return stop({ code: 'no-market' });
  if (ctx.config === null || ctx.decimals === null || ctx.terms === 'loading') return stop({ code: 'loading' });
  if ('failed' in ctx.config) return stop({ code: 'unread', reason: ctx.config.failed });
  if ('failed' in ctx.decimals) return stop({ code: 'unread', reason: ctx.decimals.failed });
  if (!durationOk(ctx.market.durationDays, ctx.config.maxDurationDays)) return stop({ code: 'term-closed', maxDays: ctx.config.maxDurationDays });
  const amount = parseAmount(input.amount, ctx.decimals.lending);
  if (!amount.ok) return stop({ code: 'field', field: 'amount', error: amount.error });
  const collateral = parseAmount(input.collateral, ctx.decimals.collateral);
  if (!collateral.ok) return stop({ code: 'field', field: 'collateral', error: collateral.error });
  const rate = parseRateBps(input.rate);
  if (!rate.ok) return stop({ code: 'rate', error: rate.error });
  // A fill below the whole amount needs a smallest fill below it: an offer
  // of one size only ever fills whole (`LibOfferMatch` keeps each match
  // between the offer's smallest and largest amount).
  let minFill = amount.value;
  if (input.fillMode !== 'aon') {
    const part = parseAmount(input.minFill, ctx.decimals.lending);
    if (!part.ok) return stop({ code: 'field', field: 'minFill', error: part.error });
    if (part.value >= amount.value) return stop({ code: 'min-fill' });
    minFill = part.value;
  }
  const fill = fillModeBlock(input.fillMode, minFill !== amount.value, input.expiry);
  if (fill !== null) return stop({ code: 'fill', block: fill });
  if (ctx.terms !== 'ready') return stop({ code: 'terms-unread', reason: ctx.terms.failed });
  return { ok: true, amount: amount.value, minFill, collateral: collateral.value, rateBps: rate.value };
}

/** The field posting locks in the poster's own vault: the amount for a
 *  lender's offer, the collateral for a borrower's request. */
export function stakeField(side: PostSide): TicketField {
  return side === 'lender' ? 'amount' : 'collateral';
}

/** A balance as the ticket types it: exact, every digit, no grouping, so
 *  "fill to balance" never rounds what the wallet holds. */
export function balanceText(balance: bigint, decimals: number): string {
  return formatUnits(balance, decimals);
}

/** The draft the posting review reads: the amount from the smallest single
 *  fill to the whole (one amount for all or none), one collateral (no
 *  collateral range), the market's term, the guided flows' lifecycle
 *  defaults, and an expiry fixed from the chain's own clock now. */
export function ticketDraft(input: TicketInput, checked: Extract<TicketCheck, { ok: true }>, market: TicketMarket, chainNow: bigint): PostDraft {
  return {
    side: input.side,
    parsed: {
      amount: checked.minFill,
      amountMax: checked.amount,
      collateral: checked.collateral,
      collateralFloor: checked.collateral,
      fillMode: input.fillMode,
      cadence: 0,
      tariff: null,
      guardBps: null,
      rateBps: checked.rateBps,
      durationDays: market.durationDays,
      expiry: input.expiry,
      fullTerm: DEFAULT_INPUT.fullTerm,
      allowsPartialRepay: DEFAULT_INPUT.allowsPartialRepay,
    },
    pair: { lending: market.lending, collateral: market.collateral, leg: { kind: 'erc20' } },
    expiresAt: expiresAt(input.expiry, chainNow),
  };
}
