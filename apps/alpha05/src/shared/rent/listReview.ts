/**
 * NFT-01 — what an owner's review of a new listing stands on, read through
 * the wallet's own connection: who holds the NFT and whether the protocol may
 * move it, the payment token's class, the buffer share the listing will fix
 * (the protocol's setting at the moment it is posted), the grace period and
 * the protocol's share of the rent as they stand today, and the protocol's
 * own verdict on the listing as a dry run from this wallet.
 *
 * A rental carries no collateral and no health factor, so none is read. The
 * risk-access check is the protocol's own: it judges a rental on its payment
 * token alone, and a refusal names the step that clears it.
 */
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { refusalFromError, UNRECOGNISED } from '../eligibility/refusal';
import { SWITCH_EFFECTS } from '../eligibility/switchClasses';
import { diamondMayMove, holds, readErc721, readErc1155, type Erc721State, type Erc1155State } from '../nft/nft';
import { readAssetClass, type AssetClass } from '../offers/assets';
import { readGraceSeconds, readTreasuryFeeBps, readVault } from '../offers/reads';
import { CREATE_ABI, judgeDryRun, readMaxDurationDays, type CreateVerdict } from '../post/postReview';
import { needFromRefusal, type RiskNeed, type RiskPair } from '../risk/riskAccess';
import { askThrough } from '../tx/simulate';
import { chainValidUntil } from '../tx/deadline';
import { shortAddress } from '../ui/format';
import type { TokenMetaMap } from '../reads/tokens';
import { listParams, type ListDraft, type ListParams } from './listModel';
import { rentalCost, type RentalCost } from './rental';
import { readTodayBufferBps } from './rentReads';

type Hex = `0x${string}`;

const ZERO: Hex = '0x0000000000000000000000000000000000000000';

/** The NFT as the wallet and the protocol stand on it. */
export type ListHolding = { kind: 'erc721'; state: Erc721State } | { kind: 'erc1155'; state: Erc1155State };

export interface ListReview {
  /** The wallet and network the review was read under (RB-REVIEW). */
  identity: string;
  account: Hex;
  diamond: Hex;
  draft: ListDraft;
  params: ListParams;
  holding: ListHolding;
  paymentClass: AssetClass;
  /** The protocol's buffer share now: the listing records it when posted. */
  bufferBps: bigint;
  graceSeconds: bigint;
  maxDurationDays: bigint;
  /** The protocol's share of the rent today (bps), fixed when a renter
   *  takes the listing; null when it could not be read. */
  protocolShareBps: bigint | null;
  /** This wallet's vault; the zero address when posting opens it. */
  vault: Hex;
  verdict: CreateVerdict;
  readAt: number;
}

/** The risk-access pair of a listing: the NFT lent, no collateral, and the
 *  payment token the protocol judges a rental on. */
export function rentalListPair(d: Pick<ListDraft, 'nft' | 'standard' | 'tokenId' | 'payment'>): RiskPair {
  return {
    lendAsset: d.nft,
    lendType: d.standard === 'erc721' ? 1 : 2,
    lendTokenId: d.tokenId,
    collAsset: ZERO,
    collType: 0,
    collTokenId: 0n,
    prepayAsset: d.payment,
  };
}

/** What a renter would pay up front for this listing as it would be posted
 *  now: the rent for the whole term plus the buffer the listing fixes. */
export function listCost(r: Pick<ListReview, 'draft' | 'bufferBps'>): RentalCost {
  return rentalCost(r.draft.dailyFee, r.draft.days, r.bufferBps, r.bufferBps);
}

export async function readListReview(own: OwnStateClient, diamond: Hex, draft: ListDraft, identity: string): Promise<ListReview> {
  const account = own.account;
  const r = <T>(fn: Parameters<OwnStateClient['read']>[0]) => own.read(fn).then((x) => x.value as T);
  const params = listParams(draft);
  const [held, paymentClass, bufferBps, graceSeconds, maxDurationDays, protocolShareBps, vault] = await Promise.all([
    draft.standard === 'erc721'
      ? r<Erc721State>((c) => readErc721(c, draft.nft, draft.tokenId, account, diamond))
      : r<Erc1155State>((c) => readErc1155(c, draft.nft, draft.tokenId, account, diamond)),
    r<AssetClass>((c) => readAssetClass(c, diamond, draft.payment)),
    r<bigint>((c) => readTodayBufferBps(c, diamond)),
    r<bigint>((c) => readGraceSeconds(c, diamond, draft.days)),
    r<bigint>((c) => readMaxDurationDays(c, diamond)),
    // Today's share: stated as such, so a failed read is said, not guessed.
    r<bigint>((c) => readTreasuryFeeBps(c, diamond)).catch(() => null),
    r<Hex>((c) => readVault(c, diamond, account)),
  ]);
  const holding: ListHolding = draft.standard === 'erc721' ? { kind: 'erc721', state: held as Erc721State } : { kind: 'erc1155', state: held as Erc1155State };
  const covers = !needsMove({ holding, diamond });
  const dry = await askThrough(own, async (c) => c.simulateContract({ address: diamond, abi: CREATE_ABI, functionName: 'createOffer', args: [params, await chainValidUntil(c)], account }));
  return {
    identity,
    account,
    diamond,
    draft,
    params,
    holding,
    paymentClass,
    bufferBps,
    graceSeconds,
    maxDurationDays,
    protocolShareBps: protocolShareBps as bigint | null,
    vault,
    verdict: judgeDryRun(dry, covers),
    readAt: Date.now(),
  };
}

/** Whether the protocol still needs the wallet's approval to move the NFT. */
function needsMove(r: Pick<ListReview, 'holding' | 'diamond'>): boolean {
  const h = r.holding;
  return h.kind === 'erc721' ? !diamondMayMove(h.state, r.diamond) : !h.state.approvedForAll;
}

export function listNeedsApproval(r: Pick<ListReview, 'holding' | 'diamond'>): boolean {
  return needsMove(r);
}

/** The approval's wallet prompts: one for an ERC-721 token (that token
 *  alone); two for an ERC-1155 collection (the operator approval, and
 *  taking it back once the listing is posted). */
export function listApprovalPrompts(r: Pick<ListReview, 'holding' | 'diamond'>): number {
  if (!needsMove(r)) return 0;
  return r.holding.kind === 'erc721' ? 1 : 2;
}

/** The wallet prompts posting asks for: the approval steps, and the listing. */
export function listPromptCount(r: Pick<ListReview, 'holding' | 'diamond'>): number {
  return 1 + listApprovalPrompts(r);
}

/** What the wallet lacks of the NFT the listing names. */
export type ListLack = { kind: 'none' } | { kind: 'no-token' } | { kind: 'not-held' } | { kind: 'units'; missing: bigint };

export function listLack(r: Pick<ListReview, 'holding' | 'account' | 'draft'>): ListLack {
  const h = r.holding;
  if (h.kind === 'erc721') return h.state.owner === null ? { kind: 'no-token' } : holds(h.state, r.account) ? { kind: 'none' } : { kind: 'not-held' };
  return h.state.balance < r.draft.quantity ? { kind: 'units', missing: r.draft.quantity - h.state.balance } : { kind: 'none' };
}

/** The risk-access step a refusal names, if any. */
export function listRiskNeed(r: Pick<ListReview, 'verdict'>): RiskNeed | null {
  return r.verdict.kind === 'refused' ? needFromRefusal(r.verdict.code) : null;
}

/** The protocol's refusals a listing words for an owner, by error name. */
const LIST_ERRORS: Readonly<Record<string, CopyKey>> = {
  VpfiNotAllowedAsRentalPrepay: 'rentList.err.VpfiNotAllowedAsRentalPrepay',
  RentalQuantityAboveVaultRange: 'rentList.err.RentalQuantityAboveVaultRange',
  TooManyOpenOffers: 'rentList.err.TooManyOpenOffers',
  SanctionedAddress: 'rentList.err.SanctionedAddress',
  AssetPaused: 'rentList.err.AssetPaused',
  [UNRECOGNISED]: 'rentList.err.Unrecognised',
};

/** The words for a refusal: the listing's own where it has them, the
 *  protocol's reason otherwise. */
export function listErrorText(code: string, reason: string, copy: Pick<CopyAccess, 'text' | 'format'>): string {
  if (code === 'ProtocolPaused') return copy.format('rentList.err.ProtocolPaused', { staysOpen: SWITCH_EFFECTS['2'].staysOpen });
  const key = LIST_ERRORS[code];
  return key ? copy.text(key) : reason;
}

const RISK_BLOCK_KEYS: Readonly<Record<RiskNeed, CopyKey>> = { tier: 'risk.blockTier', 'pair-consent': 'risk.blockConsent', 'mid-tier-ack': 'risk.blockAck' };

/**
 * Every reason the wallet must not open for this listing, in the order the
 * owner should meet them; empty when the protocol reports nothing and the
 * wallet holds the NFT.
 */
export function listBlockers(r: ListReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): string[] {
  const out: string[] = [];
  const name = (a: Hex) => meta?.[a.toLowerCase()]?.symbol ?? shortAddress(a);
  if (r.paymentClass === 'distrusted') out.push(copy.format('rentList.blockDistrusted', { asset: name(r.draft.payment) }));
  const lack = listLack(r);
  const id = String(r.draft.tokenId);
  if (lack.kind === 'no-token') out.push(copy.format('rentList.blockNoToken', { id }));
  else if (lack.kind === 'not-held') out.push(copy.format('rentList.blockNotHeld', { id }));
  else if (lack.kind === 'units' && r.holding.kind === 'erc1155') out.push(copy.format('rentList.blockUnits', { have: String(r.holding.state.balance), need: String(r.draft.quantity), id }));
  // A risk-access refusal comes before the NFT moves, so the lack never
  // explains it; it is named with the step that clears it (ACC-RISK).
  const risk = listRiskNeed(r);
  if (risk !== null) out.push(copy.text(RISK_BLOCK_KEYS[risk]));
  else if (r.verdict.kind === 'refused' && lack.kind === 'none') out.push(copy.format('rentList.blockRefused', { reason: listErrorText(r.verdict.code, r.verdict.reason, copy) }));
  if (r.verdict.kind === 'unreadable') out.push(copy.format('rentList.blockUnread', { reason: r.verdict.reason }));
  return out;
}

/** The refusal a dry run or a send ended in, in the listing's words. */
export function listRefusal(e: unknown, copy: Pick<CopyAccess, 'text' | 'format'>): string {
  const f = refusalFromError(e);
  return listErrorText(f.code, f.reason, copy);
}

function lackKey(l: ListLack): string {
  return l.kind === 'units' ? `units:${l.missing}` : l.kind;
}

/** What moved between the review and a re-read of it, as the page names it,
 *  or null when nothing the receipt or the listing stands on moved. */
export function listChangedBetween(a: ListReview, b: ListReview, copy: Pick<CopyAccess, 'text'>): string | null {
  if (a.verdict.kind !== b.verdict.kind || (a.verdict.kind === 'refused' && b.verdict.kind === 'refused' && a.verdict.code !== b.verdict.code))
    return copy.text('rentList.changedVerdict');
  if (a.paymentClass !== b.paymentClass) return copy.text('accept.changedClass');
  if (a.bufferBps !== b.bufferBps) return copy.text('rent.changedBuffer');
  if (a.graceSeconds !== b.graceSeconds || a.maxDurationDays !== b.maxDurationDays || a.protocolShareBps !== b.protocolShareBps) return copy.text('request.changedConfig');
  if (lackKey(listLack(a)) !== lackKey(listLack(b)) || listApprovalPrompts(a) !== listApprovalPrompts(b)) return copy.text('request.changedToken');
  if (a.vault.toLowerCase() !== b.vault.toLowerCase()) return copy.text('accept.changedVault');
  return null;
}
