/**
 * #3727 — the referral record behind the inviter's page
 * (ReferralFeeShareDesign.md section 6.1).
 *
 * Two Diamond events, and nothing else, feed it:
 *  - `InviterBound(newUser, inviter, endsAt)` — a wallet bound an inviter,
 *    once, with the end time the contract fixed for that wallet;
 *  - `ReferralShareSettled(loanId, newUser, inviter, asset, offerId, cut,
 *    share, outcome)` — a loan whose cut or share was above zero, and where
 *    the share went.
 *
 * The page reads what these events state. It never infers a wallet's end
 * time from the current period setting, never gives a redirect a reason the
 * event did not give, and never totals different assets into one figure.
 * It adds no contract state: the list of invited wallets lives here.
 */
import type { Env } from './env';

export const REFERRAL_EVENT_NAMES = ['InviterBound', 'ReferralShareSettled'] as const;

/**
 * Where an inviter's share went, by the contract's `LibReferral.Outcome`
 * (append-only enum: Paid = 0, NoShare = 1, InviterFlagged = 2,
 * PaymentFailed = 3, DeliveredShort = 4).
 */
export const REFERRAL_OUTCOMES = [
  'paid',
  'no-share',
  'inviter-flagged',
  'payment-failed',
  'delivered-short',
] as const;
export type ReferralOutcome = (typeof REFERRAL_OUTCOMES)[number];

/** The outcomes that sent a share to the reserve instead of the inviter. */
export const REDIRECT_OUTCOMES: readonly ReferralOutcome[] = [
  'inviter-flagged',
  'payment-failed',
  'delivered-short',
];

export interface ReferralLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
}

const addr = (v: unknown): string => String(v).toLowerCase();
const dec = (v: unknown): string => BigInt(v as bigint | number | string).toString();

function bindingStatement(
  db: D1Database,
  chainId: number,
  log: ReferralLog,
  blockAt: number,
): D1PreparedStatement {
  const a = log.args;
  // INSERT OR IGNORE: a wallet binds once (the contract refuses a second),
  // and a replay of the same log changes nothing.
  return db
    .prepare(
      `INSERT OR IGNORE INTO referral_binding
         (chain_id, new_user, inviter, ends_at, block_number, log_index, tx_hash, bound_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      chainId,
      addr(a.newUser),
      addr(a.inviter),
      Number(a.endsAt),
      Number(log.blockNumber),
      Number(log.logIndex),
      log.transactionHash,
      blockAt,
    );
}

function shareStatement(
  db: D1Database,
  chainId: number,
  log: ReferralLog,
  blockAt: number,
): D1PreparedStatement | null {
  const a = log.args;
  const outcome = Number(a.outcome);
  // An outcome this build does not know is not guessed at: the row is
  // skipped and the scan says so, rather than recorded under a wrong reason.
  if (!Number.isInteger(outcome) || outcome < 0 || outcome >= REFERRAL_OUTCOMES.length) {
    console.warn('[referralRecord] unknown outcome; row skipped', { chainId, outcome });
    return null;
  }
  return db
    .prepare(
      `INSERT OR IGNORE INTO referral_share
         (chain_id, block_number, log_index, tx_hash, loan_id, offer_id, new_user, inviter,
          asset, cut, share, outcome, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      chainId,
      Number(log.blockNumber),
      Number(log.logIndex),
      log.transactionHash,
      dec(a.loanId),
      dec(a.offerId),
      addr(a.newUser),
      addr(a.inviter),
      addr(a.asset),
      dec(a.cut),
      dec(a.share),
      outcome,
      blockAt,
    );
}

/** Record one block's referral events. Returns the rows written. */
export async function recordReferralLogs(
  db: D1Database,
  chainId: number,
  logs: readonly ReferralLog[],
  blockTimes: ReadonlyMap<bigint, number>,
): Promise<number> {
  const statements: D1PreparedStatement[] = [];
  for (const log of logs) {
    if (!(REFERRAL_EVENT_NAMES as readonly string[]).includes(log.eventName)) continue;
    const blockAt = blockTimes.get(log.blockNumber);
    if (blockAt === undefined) throw new Error(`recordReferralLogs: no chain time for block ${log.blockNumber}`);
    const st =
      log.eventName === 'InviterBound'
        ? bindingStatement(db, chainId, log, blockAt)
        : shareStatement(db, chainId, log, blockAt);
    if (st) statements.push(st);
  }
  if (statements.length > 0) await db.batch(statements);
  return statements.length;
}

// ─── The inviter's page ──────────────────────────────────────────────────

/** Rows read per list. Past it the answer says it is truncated. */
export const REFERRAL_LIST_LIMIT = 500;
/** Paid rows summed per asset. Past it the totals are withheld, not guessed. */
export const REFERRAL_TOTAL_SCAN_LIMIT = 10_000;

export interface InvitedWalletJson {
  wallet: string;
  boundAt: number;
  boundTx: string;
  /** As the binding event states it. Whether it has passed is the reader's
   *  comparison with chain time, not the indexer's clock. */
  endsAt: number;
  /** Loans of this wallet whose share was above zero, wherever it went. */
  loansWithShare: number;
}

export interface ShareRowJson {
  loanId: string;
  offerId: string;
  newUser: string;
  asset: string;
  share: string;
  outcome: ReferralOutcome;
  blockNumber: number;
  txHash: string;
  settledAt: number;
}

export interface InviterReferralsJson {
  chainId: number;
  inviter: string;
  /** The block the indexer has read the Diamond through; the figures are
   *  current to it. Null when the indexer has not started on this chain. */
  indexedThroughBlock: number | null;
  invited: { rows: InvitedWalletJson[]; truncated: boolean };
  received: {
    rows: ShareRowJson[];
    truncated: boolean;
    /** Per asset, never across assets. Null when there were too many rows
     *  to sum in one read; the page then shows the rows without a total. */
    totals: { asset: string; amount: string }[] | null;
  };
  sentToReserve: { rows: ShareRowJson[]; truncated: boolean };
}

interface ShareRow {
  loan_id: string;
  offer_id: string;
  new_user: string;
  asset: string;
  share: string;
  outcome: number;
  block_number: number;
  tx_hash: string;
  settled_at: number;
}

const toShareJson = (r: ShareRow): ShareRowJson => ({
  loanId: r.loan_id,
  offerId: r.offer_id,
  newUser: r.new_user,
  asset: r.asset,
  share: r.share,
  outcome: REFERRAL_OUTCOMES[r.outcome],
  blockNumber: r.block_number,
  txHash: r.tx_hash,
  settledAt: r.settled_at,
});

/** Sum decimal-string amounts per asset, exactly. Pure; tested on its own. */
export function totalsPerAsset(rows: readonly { asset: string; share: string }[]): { asset: string; amount: string }[] {
  const sums = new Map<string, bigint>();
  for (const r of rows) sums.set(r.asset, (sums.get(r.asset) ?? 0n) + BigInt(r.share));
  return [...sums.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([asset, amount]) => ({ asset, amount: amount.toString() }));
}

export async function inviterReferrals(
  env: Env,
  chainId: number,
  inviterAddress: string,
  cursorKind: string,
): Promise<InviterReferralsJson> {
  const inviter = inviterAddress.toLowerCase();
  const limit = REFERRAL_LIST_LIMIT + 1;
  const redirect = REDIRECT_OUTCOMES.map((o) => REFERRAL_OUTCOMES.indexOf(o));
  const [cursor, invited, received, redirected, paidForTotals] = await env.DB.batch<unknown>([
    env.DB.prepare(`SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND kind = ?`).bind(chainId, cursorKind),
    env.DB.prepare(
      `SELECT b.new_user, b.bound_at, b.tx_hash, b.ends_at,
              (SELECT COUNT(*) FROM referral_share s
                WHERE s.chain_id = b.chain_id AND s.new_user = b.new_user
                  AND s.inviter = b.inviter AND s.share != '0') AS loans_with_share
         FROM referral_binding b
        WHERE b.chain_id = ? AND b.inviter = ?
        ORDER BY b.block_number DESC, b.log_index DESC
        LIMIT ?`,
    ).bind(chainId, inviter, limit),
    env.DB.prepare(
      `SELECT loan_id, offer_id, new_user, asset, share, outcome, block_number, tx_hash, settled_at
         FROM referral_share
        WHERE chain_id = ? AND inviter = ? AND outcome = 0
        ORDER BY block_number DESC, log_index DESC
        LIMIT ?`,
    ).bind(chainId, inviter, limit),
    env.DB.prepare(
      `SELECT loan_id, offer_id, new_user, asset, share, outcome, block_number, tx_hash, settled_at
         FROM referral_share
        WHERE chain_id = ? AND inviter = ? AND outcome IN (?, ?, ?) AND share != '0'
        ORDER BY block_number DESC, log_index DESC
        LIMIT ?`,
    ).bind(chainId, inviter, redirect[0], redirect[1], redirect[2], limit),
    env.DB.prepare(
      `SELECT asset, share FROM referral_share
        WHERE chain_id = ? AND inviter = ? AND outcome = 0
        LIMIT ?`,
    ).bind(chainId, inviter, REFERRAL_TOTAL_SCAN_LIMIT + 1),
  ]);

  const cursorRow = (cursor.results as { last_block: number }[])[0];
  const invitedRows = invited.results as {
    new_user: string;
    bound_at: number;
    tx_hash: string;
    ends_at: number;
    loans_with_share: number;
  }[];
  const receivedRows = received.results as ShareRow[];
  const redirectRows = redirected.results as ShareRow[];
  const paidRows = paidForTotals.results as { asset: string; share: string }[];

  return {
    chainId,
    inviter,
    indexedThroughBlock: cursorRow ? Number(cursorRow.last_block) : null,
    invited: {
      rows: invitedRows.slice(0, REFERRAL_LIST_LIMIT).map((r) => ({
        wallet: r.new_user,
        boundAt: r.bound_at,
        boundTx: r.tx_hash,
        endsAt: r.ends_at,
        loansWithShare: Number(r.loans_with_share),
      })),
      truncated: invitedRows.length > REFERRAL_LIST_LIMIT,
    },
    received: {
      rows: receivedRows.slice(0, REFERRAL_LIST_LIMIT).map(toShareJson),
      truncated: receivedRows.length > REFERRAL_LIST_LIMIT,
      totals: paidRows.length > REFERRAL_TOTAL_SCAN_LIMIT ? null : totalsPerAsset(paidRows),
    },
    sentToReserve: {
      rows: redirectRows.slice(0, REFERRAL_LIST_LIMIT).map(toShareJson),
      truncated: redirectRows.length > REFERRAL_LIST_LIMIT,
    },
  };
}
