/**
 * Alerts for a loan the wallet does not hold (#3769,
 * FeaturesOverExistingPartsDesign.md §9): what the app signs, where it sends
 * it, and how it reads each answer. Pure, so every outcome is tested.
 *
 * The messages come from `@vaipakam/lib/watchedLoans`, the one source the
 * alert service rebuilds them from, so the wallet prompt and the text the
 * service checks cannot differ. Each names the loan, so a signature to
 * watch one loan cannot watch another, and the service accepts it once.
 *
 * The service keeps the watch list and does not show it without a signed
 * request, so the page states what THIS browser did ({@link KnownWatch}) and
 * says a watch set elsewhere may exist.
 */
import { buildListWatchedLoansMessage, buildUnwatchLoanMessage, buildWatchLoanMessage } from '@vaipakam/lib/watchedLoans';

type Hex = `0x${string}`;

export type WatchAction = { kind: 'watch'; loanId: bigint } | { kind: 'unwatch'; loanId: bigint } | { kind: 'list' };

/** The service takes loan ids as JSON numbers, so a larger id cannot be
 *  watched; the page says so instead of sending a request it would refuse. */
export const MAX_WATCH_LOAN_ID = 2n ** 53n - 1n;

export function watchable(loanId: bigint): boolean {
  return loanId >= 1n && loanId <= MAX_WATCH_LOAN_ID;
}

/** The exact message the wallet signs. */
export function watchMessage(action: WatchAction, wallet: Hex, chainId: number, issuedAt: number): string {
  if (action.kind === 'list') return buildListWatchedLoansMessage(wallet, chainId, issuedAt);
  const id = Number(action.loanId);
  return action.kind === 'watch' ? buildWatchLoanMessage(wallet, chainId, id, issuedAt) : buildUnwatchLoanMessage(wallet, chainId, id, issuedAt);
}

export function watchPath(action: WatchAction): string {
  return action.kind === 'watch' ? '/watch/loans/add' : action.kind === 'unwatch' ? '/watch/loans/remove' : '/watch/loans/list';
}

export function watchBody(action: WatchAction, wallet: Hex, chainId: number, issuedAt: number, signature: Hex): Record<string, unknown> {
  const signed = { wallet, chain_id: chainId, issuedAt, signature };
  return action.kind === 'list' ? signed : { ...signed, loanId: Number(action.loanId) };
}

/** Why the service did not do what was asked, each with its own words. */
export type WatchProblem =
  /** The signed request was already accepted once: sign again. */
  | 'used'
  /** The signature did not prove the wallet, or the request was too old. */
  | 'refused'
  /** The service could not check a smart account's signature right now. */
  | 'verify-down'
  /** The service does not watch loans on this network. */
  | 'chain-not-served'
  /** The service could not read the loan: nothing changed, try shortly. */
  | 'loan-unreadable'
  | 'loan-not-found'
  /** The loan is no longer active, so there is nothing to watch. */
  | 'loan-not-active'
  /** The wallet holds a side and gets a holder's alerts already. */
  | 'holds-a-position'
  | 'too-many-loans'
  | 'changes-spent'
  /** A stop for a loan the service has no watch on. */
  | 'not-watching'
  | 'other';

export interface WatchedEntry {
  chainId: number;
  loanId: bigint;
  watchedAt: number;
}

export type WatchAnswer =
  | { ok: true; kind: 'watch'; already: boolean; telegramLinked: boolean }
  | { ok: true; kind: 'unwatch' }
  | { ok: true; kind: 'list'; loans: WatchedEntry[]; maxLoans: number | null }
  | { ok: false; problem: WatchProblem; status: number; limit: number | null };

function posInt(x: unknown): x is number {
  return Number.isSafeInteger(x) && (x as number) > 0;
}

function parseEntry(v: unknown): WatchedEntry | null {
  if (!v || typeof v !== 'object') return null;
  const { chainId, loanId, watchedAt } = v as Record<string, unknown>;
  if (!posInt(chainId) || !posInt(loanId) || !posInt(watchedAt)) return null;
  return { chainId, loanId: BigInt(loanId), watchedAt };
}

/** Read the service's answer. A 2xx whose body is not the action's shape is
 *  `other`: the page never reports a watch it cannot substantiate. */
export function readWatchAnswer(action: WatchAction, status: number, data: Record<string, unknown> | null): WatchAnswer {
  const error = typeof data?.error === 'string' ? data.error : null;
  const limit = posInt(data?.limit) ? (data.limit as number) : null;
  const fail = (problem: WatchProblem): WatchAnswer => ({ ok: false, problem, status, limit });
  if (status >= 200 && status < 300 && data) {
    if (action.kind === 'watch' && data.ok === true && data.watching === true && typeof data.telegramLinked === 'boolean') {
      return { ok: true, kind: 'watch', already: data.already === true, telegramLinked: data.telegramLinked };
    }
    if (action.kind === 'unwatch' && data.ok === true && data.watching === false) return { ok: true, kind: 'unwatch' };
    if (action.kind === 'list' && Array.isArray(data.loans)) {
      const loans = data.loans.map(parseEntry);
      if (loans.some((l) => l === null)) return fail('other');
      const lim = data.limits as Record<string, unknown> | undefined;
      return { ok: true, kind: 'list', loans: loans as WatchedEntry[], maxLoans: posInt(lim?.maxLoansPerWallet) ? (lim.maxLoansPerWallet as number) : null };
    }
    return fail('other');
  }
  if (status === 409 && error === 'request-already-used') return fail('used');
  if (status === 503 && error === 'verification-unavailable') return fail('verify-down');
  if (status === 503 && error === 'loan-unreadable') return fail('loan-unreadable');
  if (status === 400 && error === 'chain-not-served') return fail('chain-not-served');
  if (status === 404 && error === 'loan-not-found') return fail('loan-not-found');
  if (status === 404 && error === 'not-watching') return fail('not-watching');
  if (status === 409 && error === 'loan-not-active') return fail('loan-not-active');
  if (status === 409 && error === 'wallet-holds-a-position') return fail('holds-a-position');
  if (status === 409 && error === 'too-many-loans') return fail('too-many-loans');
  if (status === 429 && error === 'changes-spent') return fail('changes-spent');
  if (status === 401 || (status === 400 && (error === 'invalid-payload' || error === 'verification_failed'))) return fail('refused');
  return fail('other');
}

// ─── What this browser did ─────────────────────────────────────────

/** This browser's last answer about one loan's watch. */
export type KnownWatch = { state: 'watching' | 'stopped'; at: number };

const PREFIX = 'alpha05.watch.v1';

function key(chainId: number, wallet: Hex, loanId: bigint): string {
  return `${PREFIX}:${chainId}:${wallet.toLowerCase()}:${loanId}`;
}

type Store = Pick<Storage, 'getItem' | 'setItem'> | null;

function browserStore(): Store {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function parseKnownWatch(raw: unknown): KnownWatch | null {
  if (!raw || typeof raw !== 'object') return null;
  const { state, at } = raw as Record<string, unknown>;
  return (state === 'watching' || state === 'stopped') && posInt(at) ? { state, at } : null;
}

export function readKnownWatch(chainId: number, wallet: Hex, loanId: bigint, store: Store = browserStore()): KnownWatch | null {
  try {
    const raw = store?.getItem(key(chainId, wallet, loanId));
    return raw ? parseKnownWatch(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Record what an answer established. A `not-watching` refusal to a stop
 *  also establishes that nothing is watched; any other refusal changes
 *  nothing this browser knows. */
export function knownAfter(action: WatchAction, answer: WatchAnswer, at: number): KnownWatch | null {
  if (answer.ok && answer.kind === 'watch') return { state: 'watching', at };
  if (answer.ok && answer.kind === 'unwatch') return { state: 'stopped', at };
  if (!answer.ok && action.kind === 'unwatch' && answer.problem === 'not-watching') return { state: 'stopped', at };
  if (!answer.ok && action.kind === 'watch' && (answer.problem === 'loan-not-active' || answer.problem === 'holds-a-position')) return { state: 'stopped', at };
  return null;
}

export function writeKnownWatch(chainId: number, wallet: Hex, loanId: bigint, known: KnownWatch, store: Store = browserStore()): void {
  try {
    store?.setItem(key(chainId, wallet, loanId), JSON.stringify(known));
  } catch {
    // Storage that cannot be written leaves nothing remembered.
  }
}
