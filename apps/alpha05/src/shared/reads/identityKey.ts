/**
 * Identity-scoped reads (rulebook §3.2): every own-state answer is bound to
 * the connected identity AND the chain it was read on. A query key built
 * here can never serve one wallet's rows to another after a wallet change
 * mid-flow, and a result is dropped, not reused, when either part moves.
 */
export interface ReadIdentity {
  chainId: number;
  account: `0x${string}` | null;
}

export type OwnReadKey = readonly ['own', number, `0x${string}`, ...unknown[]];
export type WorldReadKey = readonly ['world', number, ...unknown[]];

/** A key for a read about the connected identity. Throws without an
 *  account: an own-state read with no identity is a programming error, not
 *  an empty result. */
export function ownKey(id: ReadIdentity, ...parts: unknown[]): OwnReadKey {
  if (!id.account) throw new Error('ownKey: no connected identity');
  return ['own', id.chainId, id.account.toLowerCase() as `0x${string}`, ...parts];
}

/** A key for a read about the world (the book, metrics), chain-bound only. */
export function worldKey(chainId: number, ...parts: unknown[]): WorldReadKey {
  return ['world', chainId, ...parts];
}

/** Whether a cached answer still belongs to the identity on screen. */
export function sameIdentity(a: ReadIdentity, b: ReadIdentity): boolean {
  return a.chainId === b.chainId && (a.account ?? '').toLowerCase() === (b.account ?? '').toLowerCase();
}
