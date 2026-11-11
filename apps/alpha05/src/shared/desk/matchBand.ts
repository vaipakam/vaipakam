/**
 * OFF-63 — the desk's match band: when a market's two sides overlap (the
 * highest borrower rate is at or above the lowest lender rate), anyone may
 * match a lender's offer against a borrower's request with
 * `OfferMatchFacet.matchOffers`, which opens the loan between the two who
 * posted them at the middle of the two rates. The one who sends the match
 * takes no side of the loan, moves none of its own funds and pays the gas;
 * the protocol pays it a share of the loan initiation fee the borrower pays
 * (`getLifMatcherFeeBps`, out of `getLoanInitiationFeeBps` of the matched
 * amount), and only if the match lands.
 *
 * The band never offers a pair the protocol has not confirmed: each
 * candidate pair is asked of `previewMatch`, which runs `matchOffers`'s own
 * checks in its order (the pause, the sender's sanctions screen, the
 * matching switch, the two offers' terms, the sender's matching capacity,
 * the loan's cadence and both makers' price-move guards) and answers with
 * the amount, the rate and the collateral a match would lock. The matching
 * switch (`getPartialFillEnabled`) is read and stated on its own, so a
 * network where it is off says so rather than showing no band.
 *
 * The share is stated as an upper bound: the borrower's fee discount, which
 * the protocol resolves only at the match, lowers the fee and the share
 * with it. The outcome is measured from the transaction's own logs: the
 * `OfferMatched` event for this pair and this sender, and the lending-token
 * transfers that reached the sender's wallet or its vault.
 */
import { erc20Abi, parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { ConfigFacetABI, OfferMatchFacetABI, ServiceCapacityFacetABI, VaultFactoryFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import type { Refusal } from '../eligibility/types';
import type { BookRow } from '../offers/book';
import { answerOrNull } from '../reads/answer';
import type { Receipt, ReceiptRow } from '../receipt/types';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { formatBps, shortAddress } from '../ui/format';
import type { DeskLadder } from './markets';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

export const MATCH = OfferMatchFacetABI as Abi;
const CONFIG = ConfigFacetABI as Abi;
const CAPACITY = ServiceCapacityFacetABI as Abi;
const VAULTS = VaultFactoryFacetABI as Abi;
const ZERO = '0x0000000000000000000000000000000000000000';

/** How many overlapping pairs the band asks the protocol about, best
 *  priced first. */
export const MATCH_PAIRS = 12;

/** `ServiceCapacityRole.Solver`: the role a match is counted against. */
const SOLVER_ROLE = 0;

/** `LibOfferMatch.MatchError`, by ordinal. */
export const MATCH_OK = 0;
const REFUSAL: readonly CopyKey[] = [
  'matchBand.codeOk',
  'matchBand.codeAsset',
  'matchBand.codeAssetType',
  'matchBand.codeDuration',
  'matchBand.codeAmount',
  'matchBand.codeRate',
  'matchBand.codeCollateral',
  'matchBand.codeTaken',
  'matchBand.codeSide',
  'matchBand.codeHealth',
  'matchBand.codeLtv',
  'matchBand.codeSelf',
  'matchBand.codeExpired',
  'matchBand.codeAon',
  'matchBand.codeRefinance',
  'matchBand.codeCarryOver',
  'matchBand.codeSale',
  'matchBand.codeOffset',
  'matchBand.codeCapacity',
  'matchBand.codePaused',
  'matchBand.codeSanctioned',
  'matchBand.codeSwitch',
  'matchBand.codeTerms',
  'matchBand.codeCadence',
  'matchBand.codeGuard',
  'matchBand.codeFresh',
];

/** Why the protocol refuses a pair, in words. */
export function refusalText(code: number, copy: Copy): string {
  const key = REFUSAL[code];
  return key ? copy.text(key) : copy.format('matchBand.codeOther', { code: String(code) });
}

/** A lender's offer and a borrower's request whose rates overlap. */
export interface MatchPair {
  ask: BookRow;
  bid: BookRow;
}

export function pairKey(p: Pick<MatchPair, 'ask' | 'bid'>): string {
  return `${p.ask.id}-${p.bid.id}`;
}

/**
 * Whether two offers' rate ranges meet, by the protocol's own match rule: the
 * higher of the two floors must not be above the lower of the two ceilings.
 * The ladder's overlap is weaker (a lender's floor at or below a borrower's
 * ceiling), so a crossed ladder can hold no pair a match accepts.
 */
export function ratesMeet(ask: Pick<BookRow, 'interestRateBps' | 'interestRateBpsMax'>, bid: Pick<BookRow, 'interestRateBps' | 'interestRateBpsMax'>): boolean {
  const lo = ask.interestRateBps > bid.interestRateBps ? ask.interestRateBps : bid.interestRateBps;
  const hi = ask.interestRateBpsMax < bid.interestRateBpsMax ? ask.interestRateBpsMax : bid.interestRateBpsMax;
  return lo <= hi;
}

/** The pairs a crossed ladder offers to match. `crossed` repeats the
 *  ladder's own overlap, so an empty list can say why it is empty. */
export interface OverlapPairs {
  pairs: MatchPair[];
  more: boolean;
  crossed: boolean;
}

/**
 * The overlapping pairs on a ladder, best priced first: every lender offer
 * whose rate is at or below the highest borrower rate, against every
 * borrower request whose rate is at or above the lowest lender rate, ordered
 * by how far each side sits from its best (the best ask against the best bid
 * first). A pair is kept only where the two rate ranges meet (`ratesMeet`),
 * and a pair from one wallet is left out: the protocol never matches a
 * wallet with itself. At most `limit` pairs; `more` says others stand behind.
 */
export function overlapPairs(ladder: Pick<DeskLadder, 'asks' | 'bids' | 'crossed'>, limit = MATCH_PAIRS): OverlapPairs {
  if (!ladder.crossed) return { pairs: [], more: false, crossed: false };
  const bestBid = ladder.bids[0]?.rateBps;
  const bestAsk = ladder.asks[0]?.rateBps;
  if (bestBid === undefined || bestAsk === undefined) return { pairs: [], more: false, crossed: false };
  const asks = ladder.asks.filter((s) => s.rateBps <= bestBid).flatMap((s) => s.offers);
  const bids = ladder.bids.filter((s) => s.rateBps >= bestAsk).flatMap((s) => s.offers);
  const all: { pair: MatchPair; rank: number; i: number }[] = [];
  asks.forEach((ask, i) =>
    bids.forEach((bid, j) => {
      if (ask.creator.toLowerCase() === bid.creator.toLowerCase()) return;
      if (!ratesMeet(ask, bid)) return;
      all.push({ pair: { ask, bid }, rank: i + j, i });
    }),
  );
  all.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return { pairs: all.slice(0, limit).map((x) => x.pair), more: all.length > limit, crossed: true };
}

/** The protocol's answer for one pair. */
export interface PairVerdict {
  code: number;
  amount: bigint;
  rateBps: bigint;
  collateral: bigint;
}

/** The settings a match turns on, read at one block. Null where a read was
 *  refused. */
export interface MatchSettings {
  /** The matching switch (`getPartialFillEnabled`). */
  switchOn: boolean | null;
  lifBps: bigint | null;
  matcherBps: bigint | null;
  /** Whether a matching-capacity limit is in force (the solver curve has a
   *  free tier); null when unread. */
  capacityLimited: boolean | null;
}

export interface MatchBandRead {
  settings: MatchSettings;
  /** One per pair asked, in order; null where the preview was refused. */
  verdicts: (PairVerdict | null)[];
}

function verdictFrom(v: unknown): PairVerdict | null {
  if (v === null || typeof v !== 'object') return null;
  const r = v as { errorCode?: number | bigint; matchAmount?: bigint; matchRateBps?: bigint; reqCollateral?: bigint };
  if (r.errorCode === undefined || r.matchAmount === undefined || r.matchRateBps === undefined || r.reqCollateral === undefined) return null;
  return { code: Number(r.errorCode), amount: r.matchAmount, rateBps: r.matchRateBps, collateral: r.reqCollateral };
}

export async function readMatchSettings(c: PublicClient, diamond: Hex, blockNumber: bigint): Promise<MatchSettings> {
  const at = { blockNumber };
  const read = <T>(abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    answerOrNull(c.readContract({ address: diamond, abi, functionName, args, ...at }) as Promise<T>);
  const [switchOn, lifBps, matcherBps, curve] = await Promise.all([
    read<boolean>(CONFIG, 'getPartialFillEnabled'),
    read<bigint>(CONFIG, 'getLoanInitiationFeeBps'),
    read<bigint>(CONFIG, 'getLifMatcherFeeBps'),
    read<{ freeTier: bigint }>(CAPACITY, 'getCapacityCurve', [SOLVER_ROLE]),
  ]);
  return { switchOn, lifBps, matcherBps, capacityLimited: curve === null ? null : curve.freeTier > 0n };
}

export async function readPairVerdict(c: PublicClient, diamond: Hex, pair: MatchPair, sender: Hex, blockNumber: bigint): Promise<PairVerdict | null> {
  const v = await answerOrNull(
    c.readContract({ address: diamond, abi: MATCH, functionName: 'previewMatch', args: [pair.ask.id, pair.bid.id, sender, sender], blockNumber }),
  );
  return verdictFrom(v);
}

/** The settings and every pair's verdict, at one block, as `sender` would
 *  send the match. The pairs are asked only while the switch is on. */
export async function readMatchBand(c: PublicClient, diamond: Hex, pairs: readonly MatchPair[], sender: Hex): Promise<MatchBandRead> {
  const blockNumber = await c.getBlockNumber();
  const settings = await readMatchSettings(c, diamond, blockNumber);
  if (settings.switchOn !== true) return { settings, verdicts: pairs.map(() => null) };
  const verdicts = await Promise.all(pairs.map((p) => readPairVerdict(c, diamond, p, sender, blockNumber)));
  return { settings, verdicts };
}

/** What the band shows, from a read. */
export type BandState =
  | { kind: 'switch-unread' }
  | { kind: 'switch-off' }
  | { kind: 'no-overlap' }
  /** The ladder's sides cross, but no lender's rate range meets a
   *  borrower's, so the protocol would refuse every pair. */
  | { kind: 'no-rate' }
  /** A pair the protocol confirms; `top` is the best-priced pair's refusal
   *  when that pair is not the one offered. */
  | { kind: 'ready'; pair: MatchPair; verdict: PairVerdict; top: { pair: MatchPair; code: number | null } | null }
  /** No pair checked can be matched now; the best-priced pair's reason. */
  | { kind: 'none'; pair: MatchPair; code: number | null };

export function bandState(found: Pick<OverlapPairs, 'pairs' | 'crossed'>, read: MatchBandRead): BandState {
  const { pairs } = found;
  if (read.settings.switchOn === null) return { kind: 'switch-unread' };
  if (!read.settings.switchOn) return { kind: 'switch-off' };
  if (pairs.length === 0) return { kind: found.crossed ? 'no-rate' : 'no-overlap' };
  const first = pairs.findIndex((_, i) => read.verdicts[i]?.code === MATCH_OK);
  const topCode = read.verdicts[0]?.code ?? null;
  if (first < 0) return { kind: 'none', pair: pairs[0]!, code: topCode };
  return {
    kind: 'ready',
    pair: pairs[first]!,
    verdict: read.verdicts[first]!,
    top: first === 0 ? null : { pair: pairs[0]!, code: topCode },
  };
}

/** The most the sender's share can be for a match of `amount`: the
 *  matcher's part of the full initiation fee, rounded down as the protocol
 *  rounds it. A borrower's fee discount lowers it. */
export function shareAtMost(amount: bigint, lifBps: bigint, matcherBps: bigint): bigint {
  return (((amount * lifBps) / 10_000n) * matcherBps) / 10_000n;
}

/** The review of one match, read at one block. */
export interface MatchReview {
  identity: string;
  pair: MatchPair;
  verdict: PairVerdict | null;
  settings: MatchSettings;
  /** The sender's vault, where a share lands when the sender has protected
   *  mode on; null when it has none or the read was refused. */
  vault: Hex | null;
  dryRun: Refusal | null | 'unread';
  readAt: number;
}

/** What stops the match, in words (empty when nothing does). */
export function matchBlockers(r: Pick<MatchReview, 'verdict' | 'settings' | 'dryRun'>, copy: Copy): string[] {
  const { text, format } = copy;
  if (r.settings.switchOn === null) return [text('matchBand.switchUnread')];
  if (!r.settings.switchOn) return [text('matchBand.switchOff')];
  if (r.verdict === null) return [text('matchBand.previewUnread')];
  if (r.verdict.code !== MATCH_OK) return [format('matchBand.refused', { reason: refusalText(r.verdict.code, copy) })];
  if (r.dryRun === 'unread') return [text('matchBand.dryRunUnread')];
  if (r.dryRun !== null) return [format('matchBand.dryRunRefused', { reason: r.dryRun.reason })];
  return [];
}

export async function readMatchReview(own: OwnStateClient, diamond: Hex, pair: MatchPair, identity: string, copy: Copy): Promise<MatchReview> {
  const sender = own.account;
  const { verdict, settings, vault } = await own
    .read(async (c: PublicClient) => {
      const blockNumber = await c.getBlockNumber();
      const [s, v, vaultAt] = await Promise.all([
        readMatchSettings(c, diamond, blockNumber),
        readPairVerdict(c, diamond, pair, sender, blockNumber),
        answerOrNull(c.readContract({ address: diamond, abi: VAULTS, functionName: 'getUserVaultAddress', args: [sender], blockNumber }) as Promise<Hex>),
      ]);
      return { verdict: v, settings: s, vault: vaultAt === null || vaultAt.toLowerCase() === ZERO ? null : vaultAt };
    })
    .then((x) => x.value);
  const base: MatchReview = { identity, pair, verdict, settings, vault, dryRun: null, readAt: Date.now() };
  if (matchBlockers(base, copy).length > 0) return base;
  const dry = await askThrough(own, (c) =>
    c.simulateContract({ address: diamond, abi: MATCH, functionName: 'matchOffers', args: [pair.ask.id, pair.bid.id], account: sender }),
  );
  return { ...base, dryRun: dry.kind === 'answered' ? null : dry.kind === 'reverted' ? refusalFromError(dry.error) : 'unread', readAt: Date.now() };
}

/** What a re-read found changed, in words, or null. */
export function matchChanged(a: MatchReview, b: MatchReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  const va = a.verdict;
  const vb = b.verdict;
  if (
    (va === null) !== (vb === null) ||
    (va && vb && (va.code !== vb.code || va.amount !== vb.amount || va.rateBps !== vb.rateBps || va.collateral !== vb.collateral))
  )
    return text('matchBand.changedTerms');
  const sa = a.settings;
  const sb = b.settings;
  if (sa.switchOn !== sb.switchOn) return text('matchBand.changedSwitch');
  if (sa.lifBps !== sb.lifBps || sa.matcherBps !== sb.matcherBps) return text('matchBand.changedShare');
  if (sa.capacityLimited !== sb.capacityLimited) return text('matchBand.changedCapacity');
  if ((a.dryRun === null) !== (b.dryRun === null) || (a.dryRun === 'unread') !== (b.dryRun === 'unread')) return text('matchBand.changedVerdict');
  return null;
}

/** Amount words, short or exact. */
export type AmountWords = (asset: Hex, v: bigint, exact?: boolean) => string;

/** Who posted a side, in words: you, or the wallet's short address. */
function who(creator: Hex, sender: Hex, copy: Copy): string {
  return creator.toLowerCase() === sender.toLowerCase() ? copy.text('matchBand.you') : shortAddress(creator);
}

/** The share line: what it is at most, or why it cannot be stated. */
export function shareText(amount: bigint, lending: Hex, s: MatchSettings, words: AmountWords, copy: Copy, exact = false): string {
  if (s.lifBps === null || s.matcherBps === null) return copy.text('matchBand.shareUnread');
  return copy.format('matchBand.shareAtMost', {
    amount: words(lending, shareAtMost(amount, s.lifBps, s.matcherBps), exact),
    pct: formatBps(s.matcherBps),
  });
}

/** The capacity line: whose capacity a match counts against, or that no
 *  limit is in force. */
export function capacityText(s: MatchSettings, copy: Copy): string {
  if (s.capacityLimited === null) return copy.text('matchBand.capacityUnread');
  return copy.text(s.capacityLimited ? 'matchBand.capacityYours' : 'matchBand.capacityNone');
}

export function matchReceipt(r: MatchReview, sender: Hex, words: AmountWords, copy: Copy): Receipt {
  const { text, format } = copy;
  const { ask, bid } = r.pair;
  const lending = ask.lendingAsset;
  const rows: ReceiptRow[] = [
    {
      label: text('matchBand.rowPair'),
      value: {
        kind: 'text',
        text: format('matchBand.pair', {
          ask: ask.id.toString(),
          bid: bid.id.toString(),
          lender: who(ask.creator, sender, copy),
          borrower: who(bid.creator, sender, copy),
        }),
      },
      binding: true,
    },
  ];
  const v = r.verdict;
  if (v !== null && v.code === MATCH_OK) {
    rows.push(
      { label: text('matchBand.rowAmount'), value: { kind: 'text', text: words(lending, v.amount), exact: words(lending, v.amount, true) }, binding: true },
      { label: text('matchBand.rowRate'), value: { kind: 'text', text: format('matchBand.rate', { rate: formatBps(v.rateBps) }) }, binding: true },
      {
        label: text('matchBand.rowCollateral'),
        value: { kind: 'text', text: words(bid.collateralAsset, v.collateral), exact: words(bid.collateralAsset, v.collateral, true) },
        binding: true,
      },
      { label: text('matchBand.rowTerm'), value: { kind: 'text', text: format('matchBand.term', { days: ask.durationDays.toString() }) }, binding: true },
      {
        label: text('matchBand.rowShare'),
        value: {
          kind: 'text',
          text: shareText(v.amount, lending, r.settings, words, copy),
          exact: shareText(v.amount, lending, r.settings, words, copy, true),
        },
        binding: false,
      },
    );
  } else {
    rows.push({ label: text('matchBand.rowAmount'), value: { kind: 'unknown', why: text('matchBand.previewUnread') }, binding: true });
  }
  rows.push(
    { label: text('matchBand.rowYouPay'), value: { kind: 'text', text: text('matchBand.youPay') }, binding: false },
    { label: text('matchBand.rowCapacity'), value: { kind: 'text', text: capacityText(r.settings, copy) }, binding: false },
  );
  return {
    title: text('matchBand.reviewTitle'),
    rows,
    consequences: [text('matchBand.loanIsTheirs'), text('matchBand.shareConditional'), text('matchBand.race')],
    prompts: 1,
    readAt: r.readAt,
  };
}

/** The outcome, from the transaction's own logs: the match for this pair
 *  and this sender, and the share that reached the sender's wallet or its
 *  vault. */
export function measureMatch(r: MatchReview, logs: readonly Log[], diamond: Hex, sender: Hex, words: AmountWords, copy: Copy): LegOutcome[] {
  const { text, format } = copy;
  const me = sender.toLowerCase();
  const events = parseEventLogs({ abi: MATCH, logs: logs as Log[], strict: false }).filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const matched = events.find((e) => {
    const a = e.args as { lenderOfferId?: bigint; borrowerOfferId?: bigint; matcher?: string };
    return e.eventName === 'OfferMatched' && a.lenderOfferId === r.pair.ask.id && a.borrowerOfferId === r.pair.bid.id && a.matcher?.toLowerCase() === me;
  });
  if (!matched) return [{ status: 'not-done', label: text('matchBand.legMatch'), reason: text('matchBand.legMissing') }];
  const a = matched.args as { loanId?: bigint; matchAmount?: bigint; matchRateBps?: bigint };
  const lending = r.pair.ask.lendingAsset;
  const legs: LegOutcome[] = [
    {
      status: 'done',
      label: format('matchBand.legOpened', {
        loan: (a.loanId ?? 0n).toString(),
        amount: words(lending, a.matchAmount ?? 0n),
        rate: formatBps(a.matchRateBps ?? 0n),
      }),
    },
  ];
  // The share is paid to the sender's wallet, or into its vault when the
  // sender has protected mode on. A sender who is also the borrower gets
  // the loan amount in its vault too, so only its wallet is counted then.
  const borrower = r.pair.bid.creator.toLowerCase() === me;
  const to = new Set([me, ...(r.vault && !borrower ? [r.vault.toLowerCase()] : [])]);
  const transfers = parseEventLogs({ abi: erc20Abi, logs: logs as Log[], eventName: 'Transfer', strict: false }).filter(
    (l) => l.address.toLowerCase() === lending.toLowerCase() && to.has(String((l.args as { to?: string }).to ?? '').toLowerCase()),
  );
  const got = transfers.reduce((n, l) => n + ((l.args as { value?: bigint }).value ?? 0n), 0n);
  legs.push(
    got > 0n
      ? { status: 'done', label: format('matchBand.legShare', { amount: words(lending, got) }) }
      : borrower
        ? { status: 'unknown', label: text('matchBand.legShareLabel'), reason: text('matchBand.legShareMixed') }
        : { status: 'not-done', label: text('matchBand.legShareLabel'), reason: text('matchBand.legNoShare') },
  );
  return legs;
}
