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
import { erc20Abi, formatUnits, parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { LenderIntentFacetABI, LenderIntentViewFacetABI, NumeraireValueFacetABI } from '@vaipakam/contracts/abis';
import { CONFIG, RISK_PREVIEW } from '../offers/reads';
import { readIntentGates, type IntentGate } from '../offers/intents';
import { batchCall, type BatchStep } from '../tx/batch';
import { parseAmount, parseDays, parseRateBps, type ParseError } from '../post/postModel';

type Hex = `0x${string}`;

export const INTENT = LenderIntentFacetABI as Abi;
/** The standing-intent reads (split off LenderIntentFacet). */
export const INTENT_VIEW = LenderIntentViewFacetABI as Abi;
const NUMERAIRE = NumeraireValueFacetABI as Abi;

const DAY = 86_400n;
const ZERO = '0x0000000000000000000000000000000000000000' as Hex;
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
  change = false,
): { ok: true; parsed: ParsedAutoLend } | { ok: false; errors: Partial<Record<AutoLendField, AutoLendError>> } {
  const errors: Partial<Record<AutoLendField, AutoLendError>> = {};
  // A change of limits may add nothing: an empty or zero amount adds none.
  const typed = parseAmount(input.amount, decimals);
  const amount: typeof typed = change && !typed.ok && (typed.error === 'empty' || typed.error === 'zero') ? { ok: true, value: 0n } : typed;
  if (!amount.ok) errors.amount = amount.error;
  // The protocol takes a 0% lowest rate (any rate the borrower offers), so
  // zero is a valid floor here, unlike the amount and the ceiling.
  const typedRate = parseRateBps(input.rate);
  const rate: typeof typedRate = !typedRate.ok && typedRate.error === 'zero' ? { ok: true, value: 0n } : typedRate;
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
  // A change that keeps the recorded most at once compares it in the review.
  const cap = maxExposure ?? (change ? null : amount.value);
  if (minFill !== null && cap !== null && minFill > cap) return { ok: false, errors: { minFill: 'aboveExposure' } };
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
  /** Which of the wallet's Auto-lends on the pair (#3626: up to eight, slots
   *  0 to 7). A new setup takes the first slot; a change keeps its own. */
  slot: number;
  /** A change of the Auto-lend already on the pair (new limits, or starting
   *  a stopped or ended one again) rather than a new setup: the protocol
   *  replaces the recorded terms in place, and money may be added or not. */
  change: boolean;
}

/** The slot a new setup takes. Several Auto-lends on one pair (#3626) are
 *  read and managed by their slot; this app sets up one per pair, so a new
 *  setup takes the first. */
export const FIRST_SLOT = 0;

export function autoLendDraft(lending: Hex, collateral: Hex, parsed: ParsedAutoLend, change = false, slot = FIRST_SLOT): AutoLendDraft {
  return { lending, collateral, slot, parsed, lendUntil: parsed.lendUntilDate === null ? 0n : lendUntilSeconds(parsed.lendUntilDate), change };
}

/** The exposure cap the protocol records: the typed cap, else, for a change,
 *  the recorded one (`base`), else the amount funded. */
export function exposureOf(p: ParsedAutoLend, base: IntentRecord | null = null): bigint {
  return p.maxExposure ?? base?.maxExposure ?? p.fund;
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
export function resolvedMinFill(p: ParsedAutoLend, floor: bigint | null, base: IntentRecord | null = null): bigint | null {
  if (p.minFill !== null) return p.minFill;
  // A change keeps the recorded smallest loan unless one is typed.
  if (base !== null) return base.minFillAmount;
  if (floor === null) return null;
  const exposure = exposureOf(p);
  const cap = exposure < p.fund ? exposure : p.fund;
  const tenth = (cap + DEFAULT_SPLIT - 1n) / DEFAULT_SPLIT;
  const pick = tenth > floor ? tenth : floor;
  return pick > cap ? cap : pick;
}

/** The setup's steps, as sent: set the terms, then fund them (a change that
 *  adds nothing sends the terms alone). The terms carry the lender's consent
 *  (the review's checkbox, the same gate every offer posting carries) and the
 *  transaction deadline. A change keeps the recorded fill restriction
 *  (`requiresKeeperAuth`, which this app never sets) as it is. */
export function setupSteps(draft: AutoLendDraft, minFill: bigint, consent: boolean, validUntil: bigint, base: IntentRecord | null = null): BatchStep[] {
  const p = draft.parsed;
  const steps: BatchStep[] = [
    {
      abi: INTENT,
      functionName: 'setLenderIntent',
      args: [
        draft.lending,
        draft.collateral,
        draft.slot,
        exposureOf(p, base),
        p.minRateBps,
        p.maxInitLtvBps,
        p.maxDurationDays,
        minFill,
        base?.requiresKeeperAuth ?? false,
        draft.lendUntil,
        p.acceptsProRata,
        consent,
        // #3635 A / #3713 — this app sets no NEW market link, but a change
        // keeps the one recorded (set by an integrator or on-chain): sending
        // zeros would silently drop the slot's market-relative floor while its
        // funded capital stays. It does not ask for the far-from-average
        // confirmation yet: a floor outside the band is refused by name, a
        // re-set of the same floor needs none.
        { linkKind: base?.linkKind ?? 0, linkMarginBps: base?.linkMarginBps ?? 0, rateFarFromAverageAcknowledged: false },
        validUntil,
      ],
    },
  ];
  if (p.fund > 0n) steps.push({ abi: INTENT, functionName: 'fundLenderIntent', args: [draft.lending, draft.collateral, draft.slot, p.fund] });
  return steps;
}

/** The setup as one contract call (the batch), or the terms alone, which the
 *  review dry-runs while the wallet's approval does not yet cover the
 *  funding: the terms' verdict is known before any prompt, and the whole
 *  batch is dry-run again once the approval is in place. */
export function setupCall(draft: AutoLendDraft, minFill: bigint, validUntil: bigint, base: IntentRecord | null, termsOnly = false) {
  const steps = setupSteps(draft, minFill, true, validUntil, base);
  if (termsOnly || steps.length === 1) return { abi: INTENT, functionName: steps[0]!.functionName, args: steps[0]!.args };
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
  /** #3635 A — the slot's market link (0 = none) and its margin in bps. */
  linkKind: number;
  linkMarginBps: number;
}

export async function readIntent(c: PublicClient, diamond: Hex, owner: Hex, lending: Hex, collateral: Hex, slot: number, blockNumber?: bigint): Promise<IntentRecord> {
  const raw = (await c.readContract({
    address: diamond,
    abi: INTENT_VIEW,
    functionName: 'getLenderIntent',
    args: [owner, lending, collateral, slot],
    blockNumber,
  })) as IntentRecord;
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
    linkKind: Number(raw.linkKind ?? 0),
    linkMarginBps: Number(raw.linkMarginBps ?? 0),
  };
}

/** Everything the setup review stands on, read at one block. */
export interface SetupFacts {
  blockNumber: bigint;
  chainNow: bigint;
  /** The instruction already on this pair, if one is active. */
  existing: IntentRecord | null;
  /** The pair's record as stored, active or not (all zero when none was
   *  ever set): what a change replaces. */
  record: IntentRecord;
  /** The money set aside and not lent, and the amount counted against the
   *  most at once, for this pair. */
  unlent: bigint;
  lent: bigint;
  /** Whether the record is opted into priority routing (#2550), which any
   *  new terms switch off; null when it could not be read. */
  priority: boolean | null;
  /** The network's minimum fill value (numeraire, 1e18), and what it is in
   *  the lending asset (rounded up); null when it could not be read. */
  minFillValue: bigint | null;
  floor: bigint | null;
  minTermsAgeSec: bigint;
  gates: Record<IntentGate, boolean | null>;
  balance: bigint;
  allowance: bigint;
}

export async function readSetupFacts(c: PublicClient, diamond: Hex, account: Hex, lending: Hex, collateral: Hex, slot: number): Promise<SetupFacts> {
  const block = await c.getBlock({ blockTag: 'latest' });
  const blockNumber = block.number;
  const read = <T>(abi: Abi, functionName: string, args: readonly unknown[] = []) => c.readContract({ address: diamond, abi, functionName, args, blockNumber }) as Promise<T>;
  const [existing, minFillValue, minTermsAgeSec, gates, balance, allowance, unlent, lent, priority] = await Promise.all([
    readIntent(c, diamond, account, lending, collateral, slot, blockNumber),
    read<bigint>(INTENT, 'getMinIntentFillNumeraire').catch(() => null),
    read<bigint>(CONFIG, 'getMinTermsAgeSec'),
    readIntentGates(c, diamond, blockNumber),
    c.readContract({ address: lending, abi: erc20Abi, functionName: 'balanceOf', args: [account], blockNumber }),
    c.readContract({ address: lending, abi: erc20Abi, functionName: 'allowance', args: [account, diamond], blockNumber }),
    read<bigint>(INTENT_VIEW, 'getLenderIntentCapital', [account, lending, collateral, slot]),
    read<bigint>(INTENT_VIEW, 'getLenderIntentLivePrincipal', [account, lending, collateral, slot]),
    read<readonly [boolean, bigint, boolean, boolean]>(INTENT_VIEW, 'getLenderIntentPriority', [account, lending, collateral, slot, ZERO, ZERO]).then(
      (x) => x[0],
      () => null,
    ),
  ]);
  let floor: bigint | null = null;
  if (minFillValue !== null) {
    floor = minFillValue === 0n ? 0n : await read<bigint>(NUMERAIRE, 'getAmountForNumeraireValue', [lending, minFillValue, true]).catch(() => null);
  }
  return {
    blockNumber,
    chainNow: block.timestamp,
    existing: existing.active ? existing : null,
    record: existing,
    unlent,
    lent,
    priority,
    minFillValue,
    floor,
    minTermsAgeSec,
    gates,
    balance,
    allowance,
  };
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
  /** A change, but the pair carries no Auto-lend to change. */
  | { kind: 'missing' }
  | { kind: 'lendUntil'; earliest: bigint }
  | { kind: 'floorUnread' }
  | { kind: 'belowFloor'; floor: bigint }
  | { kind: 'minAboveFund'; minFill: bigint }
  | { kind: 'balance'; balance: bigint }
  /** The LTV ceiling is above the highest the network takes for the pair
   *  at today's prices, read by the review (`ltvCapBlock`). */
  | { kind: 'ltvCap'; capBps: number }
  /** The network opens no new loan against this collateral now. */
  | { kind: 'ltvClosed' }
  /** The smallest loan is above the most at once (a change that keeps the
   *  recorded most at once). */
  | { kind: 'minAboveExposure'; minFill: bigint };

/** The money set aside and not lent once the step lands: what waits now
 *  (for a change) plus what it adds. */
export function setAsideAfter(draft: AutoLendDraft, f: SetupFacts): bigint {
  return (draft.change ? f.unlent : 0n) + draft.parsed.fund;
}

export function setupBlocks(draft: AutoLendDraft, f: SetupFacts): SetupBlock[] {
  const out: SetupBlock[] = [];
  const base = draft.change ? f.record : null;
  if (!draft.change && f.existing !== null) out.push({ kind: 'exists' });
  if (draft.change && f.record.maxExposure === 0n) out.push({ kind: 'missing' });
  if (draft.lendUntil !== 0n && draft.lendUntil < earliestLendUntil(f.chainNow, f.minTermsAgeSec))
    out.push({ kind: 'lendUntil', earliest: earliestLendUntil(f.chainNow, f.minTermsAgeSec) });
  const minFill = resolvedMinFill(draft.parsed, f.floor, base);
  if (minFill === null) out.push({ kind: 'floorUnread' });
  else if (f.floor !== null && minFill < f.floor) out.push({ kind: 'belowFloor', floor: f.floor });
  // Every fill must be at least the smallest loan and at most the money set
  // aside, so a smallest loan above the funding could never be made (an
  // Advanced most-at-once above the funding lets the floor reach past it).
  // A change counts the money already waiting too.
  if (minFill !== null && minFill > setAsideAfter(draft, f)) out.push({ kind: 'minAboveFund', minFill });
  // The protocol refuses a smallest loan above the most at once.
  else if (minFill !== null && minFill > exposureOf(draft.parsed, base)) out.push({ kind: 'minAboveExposure', minFill });
  if (f.balance < draft.parsed.fund) out.push({ kind: 'balance', balance: f.balance });
  return out;
}

/** The network's loan-start bound for the pair against the setup's ceiling:
 *  none when the bound does not apply (an unpriced leg), closed when it
 *  opens no new loan against the collateral, else whether the ceiling fits,
 *  with the bound as an approximate loan-to-value for the reader. */
export type LtvCap = { kind: 'none' } | { kind: 'closed' } | { kind: 'cap'; fits: boolean; approxBps: number };

const NO_LOANS = 2n ** 256n - 1n;

/** The loan-start bound read through the protocol's own rules, compared as
 *  a fill compares it: the least collateral `initRiskBounds` takes for
 *  `amount` (the entry every match asks) against the collateral a fill at
 *  the setup's ceiling posts, which is `LibRiskMath.minCollateralForLtvCap`
 *  rebuilt from the same reads (the debt valued rounded up, divided by the
 *  ceiling rounded up, turned into collateral rounded up). Comparing the
 *  amounts, not a loan-to-value derived from a rounded amount, keeps a
 *  low-decimal collateral from understating the bound. The approximate
 *  figure is only for the sentence that names it. Every read is at one
 *  block (the review's), so the floor and the posted amount stand on the
 *  same prices. */
export async function readLtvCap(c: PublicClient, diamond: Hex, lending: Hex, collateral: Hex, amount: bigint, ltvBps: number, blockNumber: bigint): Promise<LtvCap> {
  const [floor] = (await c.readContract({
    address: diamond,
    abi: RISK_PREVIEW,
    functionName: 'initRiskBounds',
    args: [lending, collateral, amount, 0n],
    blockNumber,
  })) as readonly [bigint, boolean, bigint];
  if (floor === 0n) return { kind: 'none' };
  if (floor === NO_LOANS) return { kind: 'closed' };
  const read = <T>(functionName: string, args: readonly unknown[]) => c.readContract({ address: diamond, abi: NUMERAIRE, functionName, args, blockNumber }) as Promise<T>;
  const [lend, coll] = await Promise.all([read<bigint>('getNumeraireValue', [lending, amount, true]), read<bigint>('getNumeraireValue', [collateral, floor, false])]);
  const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
  const posted = ltvBps === 0 ? NO_LOANS : await read<bigint>('getAmountForNumeraireValue', [collateral, ceil(lend * 10_000n, BigInt(ltvBps)), true]);
  const approxBps = coll === 0n ? 0 : Number(ceil(lend * 10_000n, coll));
  return { kind: 'cap', fits: posted >= floor, approxBps };
}

/** The block a ceiling above the network's bound earns, if any. */
export function ltvCapBlock(cap: LtvCap | null): SetupBlock | null {
  if (cap === null || cap.kind === 'none') return null;
  if (cap.kind === 'closed') return { kind: 'ltvClosed' };
  return cap.fits ? null : { kind: 'ltvCap', capBps: cap.approxBps };
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
 *  this wallet on this pair and slot. */
export interface SetupLogs {
  set: boolean;
  funded: bigint | null;
}

export function setupLogs(logs: readonly Log[], diamond: Hex, account: Hex, lending: Hex, collateral: Hex, slot: number): SetupLogs {
  const same = (a: unknown, b: Hex) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  const mine = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi: INTENT, logs: mine as Log[], strict: false }) as unknown as { eventName: string; args: Record<string, unknown> }[];
  let set = false;
  let funded: bigint | null = null;
  for (const e of events) {
    const a = e.args;
    if (!same(a.owner, account) || !same(a.lendingAsset, lending) || !same(a.collateralAsset, collateral) || Number(a.slot) !== slot) continue;
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

/** A basis-point figure as the form types it (`550` → `5.5`). */
export function bpsText(bps: bigint): string {
  const whole = bps / 100n;
  const frac = bps % 100n;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(2, '0').replace(/0$/, '')}`;
}

/** The form a change opens on: the Auto-lend's recorded limits, exactly, and
 *  nothing added. A recorded end date is kept as its day where the reader
 *  is, even when it has passed, so the form asks for a new one rather than
 *  silently dropping it. */
export function inputFromIntent(
  i: { minRateBps: bigint; maxInitLtvBps: number; maxDurationDays: number; lendUntil: bigint; acceptsProRata: boolean; maxExposure: bigint; minFillAmount: bigint },
  decimals: number,
): AutoLendInput {
  return {
    amount: '',
    rate: bpsText(i.minRateBps),
    ltv: bpsText(BigInt(i.maxInitLtvBps)),
    days: String(i.maxDurationDays),
    lendUntil: i.lendUntil === 0n ? '' : localToday(new Date(Number(i.lendUntil) * 1000)),
    proRata: i.acceptsProRata,
    exposure: formatUnits(i.maxExposure, decimals),
    minFill: formatUnits(i.minFillAmount, decimals),
  };
}
