/**
 * OFF-59 — signing a new order from the desk's ticket, and listing it on the
 * offer book. Signing is off the chain: the wallet signs the order's terms
 * (EIP-712, bound to this network and deployment), nothing is set aside, and
 * nothing reaches the chain until a taker fills it. At a fill the protocol
 * draws the stake from the signer's own vault, checking then what it would
 * check of a posted offer; until then the order binds the signer, and only
 * an on-chain cancel stops it before it lapses.
 *
 * What the reader reviews is what the wallet signs: the order is built once,
 * with its nonce, when the review opens (`signDraftFrom`), and the receipt
 * and the signature both read that one order (RB-REVIEW). The review states
 * what the vault holds free of the stake now, read from the protocol, and
 * never blocks on it: a fill draws on the vault as it stands then.
 *
 * Listing is one POST to the offer book. Its answer is read by status
 * (`bookAnswer`): listed, refused with the book's own code, or unknown. A
 * signed order whose answer is unknown is kept on this device so it can be
 * sent again (the book lists an order once); a refused one is dropped,
 * since nobody else holds its signature.
 */
import type { Abi, PublicClient } from 'viem';
import { VaultDepositoryFacetABI } from '@vaipakam/contracts/abis';
import type { CopyAccess } from '../copy/useCopy';
import { ASSET_TYPE } from '../nft/nft';
import { createParams } from '../post/postModel';
import type { PostDraft } from '../post/postReview';
import type { Receipt, ReceiptRow, ReceiptText } from '../receipt/types';
import { figured, textValue } from '../receipt/types';
import { IndexerUnavailable, type IndexerPoster } from '../reads/world/indexerClient';
import { lapseText, orderSentence, type AmountWords } from './cancelSigned';
import { bookAnswer, orderHashOf, randomNonce, signedStake, type BookAnswer, type SignedOrderWire } from './signedOrder';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

const DEPOSITORY = VaultDepositoryFacetABI as Abi;

/** The order under review: built once, with its nonce, for one wallet on
 *  one network. */
export interface SignDraft {
  /** `chainId:account` the review was opened for (RB-REVIEW). */
  identity: string;
  chainId: number;
  draft: PostDraft;
  order: SignedOrderWire;
  orderHash: Hex;
}

/** The order as signed, kept until the offer book's answer is known. */
export interface SignedRecord {
  identity: string;
  chainId: number;
  order: SignedOrderWire;
  orderHash: Hex;
  signature: Hex;
}

export function identityOf(chainId: number, account: Hex): string {
  return `${chainId}:${account.toLowerCase()}`;
}

/**
 * OFF-59 — the signed order for a ticket's draft, in the wire form the book
 * stores and a taker replays (addresses lowercased, numbers as decimal
 * text), built from the same `createParams` a posted offer sends, so the
 * two carry the same terms.
 *
 * The app signs only orders a fill can draw from the signer's own vault in
 * one piece: ERC-20 on both sides, one size, all or none (the protocol's
 * matcher would otherwise fill slices of it), no fee tariff and no price
 * guard (a signed order carries neither). Its signature lapses with it: the
 * deadline is the expiry, and an order with no expiry is refused, because
 * only an on-chain cancel would ever stop it. Each refusal throws: the
 * ticket never builds such a draft in sign mode.
 */
export function signedOrderFrom(draft: PostDraft, signer: Hex, nonce: bigint): SignedOrderWire {
  const { parsed, pair } = draft;
  if (pair.leg.kind !== 'erc20') throw new Error('a signed order takes token collateral only');
  if (draft.expiresAt === 0n) throw new Error('a signed order needs an expiry');
  if (parsed.fillMode !== 'aon' || parsed.amount !== parsed.amountMax || parsed.collateralFloor !== parsed.collateral) {
    throw new Error('a signed order is one size, all or none');
  }
  if (parsed.tariff !== null || parsed.guardBps !== null) throw new Error('a signed order carries no fee tariff and no price guard');
  const p = createParams(parsed, pair, draft.expiresAt, draft.side);
  const lower = (a: Hex) => a.toLowerCase();
  return {
    offerType: String(p.offerType),
    lendingAsset: lower(p.lendingAsset),
    amount: String(p.amount),
    amountMax: String(p.amountMax),
    interestRateBps: String(p.interestRateBps),
    interestRateBpsMax: String(p.interestRateBpsMax),
    collateralAsset: lower(p.collateralAsset),
    collateralAmount: String(p.collateralAmount),
    collateralAmountMax: String(p.collateralAmountMax),
    durationDays: String(p.durationDays),
    assetType: String(p.assetType),
    collateralAssetType: String(p.collateralAssetType),
    tokenId: String(p.tokenId),
    quantity: String(p.quantity),
    collateralTokenId: String(p.collateralTokenId),
    collateralQuantity: String(p.collateralQuantity),
    prepayAsset: lower(p.prepayAsset),
    allowsPartialRepay: p.allowsPartialRepay,
    allowsPrepayListing: p.allowsPrepayListing,
    allowsParallelSale: p.allowsParallelSale,
    expiresAt: String(p.expiresAt),
    fillMode: String(p.fillMode),
    periodicInterestCadence: String(p.periodicInterestCadence),
    refinanceTargetLoanId: String(p.refinanceTargetLoanId),
    useFullTermInterest: p.useFullTermInterest,
    creatorFull: false,
    creatorMaxCStar: '0',
    creatorAllowFullDowngrade: false,
    signer: lower(signer),
    nonce: String(nonce),
    deadline: String(p.expiresAt),
  };
}

/** The order a ticket's draft signs, with a fresh nonce. Throws when the
 *  draft is not one a signed order can carry (`signedOrderFrom`). */
export function signDraftFrom(draft: PostDraft, chainId: number, account: Hex, nonce: bigint = randomNonce()): SignDraft {
  const order = signedOrderFrom(draft, account, nonce);
  return { identity: identityOf(chainId, account), chainId, draft, order, orderHash: orderHashOf(order) };
}

/** What the review reads from the chain: its clock, and what the signer's
 *  vault holds free of the stake asset (the protocol's own count, the rule a
 *  fill applies; null with the reason when it could not be read). */
export interface SignReview {
  chainNow: bigint;
  free: { kind: 'read'; amount: bigint } | { kind: 'unread'; reason: string };
  readAt: number;
}

export async function readSignReview(c: PublicClient, diamond: Hex, order: SignedOrderWire): Promise<SignReview> {
  const stake = signedStake(order);
  const [block, free] = await Promise.all([
    c.getBlock({ blockTag: 'latest' }),
    (
      c.readContract({
        address: diamond,
        abi: DEPOSITORY,
        functionName: 'freeHolding',
        args: [order.signer as Hex, ASSET_TYPE.erc20, stake.asset, 0n],
      }) as Promise<bigint>
    ).then(
      (amount): SignReview['free'] => ({ kind: 'read', amount }),
      (e: unknown): SignReview['free'] => ({ kind: 'unread', reason: (e as Error).message?.split('\n')[0] ?? 'no answer' }),
    ),
  ]);
  return { chainNow: block.timestamp, free, readAt: Date.now() };
}

/** What stops the signature, first first; empty when it may be signed. */
export type SignBlocker = 'no-book' | 'identity' | 'lapsed';

export function signBlockers(d: SignDraft, r: SignReview | null, ctx: { identity: string | null; bookConfigured: boolean }): SignBlocker[] {
  const out: SignBlocker[] = [];
  if (!ctx.bookConfigured) out.push('no-book');
  if (ctx.identity !== d.identity) out.push('identity');
  if (r !== null && r.chainNow >= BigInt(d.order.expiresAt)) out.push('lapsed');
  return out;
}

/** How much more the vault must hold free for a fill to draw the stake;
 *  0 when it holds enough now, null when that could not be read. */
export function stakeShortfall(d: Pick<SignDraft, 'order'>, r: Pick<SignReview, 'free'>): bigint | null {
  if (r.free.kind !== 'read') return null;
  const need = signedStake(d.order).amount;
  return r.free.amount >= need ? 0n : need - r.free.amount;
}

/** RB-CONFIDENCE — the receipt shown before the wallet signs. */
export function signNewReceipt(d: SignDraft, r: SignReview, amount: AmountWords, copy: Copy): Receipt {
  const { text, format } = copy;
  const stake = signedStake(d.order);
  const rows: ReceiptRow[] = [
    { label: text('signNew.rowOrder'), value: textValue(figured((exact) => orderSentence(d.order, amount, copy, exact))), binding: true },
    { label: text('signNew.rowLapses'), value: { kind: 'text', text: lapseText(d.order, copy) }, binding: true },
    { label: text('signNew.rowFills'), value: { kind: 'text', text: text('signNew.fillsWhole') }, binding: true },
    { label: text('signNew.rowNow'), value: { kind: 'text', text: text('signNew.nowNothing') }, binding: false },
    { label: text('signNew.rowAtFill'), value: { kind: 'amount', asset: stake.asset, amount: stake.amount }, binding: true, movesOut: true },
    {
      label: text('signNew.rowFree'),
      value: r.free.kind === 'read' ? { kind: 'amount', asset: stake.asset, amount: r.free.amount } : { kind: 'unknown', why: r.free.reason },
      binding: false,
    },
  ];
  const consequences: ReceiptText[] = [text('signNew.checksAtFill'), text('signedOrders.onlyWay'), text('signNew.network')];
  const short = stakeShortfall(d, r);
  if (short !== null && short > 0n) {
    consequences.push(figured((exact) => format('signNew.short', { missing: amount(stake.asset, short, exact) })));
  }
  return { title: text('signNew.title'), rows, consequences, prompts: 1, readAt: r.readAt };
}

/** Send a signed order to the offer book. A refusal is an answer; no
 *  answer at all leaves whether it was listed unknown. */
export async function listSignedOrder(indexer: IndexerPoster, rec: SignedRecord): Promise<BookAnswer> {
  try {
    const res = await indexer.postJson('/signed-offers', { chainId: rec.chainId, order: rec.order, signature: rec.signature });
    return bookAnswer(res.status, res.body, rec.orderHash);
  } catch (e) {
    return { kind: 'unknown', reason: e instanceof IndexerUnavailable ? e.message : (e as Error).message };
  }
}

/** The book's refusal, as a sentence. Codes the book shares with the chain
 *  are named; any other is quoted. */
export function refusalSentence(code: string, copy: Copy): string {
  switch (code) {
    case 'bad-signature':
      return copy.text('signNew.refusedSignature');
    case 'nonce-used':
    case 'order-consumed':
    case 'order-terminal':
      return copy.text('signNew.refusedUsed');
    case 'expired':
    case 'deadline-passed':
    case 'invalid-expiresAt':
    case 'invalid-deadline':
      return copy.text('signNew.refusedLapsed');
    default:
      return copy.format('signNew.refusedCode', { code });
  }
}
