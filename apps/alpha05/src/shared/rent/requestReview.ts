/**
 * NFT-02 — what a renter's review of a new rental request stands on, read
 * through the wallet's own connection: the payment token's class and the
 * wallet's balance and allowance of it, the buffer share the request will
 * fix (the protocol's setting at the moment it is posted), the grace period
 * as it stands today, who holds the named NFT now when the collection says
 * (an ERC-721 token), and the protocol's own verdict on the request as a dry
 * run from this wallet.
 *
 * A rental carries no collateral and no health factor, so none is read. The
 * risk-access check is the protocol's own: it judges a rental on its payment
 * token alone, and a refusal names the step that clears it.
 */
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { refusalFromError, UNRECOGNISED } from '../eligibility/refusal';
import { SWITCH_EFFECTS } from '../eligibility/switchClasses';
import { readErc721, type Erc721State } from '../nft/nft';
import { readAssetClass, type AssetClass } from '../offers/assets';
import { shortfall } from '../offers/model';
import { readGraceSeconds, readVault, readWalletFunds, tokenAcceptsApproval, type WalletFunds } from '../offers/reads';
import { CREATE_ABI, judgeDryRun, readMaxDurationDays, type CreateVerdict } from '../post/postReview';
import { tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { needFromRefusal, type RiskNeed } from '../risk/riskAccess';
import { allowanceSteps } from '../tx/approval';
import { askThrough } from '../tx/simulate';
import { shortAddress } from '../ui/format';
import { requestParams, type ListDraft, type RequestParams } from './listModel';
import { rentalCost, type RentalCost } from './rental';
import { readTodayBufferBps } from './rentReads';

type Hex = `0x${string}`;

export interface RequestReview {
  /** The wallet and network the review was read under (RB-REVIEW). */
  identity: string;
  account: Hex;
  diamond: Hex;
  draft: ListDraft;
  params: RequestParams;
  /** Who holds the named ERC-721 token now; null for an ERC-1155 token,
   *  whose holders a collection does not list. */
  token: Erc721State | null;
  paymentClass: AssetClass;
  /** The protocol's buffer share now: the request records it when posted. */
  bufferBps: bigint;
  graceSeconds: bigint;
  maxDurationDays: bigint;
  /** This wallet's vault; the zero address when posting opens it. */
  vault: Hex;
  /** The wallet's balance and allowance of the payment token. */
  funds: WalletFunds;
  /** Wallet prompts the approval takes (0, 1, or 2 when set to zero first). */
  approvalSteps: number;
  verdict: CreateVerdict;
  readAt: number;
}

/** What posting the request moves now: the rent for the whole term plus the
 *  buffer the request fixes, from the wallet into the renter's own vault. */
export function requestCost(r: Pick<RequestReview, 'draft' | 'bufferBps'>): RentalCost {
  return rentalCost(r.draft.dailyFee, r.draft.days, r.bufferBps, r.bufferBps);
}

export async function readRequestReview(own: OwnStateClient, diamond: Hex, draft: ListDraft, identity: string): Promise<RequestReview> {
  const account = own.account;
  const r = <T>(fn: Parameters<OwnStateClient['read']>[0]) => own.read(fn).then((x) => x.value as T);
  const params = requestParams(draft);
  const [token, paymentClass, bufferBps, graceSeconds, maxDurationDays, vault, funds] = await Promise.all([
    draft.standard === 'erc721' ? r<Erc721State>((c) => readErc721(c, draft.nft, draft.tokenId, account, diamond)) : Promise.resolve(null),
    r<AssetClass>((c) => readAssetClass(c, diamond, draft.payment)),
    r<bigint>((c) => readTodayBufferBps(c, diamond)),
    r<bigint>((c) => readGraceSeconds(c, diamond, draft.days)),
    r<bigint>((c) => readMaxDurationDays(c, diamond)),
    r<Hex>((c) => readVault(c, diamond, account)),
    r<WalletFunds>((c) => readWalletFunds(c, draft.payment, account, diamond)),
  ]);
  const total = rentalCost(draft.dailyFee, draft.days, bufferBps, bufferBps).total;
  const approvalSteps =
    funds.allowance >= total
      ? 0
      : (await allowanceSteps({ accepts: (amount) => r<boolean>((c) => tokenAcceptsApproval(c, draft.payment, account, diamond, amount)) }, funds.allowance, total)).length;
  const covers = funds.allowance >= total && funds.balance >= total;
  const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: CREATE_ABI, functionName: 'createOffer', args: [params], account }));
  return {
    identity,
    account,
    diamond,
    draft,
    params,
    token,
    paymentClass,
    bufferBps,
    graceSeconds,
    maxDurationDays,
    vault,
    funds,
    approvalSteps,
    verdict: judgeDryRun(dry, covers),
    readAt: Date.now(),
  };
}

export function requestNeedsApproval(r: Pick<RequestReview, 'funds' | 'draft' | 'bufferBps'>): boolean {
  return r.funds.allowance < requestCost(r).total;
}

/** The wallet prompts posting asks for: the approval steps, and the request. */
export function requestPromptCount(r: Pick<RequestReview, 'approvalSteps'>): number {
  return 1 + r.approvalSteps;
}

/** What the named NFT's collection says about it, when it says anything:
 *  the token does not exist yet, or this wallet already holds it. */
export type RequestTokenNote = 'none' | 'no-token' | 'own-token';

export function requestTokenNote(r: Pick<RequestReview, 'token' | 'account'>): RequestTokenNote {
  if (r.token === null) return 'none';
  if (r.token.owner === null) return 'no-token';
  return r.token.owner.toLowerCase() === r.account.toLowerCase() ? 'own-token' : 'none';
}

/** The risk-access step a refusal names, if any. */
export function requestRiskNeed(r: Pick<RequestReview, 'verdict'>): RiskNeed | null {
  return r.verdict.kind === 'refused' ? needFromRefusal(r.verdict.code) : null;
}

/** The protocol's refusals a request words for a renter, by error name. */
const REQUEST_ERRORS: Readonly<Record<string, CopyKey>> = {
  VpfiNotAllowedAsRentalPrepay: 'rentList.err.VpfiNotAllowedAsRentalPrepay',
  RentalQuantityAboveVaultRange: 'rentList.err.RentalQuantityAboveVaultRange',
  TooManyOpenOffers: 'rentList.err.TooManyOpenOffers',
  SanctionedAddress: 'rentRequest.err.SanctionedAddress',
  AssetPaused: 'rentList.err.AssetPaused',
  [UNRECOGNISED]: 'rentRequest.err.Unrecognised',
};

/** The words for a refusal: the request's own where it has them, the
 *  protocol's reason otherwise. */
export function requestErrorText(code: string, reason: string, copy: Pick<CopyAccess, 'text' | 'format'>): string {
  if (code === 'ProtocolPaused') return copy.format('rentRequest.err.ProtocolPaused', { staysOpen: SWITCH_EFFECTS['2'].staysOpen });
  const key = REQUEST_ERRORS[code];
  return key ? copy.text(key) : reason;
}

const RISK_BLOCK_KEYS: Readonly<Record<RiskNeed, CopyKey>> = { tier: 'risk.blockTier', 'pair-consent': 'risk.blockConsent', 'mid-tier-ack': 'risk.blockAck' };

/**
 * Every reason the wallet must not open for this request, in the order the
 * renter should meet them; empty when the protocol reports nothing and the
 * wallet holds the rent and buffer.
 */
export function requestBlockers(r: RequestReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): string[] {
  const out: string[] = [];
  const name = (a: Hex) => meta?.[a.toLowerCase()]?.symbol ?? shortAddress(a);
  if (r.paymentClass === 'distrusted') out.push(copy.format('rentList.blockDistrusted', { asset: name(r.draft.payment) }));
  // Nobody else can take a request for a token this wallet holds itself.
  if (requestTokenNote(r) === 'own-token') out.push(copy.format('rentRequest.blockOwnToken', { id: String(r.draft.tokenId) }));
  const total = requestCost(r).total;
  const missing = shortfall(r.funds.balance, total);
  if (missing > 0n) {
    const amt = (v: bigint) => tokenAmount(v, r.draft.payment, meta, copy.format);
    out.push(copy.format('rentRequest.blockShortfall', { have: amt(r.funds.balance), missing: amt(missing), need: amt(total) }));
  }
  // A risk-access refusal comes before any funds move, so the shortfall never
  // explains it; it is named with the step that clears it (ACC-RISK).
  const risk = requestRiskNeed(r);
  if (risk !== null) out.push(copy.text(RISK_BLOCK_KEYS[risk]));
  else if (r.verdict.kind === 'refused' && missing === 0n) out.push(copy.format('rentRequest.blockRefused', { reason: requestErrorText(r.verdict.code, r.verdict.reason, copy) }));
  if (r.verdict.kind === 'unreadable') out.push(copy.format('rentRequest.blockUnread', { reason: r.verdict.reason }));
  return out;
}

/** The refusal a dry run or a send ended in, in the request's words. */
export function requestRefusal(e: unknown, copy: Pick<CopyAccess, 'text' | 'format'>): string {
  const f = refusalFromError(e);
  return requestErrorText(f.code, f.reason, copy);
}

/** What moved between the review and a re-read of it, as the page names it,
 *  or null when nothing the receipt or the request stands on moved. */
export function requestChangedBetween(a: RequestReview, b: RequestReview, copy: Pick<CopyAccess, 'text'>): string | null {
  if (a.verdict.kind !== b.verdict.kind || (a.verdict.kind === 'refused' && b.verdict.kind === 'refused' && a.verdict.code !== b.verdict.code))
    return copy.text('rentRequest.changedVerdict');
  if (a.paymentClass !== b.paymentClass) return copy.text('accept.changedClass');
  if (a.bufferBps !== b.bufferBps) return copy.text('rent.changedBuffer');
  if (a.graceSeconds !== b.graceSeconds || a.maxDurationDays !== b.maxDurationDays) return copy.text('request.changedConfig');
  if (requestTokenNote(a) !== requestTokenNote(b)) return copy.text('request.changedToken');
  const total = requestCost(a).total;
  if (shortfall(a.funds.balance, total) !== shortfall(b.funds.balance, total) || requestNeedsApproval(a) !== requestNeedsApproval(b) || a.approvalSteps !== b.approvalSteps)
    return copy.text('accept.changedFunds');
  if (a.vault.toLowerCase() !== b.vault.toLowerCase()) return copy.text('accept.changedVault');
  return null;
}
