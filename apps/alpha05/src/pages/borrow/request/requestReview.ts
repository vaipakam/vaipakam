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
import { assetName, tokenAmount, type TokenMetaMap } from '../../../shared/reads/tokens';
import { askThrough } from '../../../shared/tx/simulate';
import { allowanceSteps } from '../../../shared/tx/approval';
import { formatBps, formatSpan, formatUtc, shortAddress } from '../../../shared/ui/format';
import { createParams, requestFigures, ZERO, type CollateralLeg, type CreateParams, type ParsedRequest, type RequestPair } from './requestModel';
import { pageHandoff } from '../../../routes/pageMap';
import { needFromRefusal, type RiskNeed } from '../../../shared/risk/riskAccess';
import { diamondMayMove, holds, readErc1155, readErc721, type Erc1155State, type Erc721State } from '../../../shared/nft/nft';

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
  /** The wallet the review was read for, and the protocol it would post to. */
  account: Hex;
  diamond: Hex;
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
  /** What the wallet holds of the collateral and what it lets the protocol
   *  move, read at the same time as the rest. */
  holding: Holding;
  readAt: number;
}

/** The collateral as the wallet stands on it. An ERC-20 leg: the balance and
 *  allowance, and the wallet prompts the approval takes (0 when the
 *  allowance covers it, 2 when the token must be set to zero first). An
 *  ERC-721 leg (NFT-13): who holds the token and whether the protocol may
 *  move it. An ERC-1155 leg: how many of the token the wallet holds and
 *  whether the wallet already lets the protocol move the collection. */
export type Holding =
  | { kind: 'erc20'; funds: WalletFunds; approvalSteps: number }
  | { kind: 'erc721'; tokenId: bigint; state: Erc721State }
  | { kind: 'erc1155'; tokenId: bigint; quantity: bigint; state: Erc1155State };

/** The token errors a pull without an approval ends in, by name and by
 *  selector (the protocol's ABI does not carry a token's errors, so viem
 *  reports them by selector): the transfer the approval step allows, not a
 *  protocol refusal. */
const PULL_ERRORS = new Set(['ERC20InsufficientAllowance', 'SafeERC20FailedOperation', '0xfb8f41b2', '0x5274afe7', 'ERC721InsufficientApproval', '0x177e802f', 'ERC1155MissingApprovalForAll', '0xe237d922']);

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
  const leg = pair.leg;
  const [lendingClass, collateralClass, maxDurationDays, graceSeconds, lifBps, vault, held] = await Promise.all([
    r<AssetClass>((c) => readAssetClass(c, diamond, pair.lending)),
    r<AssetClass>((c) => readAssetClass(c, diamond, pair.collateral)),
    r<bigint>((c) => readMaxDurationDays(c, diamond)),
    r<bigint>((c) => readGraceSeconds(c, diamond, BigInt(parsed.durationDays))),
    r<bigint>((c) => readLifBps(c, diamond)),
    r<Hex>((c) => readVault(c, diamond, account)),
    leg.kind === 'erc721'
      ? r<Erc721State>((c) => readErc721(c, pair.collateral, leg.tokenId, account, diamond))
      : leg.kind === 'erc1155'
        ? r<Erc1155State>((c) => readErc1155(c, pair.collateral, leg.tokenId, account, diamond))
        : r<WalletFunds>((c) => readWalletFunds(c, pair.collateral, account, diamond)),
  ]);
  // A token is never priced, so only an ERC-20 pair has a loan-to-value.
  const ltvBps =
    leg.kind === 'erc20' && lendingClass === 'liquid' && collateralClass === 'liquid'
      ? await r<bigint>((c) => readPairLtvBps(c, diamond, pair.lending, parsed.amount, pair.collateral, parsed.collateral)).catch(() => null)
      : null;
  let holding: Holding;
  if (leg.kind === 'erc721') {
    holding = { kind: 'erc721', tokenId: leg.tokenId, state: held as Erc721State };
  } else if (leg.kind === 'erc1155') {
    holding = { kind: 'erc1155', tokenId: leg.tokenId, quantity: leg.quantity, state: held as Erc1155State };
  } else {
    const funds = held as WalletFunds;
    const approvalSteps =
      funds.allowance >= parsed.collateral
        ? 0
        : (await allowanceSteps({ accepts: (amount) => r<boolean>((c) => tokenAcceptsApproval(c, pair.collateral, account, diamond, amount)) }, funds.allowance, parsed.collateral))
            .length;
    holding = { kind: 'erc20', funds, approvalSteps };
  }
  const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: CREATE_ABI, functionName: 'createOffer', args: [params], account }));
  const verdict = judgeDryRun(dry, !needsApproval({ holding, draft, diamond }));
  return { identity, account, diamond, draft, params, verdict, lendingClass, collateralClass, ltvBps, maxDurationDays, graceSeconds, lifBps, vault, holding, readAt: Date.now() };
}

/** Whether the collateral needs an approval step before posting. */
type Standing = Pick<RequestReview, 'holding' | 'draft' | 'diamond'>;

export function needsApproval(r: Standing): boolean {
  const h = r.holding;
  if (h.kind === 'erc721') return !diamondMayMove(h.state, r.diamond);
  if (h.kind === 'erc1155') return !h.state.approvedForAll;
  return h.funds.allowance < r.draft.parsed.collateral;
}

/** The wallet prompts the approval takes: one for an ERC-721 token; for an
 *  ERC-1155 collection, two (the operator approval, and taking it back
 *  once the request settles); the allowance steps for an ERC-20. */
export function approvalPrompts(r: Standing): number {
  const h = r.holding;
  if (h.kind === 'erc721') return needsApproval(r) ? 1 : 0;
  if (h.kind === 'erc1155') return needsApproval(r) ? 2 : 0;
  return h.approvalSteps;
}

/** The wallet prompts posting asks for: the approval steps when needed,
 *  and the request itself. */
export function promptCount(r: Standing): number {
  return 1 + approvalPrompts(r);
}

/** What the wallet lacks of the collateral: an ERC-20 shortfall in base
 *  units, for an ERC-721 token that it does not exist or is held elsewhere,
 *  or for an ERC-1155 token how many of it the wallet is short. */
export type Lack = { kind: 'none' } | { kind: 'amount'; missing: bigint } | { kind: 'no-token' } | { kind: 'not-held' } | { kind: 'units'; missing: bigint };

export function collateralLack(r: Pick<RequestReview, 'holding' | 'draft' | 'account'>): Lack {
  const h = r.holding;
  if (h.kind === 'erc721') return h.state.owner === null ? { kind: 'no-token' } : holds(h.state, r.account) ? { kind: 'none' } : { kind: 'not-held' };
  if (h.kind === 'erc1155') return h.state.balance < h.quantity ? { kind: 'units', missing: h.quantity - h.state.balance } : { kind: 'none' };
  const missing = shortfall(h.funds.balance, r.draft.parsed.collateral);
  return missing > 0n ? { kind: 'amount', missing } : { kind: 'none' };
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
  const lack = collateralLack(r);
  const h = r.holding;
  if (lack.kind === 'amount' && h.kind === 'erc20') {
    const amt = (v: bigint) => tokenAmount(v, r.draft.pair.collateral, meta, copy.format);
    out.push(copy.format('request.blockShortfall', { have: amt(h.funds.balance), missing: amt(lack.missing), need: amt(r.draft.parsed.collateral) }));
  } else if ((lack.kind === 'no-token' || lack.kind === 'not-held') && h.kind === 'erc721') {
    out.push(copy.format(lack.kind === 'no-token' ? 'request.blockNoToken' : 'request.blockNotHeld', { id: String(h.tokenId) }));
  } else if (lack.kind === 'units' && h.kind === 'erc1155') {
    out.push(copy.format('request.blockUnits', { have: String(h.state.balance), need: String(h.quantity), id: String(h.tokenId) }));
  }
  // A risk-access refusal comes before the pull, so the shortfall never
  // explains it; it is named with the step that clears it (ACC-RISK).
  const risk = requestRiskNeed(r);
  if (risk !== null) out.push(copy.text(RISK_BLOCK_KEYS[risk]));
  // The protocol's own refusal, unless what the wallet lacks already
  // explains it (a pull from a wallet that lacks the tokens or the token).
  else if (r.verdict.kind === 'refused' && lack.kind === 'none') out.push(copy.format('request.blockRefused', { reason: r.verdict.reason }));
  if (r.verdict.kind === 'unreadable') out.push(copy.format('request.blockUnread', { reason: r.verdict.reason }));
  return out;
}

const RISK_BLOCK_KEYS: Readonly<Record<RiskNeed, CopyKey>> = { tier: 'risk.blockTier', 'pair-consent': 'risk.blockConsent', 'mid-tier-ack': 'risk.blockAck' };

/** The risk-access step the protocol's dry run asks of this wallet, if its
 *  refusal is one (ACC-RISK). */
export function requestRiskNeed(r: Pick<RequestReview, 'verdict'>): RiskNeed | null {
  return r.verdict.kind === 'refused' ? needFromRefusal(r.verdict.code) : null;
}

/** What moved between the review and a re-read of it, as the page names it,
 *  or null when nothing the receipt or the request stands on moved. */
export function changedBetween(a: RequestReview, b: RequestReview, copy: Pick<CopyAccess, 'text'>): string | null {
  if (a.verdict.kind !== b.verdict.kind || (a.verdict.kind === 'refused' && b.verdict.kind === 'refused' && a.verdict.code !== b.verdict.code))
    return copy.text('request.changedVerdict');
  if (a.lendingClass !== b.lendingClass || a.collateralClass !== b.collateralClass || a.ltvBps !== b.ltvBps) return copy.text('accept.changedClass');
  if (a.graceSeconds !== b.graceSeconds || a.lifBps !== b.lifBps || a.maxDurationDays !== b.maxDurationDays) return copy.text('request.changedConfig');
  if (lackKey(collateralLack(a)) !== lackKey(collateralLack(b)) || needsApproval(a) !== needsApproval(b) || approvalPrompts(a) !== approvalPrompts(b))
    return copy.text(a.holding.kind === 'erc20' ? 'accept.changedFunds' : 'request.changedToken');
  if (a.vault.toLowerCase() !== b.vault.toLowerCase()) return copy.text('accept.changedVault');
  return null;
}

function lackKey(l: Lack): string {
  return l.kind === 'amount' || l.kind === 'units' ? `${l.kind}:${l.missing}` : l.kind;
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
  const h = r.holding;
  const tokenName = lockedName(h, pair.collateral, meta, format);
  const collection = assetName(pair.collateral, meta);

  const rows: Receipt['rows'] = [
    h.kind === 'erc20'
      ? { label: text('request.rowLock'), value: amount(pair.collateral, parsed.collateral), binding: true, movesOut: true }
      : { label: text('request.rowLock'), value: { kind: 'text', text: tokenName }, binding: true, movesOut: true },
    textRow('accept.rowVault', r.vault === ZERO ? text('accept.vaultNew') : r.vault, false),
    { label: text('request.rowAmount'), value: amount(pair.lending, parsed.amount), binding: true },
    textRow('request.rowWhole', text('request.whole'), true),
    textRow('accept.rowRate', format('accept.rate', { rate: formatBps(parsed.rateBps) }), true),
    textRow('accept.rowDue', format('request.due', { days: String(parsed.durationDays) }), true),
    // Not bound by the request or the loan: the grace period is read from the
    // live configuration when it is applied, so it is today's figure.
    textRow('accept.rowGrace', format('accept.grace', { span: formatSpan(Number(r.graceSeconds)) }), false),
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
        text: !needsApproval(r)
          ? h.kind === 'erc1155'
            ? format('request.approvalOperatorEnough', { collection })
            : text(h.kind === 'erc721' ? 'request.approvalTokenEnough' : 'accept.approvalEnough')
          : h.kind === 'erc721'
            ? format('request.approvalToken', { token: tokenName })
            : h.kind === 'erc1155'
              ? format('request.approvalOperator', { collection })
              : format(h.approvalSteps === 2 ? 'request.approvalZeroFirst' : 'request.approvalNeeded', { amount: tokenAmount(parsed.collateral, pair.collateral, meta, format) }),
      },
      binding: false,
      movesOut: needsApproval(r),
    },
  ];

  // Where the request is followed and cancelled after posting: said before
  // the collateral locks, not discovered afterwards (pageHandoff).
  const manage = pageHandoff('/offers');
  const consequences = [
    text('request.loseLocked'),
    ...(manage.kind === 'here' ? [] : [text(manage.kind === 'currentApp' ? 'request.manageElsewhere' : 'request.manageNowhere')]),
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
 *  fee for the live summary, and the wallet's collateral balance (none for
 *  an ERC-721 leg, whose token is checked by its id in the review). */
export interface RequestFormInputs {
  maxDurationDays: bigint;
  lifBps: bigint;
  balance: bigint | null;
}

export async function readRequestFormInputs(client: PublicClient, diamond: Hex, account: Hex, collateral: Hex, standard: CollateralLeg['kind']): Promise<RequestFormInputs> {
  const [maxDurationDays, lifBps, balance] = await Promise.all([
    readMaxDurationDays(client, diamond),
    readLifBps(client, diamond),
    standard === 'erc20' ? readWalletFunds(client, collateral, account, diamond).then((f) => f.balance) : Promise.resolve(null),
  ]);
  return { maxDurationDays, lifBps, balance };
}

/** The collateral as the review and the outcome name it: "NFT #7 of vRENT"
 *  for an ERC-721 token, "3 of token #5 of vMULTI" for an ERC-1155 leg;
 *  empty for an ERC-20 leg, which is named by its amount. */
export function lockedName(h: Holding, collateral: Hex, meta: TokenMetaMap | null, format: CopyAccess['format']): string {
  const asset = assetName(collateral, meta);
  if (h.kind === 'erc721') return format('asset.nft', { asset, id: String(h.tokenId) });
  if (h.kind === 'erc1155') return format('asset.nft1155', { asset, id: String(h.tokenId), amount: String(h.quantity) });
  return '';
}

