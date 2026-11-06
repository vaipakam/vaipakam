/**
 * OFF-05 / OFF-07 / OFF-16 / OFF-17 / OFF-18 / OFF-19 — what a borrower's
 * own request stands on, read in one go through the wallet's connection,
 * and the rules that turn it into the receipt, the blockers stated in
 * place, and the "what changed" of a re-check.
 *
 * The protocol's verdict is its own: the request is dry-run as `createOffer`
 * from this wallet. Every check the protocol makes before it pulls the
 * collateral is in that answer (the term cap, the pair rules, sanctions,
 * pauses, the risk gate, the amount bounds), so the page never repeats a
 * rule it could get wrong. While the collateral is not yet approved, the
 * dry run stops at the pull itself, which is the one refusal the approval
 * step clears; it is named as such, and the dry run after the approval is
 * the protocol's verdict on the whole request.
 */
import type { Abi, PublicClient } from 'viem';
import { OfferCreateFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../../chain/ownRail';
import type { CopyAccess, CopyKey } from '../../../shared/copy/useCopy';
import { refusalFromError, UNRECOGNISED } from '../../../shared/eligibility/refusal';
import { readAssetClass, type AssetClass } from '../../../shared/offers/assets';
import { shortfall } from '../../../shared/offers/model';
import { CONFIG, readGraceSeconds, readLifBps, readPairLtvBps, readVault, readWalletFunds, tokenAcceptsApproval, type WalletFunds } from '../../../shared/offers/reads';
import type { Receipt } from '../../../shared/receipt/types';
import { tokenAmount, type TokenMetaMap } from '../../../shared/reads/tokens';
import { askThrough } from '../../../shared/tx/simulate';
import { allowanceSteps } from '../../../shared/tx/approval';
import { formatBps, formatSpan, formatUtc, shortAddress } from '../../../shared/ui/format';
import { createParams, requestFigures, ZERO, type CreateParams, type ParsedRequest, type RequestPair } from './requestModel';

type Hex = `0x${string}`;

export const CREATE_ABI = OfferCreateFacetABI as Abi;

/** The request as the reader confirmed it on the form: the figures, the
 *  pair, and the expiry fixed when the review opened, so a re-read never
 *  moves the deadline under a consent. */
export interface RequestDraft {
  parsed: ParsedRequest;
  pair: RequestPair;
  expiresAt: bigint;
}

/** The protocol's answer to the request as a dry run from this wallet. */
export type CreateVerdict =
  /** It would go through as it stands. */
  | { kind: 'ok' }
  /** Every check passed up to pulling the collateral, which the approval
   *  step allows; the dry run after the approval decides. */
  | { kind: 'needs-approval' }
  /** The protocol refused, with its own reason. */
  | { kind: 'refused'; code: string; reason: string }
  /** No answer could be read; the review says so instead of guessing. */
  | { kind: 'unreadable'; reason: string };

export interface RequestReview {
  /** The wallet and network the review was read under (RB-REVIEW). */
  identity: string;
  draft: RequestDraft;
  params: CreateParams;
  verdict: CreateVerdict;
  lendingClass: AssetClass;
  collateralClass: AssetClass;
  /** The loan-to-value at today's prices, in bps; null when a leg is
   *  illiquid (no price) or it could not be read. */
  ltvBps: bigint | null;
  maxDurationDays: bigint;
  graceSeconds: bigint;
  lifBps: bigint;
  /** The borrower's vault; the zero address when posting opens it. */
  vault: Hex;
  funds: WalletFunds;
  /** Wallet prompts the approval takes: 0 when the allowance covers the
   *  collateral, 2 when the token must be set to zero first. */
  approvalSteps: number;
  readAt: number;
}

/** The token errors a pull without an approval ends in, by name and by
 *  selector (the protocol's ABI does not carry a token's errors, so viem
 *  reports them by selector): the transfer the approval step allows, not a
 *  protocol refusal. */
const PULL_ERRORS = new Set(['ERC20InsufficientAllowance', 'SafeERC20FailedOperation', '0xfb8f41b2', '0x5274afe7']);

/** Reads the configured longest term, in days. */
export async function readMaxDurationDays(client: PublicClient, diamond: Hex): Promise<bigint> {
  const bundle = (await client.readContract({ address: diamond, abi: CONFIG, functionName: 'getProtocolConfigBundle' })) as readonly unknown[];
  return bundle[12] as bigint;
}

/**
 * The dry run, judged. With the allowance covering the collateral, any
 * revert is the protocol's refusal. Without it, the dry run stops at the
 * pull unless the protocol refused first, and the protocol refuses only with
 * named errors; so a token's pull error, or a revert this build cannot name
 * (a bare revert as some tokens give, an allowance message), is the pull
 * the approval step clears. The dry run after the approval is the
 * protocol's verdict on the whole request, so nothing is posted on this
 * reading alone.
 */
export function judgeDryRun(
  outcome: { kind: 'answered' } | { kind: 'reverted'; error: unknown } | { kind: 'unreadable'; reason: string },
  allowanceCovers: boolean,
): CreateVerdict {
  if (outcome.kind === 'answered') return { kind: 'ok' };
  if (outcome.kind === 'unreadable') return { kind: 'unreadable', reason: outcome.reason };
  const refusal = refusalFromError(outcome.error);
  if (!allowanceCovers && (PULL_ERRORS.has(refusal.code) || unnamed(refusal.code) || /allowance/i.test(refusal.reason))) return { kind: 'needs-approval' };
  return { kind: 'refused', code: refusal.code, reason: refusal.reason };
}

/** Whether a refusal carries no error name: a bare or unknown revert, or
 *  one known only by its selector. */
export function unnamed(code: string): boolean {
  return code === UNRECOGNISED || /^0x[0-9a-fA-F]{8}$/.test(code);
}

export async function readRequestReview(own: OwnStateClient, diamond: Hex, draft: RequestDraft, identity: string): Promise<RequestReview> {
  const account = own.account;
  const r = <T>(fn: Parameters<OwnStateClient['read']>[0]) => own.read(fn).then((x) => x.value as T);
  const { pair, parsed } = draft;
  const params = createParams(parsed, pair, draft.expiresAt);
  const [lendingClass, collateralClass, maxDurationDays, graceSeconds, lifBps, vault, funds] = await Promise.all([
    r<AssetClass>((c) => readAssetClass(c, diamond, pair.lending)),
    r<AssetClass>((c) => readAssetClass(c, diamond, pair.collateral)),
    r<bigint>((c) => readMaxDurationDays(c, diamond)),
    r<bigint>((c) => readGraceSeconds(c, diamond, BigInt(parsed.durationDays))),
    r<bigint>((c) => readLifBps(c, diamond)),
    r<Hex>((c) => readVault(c, diamond, account)),
    r<WalletFunds>((c) => readWalletFunds(c, pair.collateral, account, diamond)),
  ]);
  const ltvBps =
    lendingClass === 'liquid' && collateralClass === 'liquid'
      ? await r<bigint>((c) => readPairLtvBps(c, diamond, pair.lending, parsed.amount, pair.collateral, parsed.collateral)).catch(() => null)
      : null;
  const covers = funds.allowance >= parsed.collateral;
  const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: CREATE_ABI, functionName: 'createOffer', args: [params], account }));
  const verdict = judgeDryRun(dry, covers);
  const approvalSteps = covers
    ? 0
    : (await allowanceSteps({ accepts: (amount) => r<boolean>((c) => tokenAcceptsApproval(c, pair.collateral, account, diamond, amount)) }, funds.allowance, parsed.collateral))
        .length;
  return { identity, draft, params, verdict, lendingClass, collateralClass, ltvBps, maxDurationDays, graceSeconds, lifBps, vault, funds, approvalSteps, readAt: Date.now() };
}

/** Whether the collateral needs an approval step before posting. */
export function needsApproval(r: Pick<RequestReview, 'funds' | 'draft'>): boolean {
  return r.funds.allowance < r.draft.parsed.collateral;
}

/** The wallet prompts posting asks for: the approval when one is needed,
 *  and the request itself. */
export function promptCount(r: Pick<RequestReview, 'approvalSteps'>): number {
  return 1 + r.approvalSteps;
}

/**
 * Every reason the wallet must not open for this request, in the order the
 * reader should meet them; empty when the protocol reports nothing and the
 * wallet holds the collateral.
 */
export function requestBlockers(r: RequestReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): string[] {
  const out: string[] = [];
  const name = (a: Hex) => meta?.[a.toLowerCase()]?.symbol ?? shortAddress(a);
  for (const [asset, cls] of [
    [r.draft.pair.lending, r.lendingClass],
    [r.draft.pair.collateral, r.collateralClass],
  ] as const) {
    if (cls === 'distrusted') out.push(copy.format('accept.blockDistrusted', { asset: name(asset) }));
  }
  const missing = shortfall(r.funds.balance, r.draft.parsed.collateral);
  if (missing > 0n) {
    const amt = (v: bigint) => tokenAmount(v, r.draft.pair.collateral, meta, copy.format);
    out.push(copy.format('request.blockShortfall', { have: amt(r.funds.balance), missing: amt(missing), need: amt(r.draft.parsed.collateral) }));
  }
  // The protocol's own refusal, unless the wallet's shortfall already
  // explains it (a pull from a wallet that lacks the tokens).
  if (r.verdict.kind === 'refused' && missing === 0n) out.push(copy.format('request.blockRefused', { reason: r.verdict.reason }));
  if (r.verdict.kind === 'unreadable') out.push(copy.format('request.blockUnread', { reason: r.verdict.reason }));
  return out;
}

/** What moved between the review and a re-read of it, as the page names it,
 *  or null when nothing the receipt or the request stands on moved. */
export function changedBetween(a: RequestReview, b: RequestReview, copy: Pick<CopyAccess, 'text'>): string | null {
  if (a.verdict.kind !== b.verdict.kind || (a.verdict.kind === 'refused' && b.verdict.kind === 'refused' && a.verdict.code !== b.verdict.code))
    return copy.text('request.changedVerdict');
  if (a.lendingClass !== b.lendingClass || a.collateralClass !== b.collateralClass || a.ltvBps !== b.ltvBps) return copy.text('accept.changedClass');
  if (a.graceSeconds !== b.graceSeconds || a.lifBps !== b.lifBps || a.maxDurationDays !== b.maxDurationDays) return copy.text('request.changedConfig');
  if (
    shortfall(a.funds.balance, a.draft.parsed.collateral) !== shortfall(b.funds.balance, b.draft.parsed.collateral) ||
    needsApproval(a) !== needsApproval(b) ||
    a.approvalSteps !== b.approvalSteps
  )
    return copy.text('accept.changedFunds');
  if (a.vault.toLowerCase() !== b.vault.toLowerCase()) return copy.text('accept.changedVault');
  return null;
}

/** The receipt (RB-CONFIDENCE): what is locked now, what a lender taking it
 *  would pay and ask back, every term the request binds, and every
 *  consequence. */
export function requestReceipt(r: RequestReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  const { text, format } = copy;
  const { parsed, pair } = r.draft;
  const f = requestFigures(parsed.amount, parsed.rateBps, parsed.durationDays, r.lifBps);
  const amount = (asset: Hex, value: bigint) => ({ kind: 'amount' as const, asset, amount: value });
  const textRow = (label: CopyKey, value: string, binding: boolean) => ({ label: text(label), value: { kind: 'text' as const, text: value }, binding });
  const illiquid = r.lendingClass === 'illiquid' || r.collateralClass === 'illiquid';

  const rows: Receipt['rows'] = [
    { label: text('request.rowLock'), value: amount(pair.collateral, parsed.collateral), binding: true, movesOut: true },
    textRow('accept.rowVault', r.vault === ZERO ? text('accept.vaultNew') : r.vault, false),
    { label: text('request.rowAmount'), value: amount(pair.lending, parsed.amount), binding: true },
    textRow('request.rowWhole', text('request.whole'), true),
    textRow('accept.rowRate', format('accept.rate', { rate: formatBps(parsed.rateBps) }), true),
    textRow('accept.rowDue', format('request.due', { days: String(parsed.durationDays) }), true),
    textRow('accept.rowGrace', format('accept.grace', { span: formatSpan(Number(r.graceSeconds)) }), true),
    // Not bound by the request: the fee is set when a lender takes it, at the
    // rate in force then, so these are today's figures, labelled as such.
    { label: text('request.rowReceive'), value: amount(pair.lending, f.received), binding: false },
    { label: text('accept.rowFee'), value: amount(pair.lending, f.fee), binding: false },
    textRow('accept.rowFeeRule', format('request.feeRule', { rate: formatBps(r.lifBps) }), false),
    { label: text('accept.rowOwe'), value: amount(pair.lending, f.owedAtDue), binding: true },
    textRow('accept.rowInterest', text(parsed.fullTerm ? (parsed.allowsPartialRepay ? 'accept.fullTermPartial' : 'accept.fullTerm') : 'accept.proRata'), true),
    textRow('accept.rowSchedule', text('accept.scheduleNone'), true),
    textRow('accept.rowPartial', text(parsed.allowsPartialRepay ? 'accept.partialYes' : 'accept.partialNo'), true),
    textRow('accept.rowPrepayListing', text('accept.prepayListingNo'), true),
    textRow('accept.rowParallelSale', text('accept.parallelNo'), true),
    textRow('accept.rowRefinance', text('accept.refinanceNone'), true),
    r.draft.expiresAt === 0n
      ? textRow('request.rowExpiry', text('request.expiryNever'), true)
      : textRow('request.rowExpiry', format('request.expiryAt', { time: formatUtc(Number(r.draft.expiresAt)) }), true),
    textRow('request.rowLtv', illiquid ? text('request.ltvIlliquid') : r.ltvBps === null ? text('request.ltvUnread') : format('request.ltv', { ltv: formatBps(r.ltvBps) }), false),
    {
      label: text('accept.rowApproval'),
      value: {
        kind: 'text',
        text: needsApproval(r)
          ? format(r.approvalSteps === 2 ? 'request.approvalZeroFirst' : 'request.approvalNeeded', { amount: tokenAmount(parsed.collateral, pair.collateral, meta, format) })
          : text('accept.approvalEnough'),
      },
      binding: false,
      movesOut: needsApproval(r),
    },
  ];

  const consequences = [
    text('request.loseLocked'),
    text(r.draft.expiresAt === 0n ? 'request.loseOpen' : 'request.loseLapse'),
    text('request.loseTaken'),
    text('accept.loseDefault'),
    ...(r.lendingClass === 'illiquid' ? [text('accept.loseIlliquidLending')] : []),
    ...(r.collateralClass === 'illiquid' ? [text('accept.loseIlliquidCollateral')] : []),
    ...(!illiquid ? [text('accept.loseLiquidation')] : []),
    text(parsed.fullTerm ? (parsed.allowsPartialRepay ? 'accept.loseFullTermPartial' : 'accept.loseFullTerm') : 'accept.loseProRata'),
    text('accept.losePause'),
    text('request.loseBinding'),
  ];

  return { title: text('request.title'), rows, consequences, prompts: promptCount(r), readAt: r.readAt };
}

/** What the form needs before a review: the longest term open, the list
 *  fee for the live summary, and the wallet's collateral balance. */
export interface RequestFormInputs {
  maxDurationDays: bigint;
  lifBps: bigint;
  balance: bigint;
}

export async function readRequestFormInputs(client: PublicClient, diamond: Hex, account: Hex, collateral: Hex): Promise<RequestFormInputs> {
  const [maxDurationDays, lifBps, funds] = await Promise.all([
    readMaxDurationDays(client, diamond),
    readLifBps(client, diamond),
    readWalletFunds(client, collateral, account, diamond),
  ]);
  return { maxDurationDays, lifBps, balance: funds.balance };
}
