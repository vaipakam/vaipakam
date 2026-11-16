/**
 * #3624 — Auto-lend: one Lend flow, two outcomes. A lender who chooses
 * "keep lending when repaid" sets up a standing lending instruction
 * (`LenderIntentFacet.setLenderIntent`) and funds it from the wallet
 * (`fundLenderIntent`) in ONE transaction through the protocol's batch
 * entry; otherwise the page posts a one-time offer, unchanged.
 *
 * The protocol's rule, which the review states before anything is signed:
 * - the instruction is keyed by the wallet and the asset pair: one per pair.
 *   Setting it again replaces its terms (a change of terms), so the setup
 *   flow refuses a pair that already has one and points to managing it;
 * - it lends only through a matching service, which fills a borrower's
 *   request against it when the request fits the lender's limits: lowest
 *   rate, loan-to-value ceiling, longest term, smallest loan, the end date
 *   and the interest mode. No borrower accepts it directly;
 * - the funded money stays in the lender's own vault, set aside for the
 *   instruction (a lien), and un-lent money can be taken back at any time;
 * - a repaid loan's money is put back behind the instruction (the roll)
 *   while a further loan still fits, so it keeps lending until stopped or
 *   until its end date;
 * - every new terms wait the protocol's minimum terms age before a fill;
 * - the end date bounds each loan's AGREED maturity: a late repayment inside
 *   grace, a default or a pause can end a loan after it.
 * - both legs must be priced, and the smallest loan must be worth at least
 *   the network's minimum fill value.
 *
 * Everything here is pure or a read: the page's review and flow build on it.
 */
import { erc20Abi, parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { LenderIntentFacetABI, NumeraireValueFacetABI } from '@vaipakam/contracts/abis';
import { CONFIG, OFFER_PREVIEW } from '../offers/reads';
import { readIntentGates, type IntentGate } from '../offers/intents';
import { batchCall, type BatchStep } from '../tx/batch';
import { parseAmount, parseDays, parseRateBps, type ParseError } from '../post/postModel';

type Hex = `0x${string}`;

export const INTENT = LenderIntentFacetABI as Abi;
const NUMERAIRE = NumeraireValueFacetABI as Abi;

const DAY = 86_400n;
/** The protocol's least window an end date must leave: one day-long loan
 *  after the terms age (`LibIntentTerms.MIN_LEND_WINDOW`). */
export const MIN_LEND_WINDOW_SEC = DAY;
/** How many loans the default smallest loan allows the funded amount to
 *  split into, at most: the smallest loan is a tenth of it, or the
 *  network's minimum fill value when that is more. */
export const DEFAULT_SPLIT = 10n;

/** What the lender types. Text, kept as typed, so a navigation away and
 *  back keeps it. `exposure` and `minFill` are Advanced: empty means the
 *  default (the funded amount; a tenth of it, at least the network's
 *  minimum). `lendUntil` is a calendar date (`YYYY-MM-DD`) or empty. */
export interface AutoLendInput {
  amount: string;
  rate: string;
  ltv: string;
  days: string;
  lendUntil: string;
  proRata: boolean;
  exposure: string;
  minFill: string;
}

export const DEFAULT_AUTOLEND_INPUT: AutoLendInput = {
  amount: '',
  rate: '',
  ltv: '60',
  days: '30',
  lendUntil: '',
  proRata: false,
  exposure: '',
  minFill: '',
};

/** The typed figures, exactly. */
export interface ParsedAutoLend {
  /** Moved from the wallet into the vault, behind the instruction. */
  fund: bigint;
  /** The most the instruction may have lent out at once; null = `fund`. */
  maxExposure: bigint | null;
  minRateBps: bigint;
  maxInitLtvBps: number;
  maxDurationDays: number;
  /** null = the default, sized in the review from the network minimum. */
  minFill: bigint | null;
  /** The end date as typed (`YYYY-MM-DD`), or null for none. */
  lendUntilDate: string | null;
  acceptsProRata: boolean;
}

export type AutoLendField = 'amount' | 'rate' | 'ltv' | 'days' | 'lendUntil' | 'exposure' | 'minFill';
export type AutoLendError = ParseError | 'high' | 'date' | 'past' | 'aboveExposure';

/** Parses every field; `errors` names each field that does not parse.
 *  `advanced` false ignores the Advanced fields, so a value typed there
 *  and then hidden never reaches the protocol. */
export function parseAutoLend(
  input: AutoLendInput,
  decimals: number,
  maxDays: number,
  advanced: boolean,
  today: string,
): { ok: true; parsed: ParsedAutoLend } | { ok: false; errors: Partial<Record<AutoLendField, AutoLendError>> } {
  const errors: Partial<Record<AutoLendField, AutoLendError>> = {};
  const amount = parseAmount(input.amount, decimals);
  if (!amount.ok) errors.amount = amount.error;
  const rate = parseRateBps(input.rate);
  if (!rate.ok) errors.rate = rate.error;
  const ltv = parseRateBps(input.ltv);
  if (!ltv.ok) errors.ltv = ltv.error;
  const days = parseDays(input.days, maxDays);
  if (!days.ok) errors.days = days.error;
  let lendUntilDate: string | null = null;
  const d = input.lendUntil.trim();
  if (d !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) errors.lendUntil = 'date';
    else if (d <= today) errors.lendUntil = 'past';
    else lendUntilDate = d;
  }
  let maxExposure: bigint | null = null;
  let minFill: bigint | null = null;
  if (advanced) {
    if (input.exposure.trim() !== '') {
      const e = parseAmount(input.exposure, decimals);
      if (!e.ok) errors.exposure = e.error;
      else maxExposure = e.value;
    }
    if (input.minFill.trim() !== '') {
      const m = parseAmount(input.minFill, decimals);
      if (!m.ok) errors.minFill = m.error;
      else minFill = m.value;
    }
  }
  if (Object.keys(errors).length > 0 || !amount.ok || !rate.ok || !ltv.ok || !days.ok) return { ok: false, errors };
  const cap = maxExposure ?? amount.value;
  if (minFill !== null && minFill > cap) return { ok: false, errors: { minFill: 'aboveExposure' } };
  return {
    ok: true,
    parsed: {
      fund: amount.value,
      maxExposure,
      minRateBps: rate.value,
      maxInitLtvBps: Number(ltv.value),
      maxDurationDays: days.value,
      minFill,
      lendUntilDate,
      acceptsProRata: input.proRata,
    },
  };
}

/** Today's date where the reader is, as `YYYY-MM-DD`. */
export function localToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** The end date as the protocol takes it: the last second of that day where
 *  the reader is (unix seconds). The review states the exact time. */
export function lendUntilSeconds(date: string): bigint {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return BigInt(Math.floor(new Date(y, m - 1, d, 23, 59, 59).getTime() / 1000));
}

/** The confirmed setup the review opens on. */
export interface AutoLendDraft {
  lending: Hex;
  collateral: Hex;
  parsed: ParsedAutoLend;
  /** The end date in unix seconds, 0 for none. */
  lendUntil: bigint;
}

export function autoLendDraft(lending: Hex, collateral: Hex, parsed: ParsedAutoLend): AutoLendDraft {
  return { lending, collateral, parsed, lendUntil: parsed.lendUntilDate === null ? 0n : lendUntilSeconds(parsed.lendUntilDate) };
}

/** The exposure cap the protocol records: the typed cap, else the amount. */
export function exposureOf(p: ParsedAutoLend): bigint {
  return p.maxExposure ?? p.fund;
}

/**
 * The smallest loan the setup records: the typed one, else a tenth of what
 * can be lent from the start (the funding, or the most at once when that is
 * smaller) rounded up, raised to the network's minimum (`floor`, in the
 * lending asset, rounded up) and capped at that same figure, since no fill
 * can be larger than the money set aside. null when the
 * default is asked for and the network minimum could not be read: the review
 * then names that instead of guessing a figure.
 */
export function resolvedMinFill(p: ParsedAutoLend, floor: bigint | null): bigint | null {
  if (p.minFill !== null) return p.minFill;
  if (floor === null) return null;
  const exposure = exposureOf(p);
  const cap = exposure < p.fund ? exposure : p.fund;
  const tenth = (cap + DEFAULT_SPLIT - 1n) / DEFAULT_SPLIT;
  const pick = tenth > floor ? tenth : floor;
  return pick > cap ? cap : pick;
}

/** The setup's two steps, as sent: set the terms, then fund them. The
 *  terms carry the lender's consent (the review's checkbox, the same gate
 *  every offer posting carries) and the transaction deadline. */
export function setupSteps(draft: AutoLendDraft, minFill: bigint, consent: boolean, validUntil: bigint): BatchStep[] {
  const p = draft.parsed;
  return [
    {
      abi: INTENT,
      functionName: 'setLenderIntent',
      args: [
        draft.lending,
        draft.collateral,
        exposureOf(p),
        p.minRateBps,
        p.maxInitLtvBps,
        p.maxDurationDays,
        minFill,
        false,
        draft.lendUntil,
        p.acceptsProRata,
        consent,
        validUntil,
      ],
    },
    { abi: INTENT, functionName: 'fundLenderIntent', args: [draft.lending, draft.collateral, p.fund] },
  ];
}

/** The setup as one contract call (the batch), or the terms alone, which the
 *  review dry-runs while the wallet's approval does not yet cover the
 *  funding: the terms' verdict is known before any prompt, and the whole
 *  batch is dry-run again once the approval is in place. */
export function setupCall(draft: AutoLendDraft, minFill: bigint, validUntil: bigint, termsOnly = false) {
  const steps = setupSteps(draft, minFill, true, validUntil);
  if (termsOnly) return { abi: INTENT, functionName: steps[0]!.functionName, args: steps[0]!.args };
  return batchCall(steps);
}

/** One instruction as the protocol stores it (`LibVaipakam.LenderIntent`). */
export interface IntentRecord {
  active: boolean;
  maxExposure: bigint;
  minRateBps: bigint;
  maxInitLtvBps: number;
  maxDurationDays: number;
  minFillAmount: bigint;
  requiresKeeperAuth: boolean;
  termsSetAt: bigint;
  lendUntil: bigint;
  acceptsProRata: boolean;
}

export async function readIntent(c: PublicClient, diamond: Hex, owner: Hex, lending: Hex, collateral: Hex, blockNumber?: bigint): Promise<IntentRecord> {
  const raw = (await c.readContract({ address: diamond, abi: INTENT, functionName: 'getLenderIntent', args: [owner, lending, collateral], blockNumber })) as IntentRecord;
  return {
    active: raw.active,
    maxExposure: raw.maxExposure,
    minRateBps: raw.minRateBps,
    maxInitLtvBps: Number(raw.maxInitLtvBps),
    maxDurationDays: Number(raw.maxDurationDays),
    minFillAmount: raw.minFillAmount,
    requiresKeeperAuth: raw.requiresKeeperAuth,
    termsSetAt: raw.termsSetAt,
    lendUntil: raw.lendUntil,
    acceptsProRata: raw.acceptsProRata,
  };
}

/** Everything the setup review stands on, read at one block. */
export interface SetupFacts {
  blockNumber: bigint;
  chainNow: bigint;
  /** The instruction already on this pair, if one is active. */
  existing: IntentRecord | null;
  /** The network's minimum fill value (numeraire, 1e18), and what it is in
   *  the lending asset (rounded up); null when it could not be read. */
  minFillValue: bigint | null;
  floor: bigint | null;
  minTermsAgeSec: bigint;
  gates: Record<IntentGate, boolean | null>;
  balance: bigint;
  allowance: bigint;
}

export async function readSetupFacts(c: PublicClient, diamond: Hex, account: Hex, lending: Hex, collateral: Hex): Promise<SetupFacts> {
  const block = await c.getBlock({ blockTag: 'latest' });
  const blockNumber = block.number;
  const read = <T>(abi: Abi, functionName: string, args: readonly unknown[] = []) => c.readContract({ address: diamond, abi, functionName, args, blockNumber }) as Promise<T>;
  const [existing, minFillValue, minTermsAgeSec, gates, balance, allowance] = await Promise.all([
    readIntent(c, diamond, account, lending, collateral, blockNumber),
    read<bigint>(INTENT, 'getMinIntentFillNumeraire').catch(() => null),
    read<bigint>(CONFIG, 'getMinTermsAgeSec'),
    readIntentGates(c, diamond, blockNumber),
    c.readContract({ address: lending, abi: erc20Abi, functionName: 'balanceOf', args: [account], blockNumber }),
    c.readContract({ address: lending, abi: erc20Abi, functionName: 'allowance', args: [account, diamond], blockNumber }),
  ]);
  let floor: bigint | null = null;
  if (minFillValue !== null) {
    floor = minFillValue === 0n ? 0n : await read<bigint>(NUMERAIRE, 'getAmountForNumeraireValue', [lending, minFillValue, true]).catch(() => null);
  }
  return { blockNumber, chainNow: block.timestamp, existing: existing.active ? existing : null, minFillValue, floor, minTermsAgeSec, gates, balance, allowance };
}

/** The earliest end date the protocol takes now: the terms age, then one
 *  day-long loan (`LibIntentTerms.validLendUntil`). */
export function earliestLendUntil(chainNow: bigint, minTermsAgeSec: bigint): bigint {
  return chainNow + minTermsAgeSec + MIN_LEND_WINDOW_SEC;
}

/** Why the setup cannot be sent as it stands, before any dry run: each a
 *  fact the reader can act on. Ordered as the protocol checks them. */
export type SetupBlock =
  | { kind: 'exists' }
  | { kind: 'lendUntil'; earliest: bigint }
  | { kind: 'floorUnread' }
  | { kind: 'belowFloor'; floor: bigint }
  | { kind: 'minAboveFund'; minFill: bigint }
  | { kind: 'balance'; balance: bigint }
  /** The LTV ceiling is above the highest the network takes for the pair
   *  at today's prices, read by the review (`ltvCapBlock`). */
  | { kind: 'ltvCap'; capBps: number }
  /** The network opens no new loan against this collateral now. */
  | { kind: 'ltvClosed' };

export function setupBlocks(draft: AutoLendDraft, f: SetupFacts): SetupBlock[] {
  const out: SetupBlock[] = [];
  if (f.existing !== null) out.push({ kind: 'exists' });
  if (draft.lendUntil !== 0n && draft.lendUntil < earliestLendUntil(f.chainNow, f.minTermsAgeSec))
    out.push({ kind: 'lendUntil', earliest: earliestLendUntil(f.chainNow, f.minTermsAgeSec) });
  const minFill = resolvedMinFill(draft.parsed, f.floor);
  if (minFill === null) out.push({ kind: 'floorUnread' });
  else if (f.floor !== null && minFill < f.floor) out.push({ kind: 'belowFloor', floor: f.floor });
  // Every fill must be at least the smallest loan and at most the money set
  // aside, so a smallest loan above the funding could never be made (an
  // Advanced most-at-once above the funding lets the floor reach past it).
  if (minFill !== null && minFill > draft.parsed.fund) out.push({ kind: 'minAboveFund', minFill });
  if (f.balance < draft.parsed.fund) out.push({ kind: 'balance', balance: f.balance });
  return out;
}

/** The highest loan-to-value the network takes for the pair now: none when
 *  the protocol's loan-start risk bound does not apply to it (an unpriced
 *  leg), closed when it opens no new loan against the collateral. */
export type LtvCap = { kind: 'none' } | { kind: 'closed' } | { kind: 'cap'; bps: number };

const NO_LOANS = 2n ** 256n - 1n;

/** The loan-start bound read through the protocol's own rule
 *  (`OfferPreviewFacet.initRiskBounds`, which every match asks): the least
 *  collateral it takes for `amount`, turned into a loan-to-value with the
 *  protocol's own values of both legs (the debt rounded up, the collateral
 *  down), rounded up so a ceiling exactly at the bound is never refused.
 *  A fill whose collateral at the setup's ceiling is under that least
 *  collateral is refused, so a ceiling above it never lends. */
export async function readLtvCap(c: PublicClient, diamond: Hex, lending: Hex, collateral: Hex, amount: bigint): Promise<LtvCap> {
  const [floor] = (await c.readContract({ address: diamond, abi: OFFER_PREVIEW, functionName: 'initRiskBounds', args: [lending, collateral, amount, 0n] })) as readonly [
    bigint,
    boolean,
    bigint,
  ];
  if (floor === 0n) return { kind: 'none' };
  if (floor === NO_LOANS) return { kind: 'closed' };
  const value = (asset: Hex, v: bigint, debt: boolean) =>
    c.readContract({ address: diamond, abi: NUMERAIRE, functionName: 'getNumeraireValue', args: [asset, v, debt] }) as Promise<bigint>;
  const [lend, coll] = await Promise.all([value(lending, amount, true), value(collateral, floor, false)]);
  if (coll === 0n) throw new Error('collateral valued at nothing');
  return { kind: 'cap', bps: Number((lend * 10_000n + coll - 1n) / coll) };
}

/** The block a ceiling above the network's bound earns, if any. */
export function ltvCapBlock(ltvBps: number, cap: LtvCap | null): SetupBlock | null {
  if (cap === null || cap.kind === 'none') return null;
  if (cap.kind === 'closed') return { kind: 'ltvClosed' };
  return ltvBps > cap.bps ? { kind: 'ltvCap', capBps: cap.bps } : null;
}

/** Whether the instruction can be filled at all on this network now, from
 *  the gates (the matching service's own pause aside, stated apart). */
export type FillPosture = 'on' | 'halted' | 'off' | 'service-paused' | 'unknown';

export function fillPosture(gates: Record<IntentGate, boolean | null>): FillPosture {
  if (gates.protocolPaused === true) return 'halted';
  if (gates.matching === true || gates.intents === true) return 'off';
  if (gates.protocolPaused === null || gates.matching === null || gates.intents === null) return 'unknown';
  if (gates.keepers === true) return 'service-paused';
  if (gates.keepers === null) return 'unknown';
  return 'on';
}

/** What a setup's own logs record: the terms set and the amount funded, by
 *  this wallet on this pair. */
export interface SetupLogs {
  set: boolean;
  funded: bigint | null;
}

export function setupLogs(logs: readonly Log[], diamond: Hex, account: Hex, lending: Hex, collateral: Hex): SetupLogs {
  const same = (a: unknown, b: Hex) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  const mine = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi: INTENT, logs: mine as Log[], strict: false }) as unknown as { eventName: string; args: Record<string, unknown> }[];
  let set = false;
  let funded: bigint | null = null;
  for (const e of events) {
    const a = e.args;
    if (!same(a.owner, account) || !same(a.lendingAsset, lending) || !same(a.collateralAsset, collateral)) continue;
    if (e.eventName === 'LenderIntentSet') set = true;
    if (e.eventName === 'LenderIntentFunded' && typeof a.amount === 'bigint') funded = (funded ?? 0n) + a.amount;
  }
  return { set, funded };
}

/** #3624 — every network switch the setup depends on, in one place, so the
 *  page can name a closed one. */
export const SETUP_GATE_ORDER: readonly IntentGate[] = ['protocolPaused', 'matching', 'intents', 'keepers'];

/** The day count of a span, for copy: whole days, rounded down. */
export function wholeDays(seconds: bigint): number {
  return Number(seconds / DAY);
}
