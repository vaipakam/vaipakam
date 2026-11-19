/**
 * #3773 — the embedded lending kit.
 *
 * A wallet, marketplace or game opens the platform's own borrow, lend or
 * rent flow for its user with one link, pre-filled, carrying the
 * integrator's id. The kit only BUILDS that link (and opens it). It holds
 * no key, signs nothing, renders no form and never shows a rate: the user
 * always meets the platform's own review screen in their own wallet before
 * anything is signed.
 *
 * The same module PARSES the link for the app, so the two sides read one
 * rule: a link the builder would refuse is a link the app refuses.
 *
 * Where a share applies (IntegratorFeeShareDesign.md §5): an integrator is
 * paid a share of the loan initiation fee only on a loan whose BORROWER side
 * named it. So the id can bring a share through "borrow against this". On
 * "lend this" the id is attribution only (a lender's action never names an
 * integrator). On "rent this" there is no initiation fee to share. The
 * share is never earnings, income or a revenue share; the review states
 * whether one is paid on the user's loan, and to whom.
 */

export type Hex = `0x${string}`;

/** The link format's version. A link carrying another is refused. */
export const KIT_LINK_VERSION = '1';

/** The path the app answers a kit link on. */
export const KIT_PATH = '/kit';

export type KitAction = 'borrow' | 'lend' | 'rent';

/** Whether an integrator named on this action can be paid a share. */
export type ShareRule = 'may-apply' | 'attribution-only' | 'no-fee';

/** The share rule for each entry point, from IntegratorFeeShareDesign §5. */
export const SHARE_RULE: Record<KitAction, ShareRule> = {
  borrow: 'may-apply',
  lend: 'attribution-only',
  rent: 'no-fee',
};

/** "Borrow against this": an asset the user holds, as collateral. An NFT
 *  names its token id (and, for an ERC-1155, a quantity). */
export interface BorrowRequest {
  action: 'borrow';
  chainId: number;
  /** The collateral the user holds. */
  asset: Hex;
  tokenId?: bigint;
  quantity?: bigint;
  /** The asset to borrow, when the integrator suggests one. */
  lendingAsset?: Hex;
  integrator?: Hex;
}

/** "Lend this": an amount of a token, in its base units. */
export interface LendRequest {
  action: 'lend';
  chainId: number;
  asset: Hex;
  amount: bigint;
  integrator?: Hex;
}

/** "Rent this": a token offered for rent. */
export interface RentRequest {
  action: 'rent';
  chainId: number;
  /** The collection. */
  asset: Hex;
  tokenId: bigint;
  integrator?: Hex;
}

export type KitRequest = BorrowRequest | LendRequest | RentRequest;

export class KitLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KitLinkError';
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/i;
const WHOLE = /^\d+$/;
const MAX_UINT = 2n ** 256n - 1n;

function address(v: string | null | undefined, what: string, optional: true): Hex | undefined;
function address(v: string | null | undefined, what: string, optional?: false): Hex;
function address(v: string | null | undefined, what: string, optional = false): Hex | undefined {
  if (v === null || v === undefined || v === '') {
    if (optional) return undefined;
    throw new KitLinkError(`${what} is required`);
  }
  if (!ADDRESS.test(v) || ZERO.test(v)) throw new KitLinkError(`${what} must be a non-zero 0x address`);
  return v.toLowerCase() as Hex;
}

function whole(v: string | null | undefined, what: string, min: bigint): bigint | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (!WHOLE.test(v)) throw new KitLinkError(`${what} must be a whole number`);
  const n = BigInt(v);
  if (n < min || n > MAX_UINT) throw new KitLinkError(`${what} is out of range`);
  return n;
}

function chain(v: string | null | undefined): number {
  if (v === null || v === undefined || !/^[1-9]\d{0,15}$/.test(v)) throw new KitLinkError('chain must be a positive chain id');
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new KitLinkError('chain must be a positive chain id');
  return n;
}

/** The request, checked: the same checks the parser applies. */
export function checkRequest(r: KitRequest): KitRequest {
  return parseKitParams(kitParams(r));
}

function kitParams(r: KitRequest): URLSearchParams {
  const p = new URLSearchParams();
  p.set('v', KIT_LINK_VERSION);
  p.set('action', r.action);
  p.set('chain', String(r.chainId));
  p.set('asset', r.asset);
  if (r.action === 'borrow') {
    if (r.tokenId !== undefined) p.set('tokenId', r.tokenId.toString());
    if (r.quantity !== undefined) p.set('quantity', r.quantity.toString());
    if (r.lendingAsset !== undefined) p.set('lending', r.lendingAsset);
  } else if (r.action === 'lend') {
    p.set('amount', r.amount.toString());
  } else {
    p.set('tokenId', r.tokenId.toString());
  }
  if (r.integrator !== undefined) p.set('integrator', r.integrator);
  return p;
}

/**
 * The link that opens the platform's review for `r`, on the app at
 * `appOrigin` (for example `https://alpha05.vaipakam.com`). Throws a
 * {@link KitLinkError} for a request the app would refuse.
 */
export function kitLink(appOrigin: string, r: KitRequest): string {
  const origin = new URL(appOrigin);
  if (origin.protocol !== 'https:' && origin.hostname !== 'localhost' && origin.hostname !== '127.0.0.1') {
    throw new KitLinkError('the app origin must be https');
  }
  checkRequest(r);
  const url = new URL(KIT_PATH, origin.origin);
  url.search = kitParams(r).toString();
  return url.toString();
}

export const borrowAgainstLink = (appOrigin: string, r: Omit<BorrowRequest, 'action'>) => kitLink(appOrigin, { action: 'borrow', ...r });
export const lendLink = (appOrigin: string, r: Omit<LendRequest, 'action'>) => kitLink(appOrigin, { action: 'lend', ...r });
export const rentLink = (appOrigin: string, r: Omit<RentRequest, 'action'>) => kitLink(appOrigin, { action: 'rent', ...r });

/** The parts of a window `openKit` uses; structural so it needs no DOM types. */
interface KitWindow {
  opener: unknown;
  document: { createElement(tag: 'a'): { href: string; rel: string; click(): void }; body: { appendChild(n: unknown): unknown } | null };
}

/**
 * Opens a kit link in a new tab. Returns false only when the browser
 * blocked the window (the integrator then shows the link itself).
 *
 * A window opened with `noopener` comes back as no handle even when it
 * opened, so the tab is opened blank, its handle back to the opener is cut
 * before anything loads, and the link is followed from inside it with
 * `noopener noreferrer`: the review never has a handle on the integrator's
 * page, and the integrator's address is not sent as the referrer. The app's
 * own opener policy also separates it from a cross-origin opener on load.
 */
export function openKit(link: string): boolean {
  const w = globalThis.open?.('', '_blank') as unknown as KitWindow | null | undefined;
  if (w === null || w === undefined) return false;
  w.opener = null;
  const a = w.document.createElement('a');
  a.href = link;
  a.rel = 'noopener noreferrer';
  w.document.body?.appendChild(a);
  a.click();
  return true;
}

/** Reads a kit link's query. Throws a {@link KitLinkError} naming the first
 *  thing it cannot accept; nothing is guessed or defaulted. */
export function parseKitParams(p: URLSearchParams): KitRequest {
  if (p.get('v') !== KIT_LINK_VERSION) throw new KitLinkError(`this link's version is not ${KIT_LINK_VERSION}`);
  const action = p.get('action');
  const chainId = chain(p.get('chain'));
  const asset = address(p.get('asset'), 'asset');
  const integrator = address(p.get('integrator'), 'integrator', true);
  const base = { chainId, asset, ...(integrator ? { integrator } : {}) };
  if (action === 'borrow') {
    const tokenId = whole(p.get('tokenId'), 'tokenId', 0n);
    const quantity = whole(p.get('quantity'), 'quantity', 1n);
    if (quantity !== undefined && tokenId === undefined) throw new KitLinkError('quantity needs a tokenId');
    const lendingAsset = address(p.get('lending'), 'lending', true);
    return {
      action,
      ...base,
      ...(tokenId !== undefined ? { tokenId } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
      ...(lendingAsset ? { lendingAsset } : {}),
    };
  }
  if (action === 'lend') {
    const amount = whole(p.get('amount'), 'amount', 1n);
    if (amount === undefined) throw new KitLinkError('amount is required');
    return { action, ...base, amount };
  }
  if (action === 'rent') {
    const tokenId = whole(p.get('tokenId'), 'tokenId', 0n);
    if (tokenId === undefined) throw new KitLinkError('tokenId is required');
    return { action, ...base, tokenId };
  }
  throw new KitLinkError('action must be borrow, lend or rent');
}
