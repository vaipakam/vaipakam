/**
 * Did a failed contract read come back as a REVERT, or did it never get an
 * answer at all?
 *
 * The distinction decides real behaviour and the two are opposite facts: a
 * revert is the chain's authoritative "no" — no such loan, a burned position
 * NFT, a not-claimable side — while a transport failure means nothing was
 * established and the caller must not act as though it had.
 *
 * This lives here because two surfaces need the SAME answer and disagreeing
 * would be worse than either choice. The connected app's Claim Center has
 * always pruned a side whose `ownerOf` reverts while treating a transport
 * failure as unknown; the indexer's #2101 repair needs exactly that rule
 * when deciding whether a position token is burned or merely unreadable
 * (#2190 r6 `4007752763`). An indexer that cleared an owner on a transport
 * blip would hide a live holder's claim; one that never cleared a burned
 * one would keep publishing a claim already taken.
 *
 * It is deliberately NARROW. A related effort (#2107) spent four review
 * rounds trying to classify which failures are futile to RETRY and got it
 * wrong every time, because that predicate is unbounded. This one is not
 * the same question: it asks only whether the node executed the call and
 * answered, which viem models with two concrete error classes.
 *
 * NO `instanceof`, AND THAT IS THE POINT OF THIS FILE EXISTING (#2190 r11
 * `4009116588`). The first version here was lifted unchanged out of the app,
 * where `e instanceof BaseError` had always worked because caller and
 * predicate shared one viem. Moving it to a shared package broke that
 * silently: pnpm resolves `viem` per peer context, and the app and this
 * package currently land on two different physical copies —
 *
 *   apps/app     → .pnpm/viem@2.48.11_…_zod@3.25.76/…
 *   packages/lib → .pnpm/viem@2.48.11_…_zod@4.4.3/…
 *
 * — so a `BaseError` thrown by the app's own `PublicClient` is not an
 * instance of the `BaseError` this module imported. Same version, same
 * bytes, different module identity. The predicate returned `false` for every
 * real revert, which is the WRONG side of a deliberately asymmetric rule:
 * Claim Center would read a burned position as a transport failure and make
 * the whole result unavailable, and the legacy enumeration fallback would
 * never be attempted.
 *
 * Structural matching has no such coupling. `walk` and `name` are viem's own
 * public error surface, are what its documentation tells consumers to switch
 * on, and carry no module identity — so this answers the same question for
 * any caller, whichever copy of viem threw.
 */

/** viem's `BaseError`, structurally: the `walk` traversal is what makes an
 *  error chain inspectable, and every viem error exposes it. */
type WalkableError = { walk: (fn: (x: unknown) => boolean) => unknown };

function isWalkable(e: unknown): e is WalkableError {
  // `instanceof Error` is SAFE here where `instanceof BaseError` was not,
  // and the difference is the whole subtlety of this file. `Error` is a
  // realm intrinsic — every package in one Node process or one browser
  // window shares the single global — so it cannot be duplicated by pnpm
  // the way `viem`'s own classes are. It costs nothing and it keeps the
  // structural check from being pure duck-typing: without it, ANY object
  // carrying a `walk` method could be handed an arbitrary predicate and
  // answer for it. That mistake would point the DANGEROUS way — a
  // not-really-a-revert read as authoritative, clearing a live holder or
  // pruning a claimable side — which is the direction this rule is
  // deliberately asymmetric about.
  return e instanceof Error && typeof (e as unknown as WalkableError).walk === 'function';
}

/** The two viem error names that mean "the node executed the call and
 *  answered no". Matched by `name` rather than by constructor — see the
 *  module header. */
const REVERT_ERROR_NAMES = new Set([
  'ContractFunctionRevertedError',
  'ContractFunctionZeroDataError',
]);

function hasRevertName(x: unknown): boolean {
  return (
    typeof x === 'object' &&
    x !== null &&
    REVERT_ERROR_NAMES.has((x as { name?: unknown }).name as string)
  );
}

/** True when a failed read is a contract REVERT / empty-data (an
 *  authoritative "no") rather than a transport error. */
export function isRevert(e: unknown): boolean {
  return isWalkable(e) && e.walk(hasRevertName) !== null;
}
