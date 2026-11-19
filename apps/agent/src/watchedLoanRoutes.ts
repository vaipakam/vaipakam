/**
 * #3769 — the routes a wallet watches loans it does not hold through
 * (FeaturesOverExistingPartsDesign.md §9).
 *
 *   POST /watch/loans/add      watch one loan       (signed, names the loan)
 *   POST /watch/loans/remove   stop watching one    (signed, names the loan)
 *   POST /watch/loans/list     the wallet's watches (signed: the list is private)
 *
 * Body: `{ wallet, chain_id, issuedAt, signature, loanId? }`, signed over the
 * messages in `@vaipakam/lib/watchedLoans`. Every request is verified and then
 * claimed once in the one-time-use ledger (`authoriseAlertRequest`), like
 * every other signed alert request.
 *
 * WHAT A WATCH IS FOR. A loan's data is public, so following it needs no
 * consent from its holders. The alerts it brings go to the Telegram chat the
 * wallet linked on that chain and say, every time, that the wallet holds no
 * position. A wallet that holds a side of the loan already gets its own
 * alerts, so it is refused here rather than told something untrue.
 *
 * LIMITS (§13 item 4). At most `WATCH_MAX_LOANS_PER_WALLET` watched loans per
 * wallet across chains, and at most `WATCH_MAX_CHANGES_PER_DAY` adds and
 * removes a day, both checked inside the state object together with the
 * write. Watching a loan already watched spends nothing.
 */
import {
  WATCH_DEFAULT_MAX_CHANGES_PER_DAY,
  WATCH_DEFAULT_MAX_LOANS_PER_WALLET,
} from '@vaipakam/lib/watchedLoans';
import {
  parseSignedLinkRequest,
  type AlertAuthorisation,
  type LinkVerifyResult,
  type SignedLinkRequest,
} from './linkAuth';
import type { ChainDeployment } from './telegramState/store';
import type { WatchAddOutcome, WatchedLoan, WatchLimits, WatchRemoveOutcome } from './telegramState/watches';

export const WATCH_PATHS = ['/watch/loans/add', '/watch/loans/remove', '/watch/loans/list'] as const;
export type WatchPath = (typeof WATCH_PATHS)[number];

export function isWatchPath(path: string): path is WatchPath {
  return (WATCH_PATHS as readonly string[]).includes(path);
}

/** The state object's watch methods. */
export interface WatchStatePort {
  watchLoan(dep: ChainDeployment, wallet: string, loanId: number, now: number, limits: WatchLimits): Promise<WatchAddOutcome> | WatchAddOutcome;
  unwatchLoan(dep: ChainDeployment, wallet: string, loanId: number, now: number, limits: WatchLimits): Promise<WatchRemoveOutcome> | WatchRemoveOutcome;
  watchedLoans(wallet: string, deps: ChainDeployment[]): Promise<WatchedLoan[]> | WatchedLoan[];
  chatsOf(pairs: { wallet: string; chainId: number }[]): Promise<(string | null)[]> | (string | null)[];
}

/** The indexed loan a watch is checked against. */
export interface LoanView {
  status: string;
  lenderHolder: string;
  borrowerHolder: string;
}

export interface WatchRouteDeps {
  state: WatchStatePort;
  /** The loan as the indexer recorded it, or null. Throws when unreadable. */
  loanOf: (chainId: number, loanId: number) => Promise<LoanView | null>;
  /** Verify the signature and claim it once. */
  authorise: (req: SignedLinkRequest, auth: AlertAuthorisation) => Promise<LinkVerifyResult>;
  /** This agent's deployment per chain: the chains it can watch on. */
  deployments: () => ChainDeployment[];
  limits: WatchLimits;
  now: () => number;
}

export interface WatchAnswer {
  status: number;
  body: Record<string, unknown>;
}

const MAX_LOAN_ID = Number.MAX_SAFE_INTEGER;

/** Parse a positive whole-number limit from a wrangler var. */
function limitOf(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : fallback;
}

/** The limits from this agent's configuration, with the owner's defaults. */
export function watchLimitsOf(env: { WATCH_MAX_LOANS_PER_WALLET?: string; WATCH_MAX_CHANGES_PER_DAY?: string }): WatchLimits {
  return {
    maxLoansPerWallet: limitOf(env.WATCH_MAX_LOANS_PER_WALLET, WATCH_DEFAULT_MAX_LOANS_PER_WALLET),
    maxChangesPerDay: limitOf(env.WATCH_MAX_CHANGES_PER_DAY, WATCH_DEFAULT_MAX_CHANGES_PER_DAY),
  };
}

const refused = (status: number, error: string, extra: Record<string, unknown> = {}): WatchAnswer => ({
  status,
  body: { error, ...extra },
});

function verifyRefusal(v: Extract<LinkVerifyResult, { ok: false }>): WatchAnswer {
  const error = v.status === 409 ? 'request-already-used' : v.status === 503 ? 'verification-unavailable' : 'verification_failed';
  return refused(v.status, error, { reason: v.reason });
}

/** Answer one watch route. */
export async function handleWatchRoute(path: WatchPath, body: unknown, d: WatchRouteDeps): Promise<WatchAnswer> {
  const parsed = parseSignedLinkRequest(body);
  if (!parsed.ok) return refused(400, 'invalid-payload', { reason: parsed.reason });
  const req = parsed.req;

  if (path === '/watch/loans/list') {
    const v = await d.authorise(req, 'list-watched');
    if (!v.ok) return verifyRefusal(v);
    const loans = await d.state.watchedLoans(req.wallet, d.deployments());
    return { status: 200, body: { loans, limits: d.limits } };
  }

  const loanId = (body as Record<string, unknown>).loanId;
  if (!Number.isInteger(loanId) || (loanId as number) < 1 || (loanId as number) > MAX_LOAN_ID) {
    return refused(400, 'invalid-payload', { reason: 'loanId must be a positive whole number' });
  }
  const id = loanId as number;
  const dep = d.deployments().find((x) => x.chainId === req.chain_id);
  if (!dep) return refused(400, 'chain-not-served');

  if (path === '/watch/loans/remove') {
    const v = await d.authorise(req, { action: 'unwatch-loan', loanId: id });
    if (!v.ok) return verifyRefusal(v);
    const out = await d.state.unwatchLoan(dep, req.wallet, id, d.now(), d.limits);
    if (out === 'removed') return { status: 200, body: { ok: true, watching: false } };
    if (out === 'not-watching') return refused(404, 'not-watching');
    return refused(429, 'changes-spent', { limit: d.limits.maxChangesPerDay });
  }

  // Add. The loan is checked BEFORE the signature is claimed: what is checked
  // is public, and a refusal here should not cost the wallet its signature.
  let loan: LoanView | null;
  try {
    loan = await d.loanOf(req.chain_id, id);
  } catch {
    return refused(503, 'loan-unreadable', { reason: 'could not read the loan; nothing was changed, try again shortly' });
  }
  if (!loan) return refused(404, 'loan-not-found');
  if (loan.status !== 'active') return refused(409, 'loan-not-active', { status: loan.status });
  const wallet = req.wallet.toLowerCase();
  if (wallet === loan.lenderHolder.toLowerCase() || wallet === loan.borrowerHolder.toLowerCase()) {
    return refused(409, 'wallet-holds-a-position', {
      reason: 'this wallet holds a side of the loan and already gets alerts for it as a holder',
    });
  }
  const v = await d.authorise(req, { action: 'watch-loan', loanId: id });
  if (!v.ok) return verifyRefusal(v);
  const out = await d.state.watchLoan(dep, req.wallet, id, d.now(), d.limits);
  if (out === 'too-many-loans') return refused(409, 'too-many-loans', { limit: d.limits.maxLoansPerWallet });
  if (out === 'changes-spent') return refused(429, 'changes-spent', { limit: d.limits.maxChangesPerDay });
  // Alerts reach the chat linked on this chain; say whether there is one, so
  // the app can offer to link instead of implying alerts will arrive.
  const [chat] = await d.state.chatsOf([{ wallet: req.wallet, chainId: req.chain_id }]);
  return {
    status: 200,
    body: { ok: true, watching: true, already: out === 'already-watching', telegramLinked: chat != null },
  };
}

/** The statement {@link d1LoanOf} runs; exported so a test runs it on the
 *  migrated schema. */
export const LOAN_BY_ID_SQL =
  'SELECT status, lender_current_owner, borrower_current_owner FROM loans WHERE chain_id = ? AND loan_id = ?';

/** The indexed loan, from the shared database's `loans` projection. */
export async function d1LoanOf(db: D1Database, chainId: number, loanId: number): Promise<LoanView | null> {
  const row = await db
    .prepare(LOAN_BY_ID_SQL)
    .bind(chainId, loanId)
    .first<{ status: string; lender_current_owner: string; borrower_current_owner: string }>();
  return row
    ? { status: row.status, lenderHolder: row.lender_current_owner, borrowerHolder: row.borrower_current_owner }
    : null;
}
