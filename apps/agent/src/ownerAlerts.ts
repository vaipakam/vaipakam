/**
 * Owner alerts (#3721, #3434 part 1) — tell a vault owner, on the channels
 * they linked, about two things that move what they own:
 *
 *   - **A position-token approval** (#3721). The position token's own
 *     `Approval` (one token approved to an address) or `ApprovalForAll`
 *     (every token opened to an operator). Whoever holds the approval can
 *     move the position, and the position's payouts follow it. Sent to every
 *     owner with a linked channel: there is no setting, because a grant the
 *     owner did not make is exactly what this exists to catch.
 *   - **A vault outflow** (#3434). Every `VaultOutflow` from the owner's
 *     vault: what left, how much, to where, why, and the loan or offer it
 *     belongs to. Opt-in for every owner (`user_thresholds.
 *     notify_vault_outflow`), and ON BY DEFAULT for an owner whose protected
 *     mode is on — read from the latest `ProtectionApplied` the indexer
 *     recorded — while the owner has not chosen either way.
 *
 * WHERE THE EVENTS COME FROM. Both are read from the indexer's
 * `activity_events` (the shared database), which holds only blocks up to the
 * settled head, so an alert is never sent for a log a reorganisation later
 * removes. The indexer scans the PositionNFT beside the Diamond (#3205), so
 * the token's approvals are there too. One cursor per chain
 * (`owner_alert_cursor`, block and log index) walks the three event kinds in
 * chain order.
 *
 * WHAT THIS PASS DOES NOT PROMISE, stated rather than implied:
 *
 *   - **Delivered at most once, not at least once.** The cursor moves past
 *     an event once its sends were attempted, whatever the rails answered. A
 *     Telegram or Push failure is logged and that alert is not retried;
 *     retrying a rail that may already have delivered would send it twice,
 *     and the in-app inbox carries the approvals regardless.
 *   - **Not a history.** The first pass on a chain starts at the newest event
 *     the indexer holds, and an event older than {@link STALE_AFTER_SEC} when
 *     this pass reaches it (after an outage) is skipped with a log rather
 *     than announced as news.
 *   - **English only**, like the payment reminders, until the agent's alert
 *     copy is translated.
 *   - **Amounts in whole units only when the token says how.** The token's
 *     `decimals()` is read once per tick from a chain endpoint whose identity
 *     was verified; when it cannot be read (an NFT, a failed read, an
 *     endpoint that is not this chain) the amount is stated in the token's
 *     smallest unit and the message says so. No string the token supplies
 *     (a name or a symbol) is ever put in a message: a token can name itself
 *     anything, including a link.
 */
import { createPublicClient, formatUnits, http, type Address } from 'viem';
import { aggregateReads, MULTICALL3_ADDRESS } from '@vaipakam/lib/multicall';
import { isRpcIdentityVerified, verifyRpcChainIdentity } from '@vaipakam/lib/rpcIdentity';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import { sendPush } from '@vaipakam/push';
import type { Env } from './env';
import { getChainConfigs } from './env';
import { pushRailConfigOf } from './pushRail';
import { sendMessage } from './telegram';
import { stateStub } from './telegramState/object';

/** Outbound requests this pass may make in one tick, across every chain: D1
 *  statements, the Telegram state object, RPC reads and sends. Small on
 *  purpose — the payment reminders share the invocation's allowance. */
export const MAX_SUBREQUESTS_PER_TICK = 12;

/** Events read per chain per tick. */
export const EVENTS_PER_READ = 20;

/** An event this old when reached is not announced (see the header). */
export const STALE_AFTER_SEC = 24 * 60 * 60;

/** The event kinds this pass reads from `activity_events`. */
export const OWNER_ALERT_KINDS = ['Approval', 'ApprovalForAll', 'VaultOutflow'] as const;

/** Requests one chain needs before it can send anything: the cursor and
 *  events (one batch), the owners' settings (one batch), the chats, and the
 *  cursor write. */
const CHAIN_OPENING_REQUESTS = 4;

const ZERO = '0x0000000000000000000000000000000000000000';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The business reason of an outflow, by the contract's `OutflowReason` code
 * (`contracts/src/vault/VaultOutflowTypes.sol`). A code missing here is
 * stated as unknown with its number, never guessed.
 */
export const OUTFLOW_REASON_LABEL: Readonly<Record<number, string>> = {
  0: 'your own withdrawal',
  1: 'a protected-mode payout released after its wait',
  2: 'a protected-mode escape withdrawal',
  3: 'an offer cancelled or changed, its deposit returned',
  4: "a loan's principal sent to its borrower",
  5: 'a repayment to the lender side',
  6: 'a periodic interest settlement',
  7: 'collateral returned to the borrower side',
  8: 'a claim paid to the position holder',
  9: 'collateral moved to the lender on a default',
  10: 'a liquidation',
  11: 'a protocol fee',
  12: 'a reward to a liquidator, matcher or keeper',
  13: 'a swap through an exchange route',
  14: 'a loan or collateral sale',
  15: 'two positions merged',
  16: "a previous lender's interest claim",
  17: 'a backstop step',
  18: 'VPFI into the rewards recycle',
  19: 'surplus collateral withdrawn',
  20: 'a listing placed in its escrow',
  21: "a sanctioned party's share held in its lock",
  22: 'a rental settlement',
  23: 'a clawback to the recovery address',
  24: "a recovered account's balance moved to the recovery address",
  25: 'a standing instruction drawing on a loan reserve',
  26: "an integrator's share of the initiation fee",
  27: "an inviter's share of the initiation fee",
};

/** Reasons whose `ref` names a LOAN; `OFFER_REFUND` (3) names an offer. Any
 *  other non-zero `ref` is stated as "loan or offer". */
const LOAN_REF_REASONS = new Set([4, 5, 6, 7, 8, 9, 10, 14, 15, 16, 17, 19, 22, 25, 26, 27]);

export interface ActivityRow {
  block_number: number;
  log_index: number;
  kind: string;
  args_json: string;
  block_at: number;
}

/** One alert to one owner, ready to render. */
export type OwnerAlert =
  | { type: 'approved'; owner: string; tokenId: string; to: string }
  | { type: 'approvedAll'; owner: string; operator: string }
  | {
      type: 'outflow';
      owner: string;
      asset: string;
      tokenId: string;
      delivered: string;
      to: string;
      reason: number;
      ref: string;
    };

function addr(v: unknown): string | null {
  return typeof v === 'string' && ADDRESS_RE.test(v) && v.toLowerCase() !== ZERO ? v.toLowerCase() : null;
}

function whole(v: unknown): string | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  return typeof v === 'string' && /^[0-9]+$/.test(v) ? v : null;
}

/**
 * The alert an archived event carries, or null for one that warrants none (a
 * cleared approval, a revoked operator) or cannot be read. The archive's
 * writer stores bigints as decimal strings and addresses as hex.
 */
export function alertOf(row: ActivityRow): OwnerAlert | null {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(row.args_json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const owner = addr(args.owner);
  if (!owner) return null;
  if (row.kind === 'Approval') {
    const to = addr(args.approved);
    const tokenId = whole(args.tokenId);
    return to && tokenId ? { type: 'approved', owner, tokenId, to } : null;
  }
  if (row.kind === 'ApprovalForAll') {
    const operator = addr(args.operator);
    return operator && args.approved === true ? { type: 'approvedAll', owner, operator } : null;
  }
  if (row.kind === 'VaultOutflow') {
    const asset = addr(args.asset);
    const to = addr(args.to);
    const delivered = whole(args.delivered);
    const tokenId = whole(args.tokenId);
    const ref = whole(args.ref);
    const reason = typeof args.reason === 'number' ? args.reason : Number(whole(args.reason) ?? NaN);
    if (!asset || !to || delivered === null || tokenId === null || ref === null || !Number.isInteger(reason)) return null;
    return { type: 'outflow', owner, asset, tokenId, delivered, to, reason, ref };
  }
  return null;
}

/** An owner's settings, as far as this pass reads them. */
export interface OwnerSettings {
  /** The Push opt-in is stored. */
  push: boolean;
  /** `notify_vault_outflow`: 1 on, 0 off, null not chosen. */
  outflow: number | null;
  /** The latest recorded `ProtectionApplied` left protected mode on. */
  protected: boolean;
}

/** Whether `owner` gets this alert at all (before any rail is considered). */
export function wants(alert: OwnerAlert, s: OwnerSettings): boolean {
  if (alert.type !== 'outflow') return true;
  return s.outflow === 1 || (s.outflow === null && s.protected);
}

/** The amount, in whole units when the token's decimals are known. */
function amountText(a: Extract<OwnerAlert, { type: 'outflow' }>, decimals: number | undefined): string {
  if (a.tokenId !== '0') return `${a.delivered} of token #${a.tokenId} of the contract ${a.asset}`;
  if (decimals === undefined) {
    return `${a.delivered} of the token ${a.asset} (in the token's smallest unit; its decimals could not be read)`;
  }
  return `${formatUnits(BigInt(a.delivered), decimals)} of the token ${a.asset}`;
}

/** The reference line of an outflow. */
function refText(a: Extract<OwnerAlert, { type: 'outflow' }>): string {
  if (a.ref === '0') return '';
  if (a.reason === 3) return ` It belongs to offer #${a.ref}.`;
  if (LOAN_REF_REASONS.has(a.reason)) return ` It belongs to loan #${a.ref}.`;
  return ` It belongs to loan or offer #${a.ref}.`;
}

/** The message: a short title (Push) and the body (Telegram carries both). */
export function renderAlert(
  alert: OwnerAlert,
  chainName: string,
  decimals: ReadonlyMap<string, number>,
): { title: string; body: string } {
  if (alert.type === 'approved') {
    return {
      title: `Position token #${alert.tokenId} approved for transfer`,
      body:
        `Your position token #${alert.tokenId} on ${chainName} was approved for transfer to ${alert.to}. ` +
        `That address can move the position, and the position's payouts follow it. ` +
        `If you did not approve this, open the app now.`,
    };
  }
  if (alert.type === 'approvedAll') {
    return {
      title: 'All your position tokens were opened to an operator',
      body:
        `All of your position tokens on ${chainName} were opened to ${alert.operator}. ` +
        `That address can move any of them, and each position's payouts follow it. ` +
        `If you did not approve this, open the app now.`,
    };
  }
  const why = OUTFLOW_REASON_LABEL[alert.reason] ?? `a movement the app has no name for (reason code ${alert.reason})`;
  return {
    title: 'Something left your vault',
    body:
      `${amountText(alert, decimals.get(alert.asset))} left your vault on ${chainName} to ${alert.to}. ` +
      `Reason: ${why}.${refText(alert)}`,
  };
}

/** What one send of one alert achieved, for the tick's log line. */
interface SendTally {
  sent: number;
  failed: number;
}

/** The I/O this pass needs, so the core can be tested without a Worker. */
export interface OwnerAlertDeps {
  db: D1Database;
  /** The chat linked to each pair, or null; throws when unreadable. */
  chatsOf: (pairs: { wallet: string; chainId: number }[]) => Promise<(string | null)[]>;
  /** Null when this deployment has no Telegram bot. */
  sendTelegram: ((chat: string, text: string) => Promise<'accepted' | string>) | null;
  /** Null when this deployment cannot send Push. */
  sendPush: ((wallet: string, title: string, body: string, link: string) => Promise<'accepted' | 'failed' | 'not-requested'>) | null;
  /** The decimals of each ERC-20 asset, from a verified endpoint; assets it
   *  could not read are simply absent. `null` when no read was possible. */
  readDecimals: (assets: Address[]) => Promise<Map<string, number> | null>;
  /** True when `readDecimals` will spend a request on the endpoint's
   *  identity before it reads. */
  decimalsProbeCostsARequest: () => boolean;
  link: string;
}

export interface Budget {
  remaining: number;
}

/**
 * One chain's step: read the events past the cursor, send what each owner
 * wants on each rail they linked, and move the cursor past what was handled.
 * Returns what it sent.
 */
export async function runOwnerAlertsChain(
  deps: OwnerAlertDeps,
  chain: { id: number; name: string },
  budget: Budget,
  nowSec: number,
): Promise<SendTally> {
  const tally: SendTally = { sent: 0, failed: 0 };
  if (budget.remaining < CHAIN_OPENING_REQUESTS + 1) return tally;

  // The cursor and the events past it, in one batch (one request).
  budget.remaining -= 1;
  const kinds = OWNER_ALERT_KINDS.map(() => '?').join(', ');
  const [cursorRes, eventsRes, headRes] = await deps.db.batch([
    deps.db.prepare(`SELECT block_number, log_index FROM owner_alert_cursor WHERE chain_id = ?`).bind(chain.id),
    deps.db
      .prepare(
        `SELECT e.block_number, e.log_index, e.kind, e.args_json, e.block_at
           FROM activity_events e, owner_alert_cursor c
          WHERE c.chain_id = ? AND e.chain_id = c.chain_id AND e.kind IN (${kinds})
            AND (e.block_number > c.block_number OR (e.block_number = c.block_number AND e.log_index > c.log_index))
          ORDER BY e.block_number, e.log_index
          LIMIT ?`,
      )
      .bind(chain.id, ...OWNER_ALERT_KINDS, EVENTS_PER_READ),
    deps.db
      .prepare(
        `SELECT block_number, log_index FROM activity_events WHERE chain_id = ?
          ORDER BY block_number DESC, log_index DESC LIMIT 1`,
      )
      .bind(chain.id),
  ]);
  const cursor = (cursorRes!.results as { block_number: number; log_index: number }[])[0];
  if (!cursor) {
    // First pass on this chain: start at the newest event the indexer holds,
    // so the owners are not sent the chain's history as news.
    const head = (headRes!.results as { block_number: number; log_index: number }[])[0];
    budget.remaining -= 1;
    await writeCursor(deps.db, chain.id, head?.block_number ?? 0, head?.log_index ?? -1, nowSec);
    return tally;
  }
  const rows = eventsRes!.results as unknown as ActivityRow[];
  if (rows.length === 0) return tally;

  const planned = rows.map((r) => ({ row: r, alert: alertOf(r) }));
  const owners = [...new Set(planned.flatMap((p) => (p.alert ? [p.alert.owner] : [])))];
  let settings = new Map<string, OwnerSettings>();
  let chats: (string | null)[] = owners.map(() => null);
  let decimals = new Map<string, number>();
  if (owners.length > 0) {
    budget.remaining -= 1;
    settings = await readSettings(deps.db, chain.id, owners);
    if (deps.sendTelegram) {
      budget.remaining -= 1;
      try {
        chats = await deps.chatsOf(owners.map((wallet) => ({ wallet, chainId: chain.id })));
      } catch (err) {
        // A failed read is not "no chat": nothing is sent on Telegram this
        // tick for these owners, and the log says so.
        console.error(`[ownerAlerts] chain=${chain.name}: the chat lookup failed (${describeFailure(err)}); no Telegram this tick`);
      }
    }
    const assets = [
      ...new Set(
        planned.flatMap((p) =>
          p.alert?.type === 'outflow' && p.alert.tokenId === '0' && wants(p.alert, settingsOf(settings, p.alert.owner))
            ? [p.alert.asset as Address]
            : [],
        ),
      ),
    ];
    const readCost = 1 + (deps.decimalsProbeCostsARequest() ? 1 : 0);
    if (assets.length > 0 && budget.remaining >= readCost + 2) {
      budget.remaining -= readCost;
      decimals = (await deps.readDecimals(assets)) ?? new Map();
    }
  }
  const chatOf = new Map(owners.map((o, i) => [o, chats[i] ?? null]));

  // Walk the events in order; the cursor stops before the first one the
  // remaining allowance cannot carry (keeping one request for its write).
  let handled: ActivityRow | null = null;
  for (const { row, alert } of planned) {
    if (alert && row.block_at >= nowSec - STALE_AFTER_SEC) {
      const s = settingsOf(settings, alert.owner);
      if (wants(alert, s)) {
        const chat = deps.sendTelegram ? chatOf.get(alert.owner) ?? null : null;
        const push = deps.sendPush && s.push;
        const cost = (chat ? 1 : 0) + (push ? 1 : 0);
        if (budget.remaining - 1 < cost) break;
        const { title, body } = renderAlert(alert, chain.name, decimals);
        if (chat && deps.sendTelegram) {
          budget.remaining -= 1;
          const outcome = await deps.sendTelegram(chat, `${title}\n${body}\n${deps.link}`).catch(() => 'failed');
          if (outcome === 'accepted') tally.sent += 1;
          else tally.failed += 1;
        }
        if (push && deps.sendPush) {
          const outcome = await deps.sendPush(alert.owner, title, body, deps.link).catch(() => 'failed' as const);
          if (outcome !== 'not-requested') budget.remaining -= 1;
          if (outcome === 'accepted') tally.sent += 1;
          else if (outcome === 'failed') tally.failed += 1;
        }
      }
    } else if (alert) {
      console.warn(
        `[ownerAlerts] chain=${chain.name}: skipped a ${row.kind} at block ${row.block_number}, ` +
          `older than ${STALE_AFTER_SEC / 3600} hours when this pass reached it`,
      );
    }
    handled = row;
  }
  if (handled) {
    budget.remaining -= 1;
    await writeCursor(deps.db, chain.id, handled.block_number, handled.log_index, nowSec);
  }
  if (tally.failed > 0) {
    console.warn(`[ownerAlerts] chain=${chain.name}: ${tally.failed} send(s) not accepted; they are not retried`);
  }
  return tally;
}

function settingsOf(map: Map<string, OwnerSettings>, owner: string): OwnerSettings {
  return map.get(owner) ?? { push: false, outflow: null, protected: false };
}

async function writeCursor(db: D1Database, chainId: number, block: number, logIndex: number, nowSec: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO owner_alert_cursor (chain_id, block_number, log_index, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(chain_id) DO UPDATE SET block_number = excluded.block_number,
         log_index = excluded.log_index, updated_at = excluded.updated_at`,
    )
    .bind(chainId, block, logIndex, nowSec)
    .run();
}

/**
 * Each owner's Push opt-in and outflow choice, and whether their protected
 * mode is on (the latest `ProtectionApplied` naming them: enabled and not
 * retired), in one batch. The owner list is at most {@link EVENTS_PER_READ}
 * long, inside D1's bound-parameter cap.
 */
async function readSettings(db: D1Database, chainId: number, owners: string[]): Promise<Map<string, OwnerSettings>> {
  const marks = owners.map(() => '?').join(', ');
  const [thresholds, protection] = await db.batch([
    db
      .prepare(
        `SELECT wallet, push_channel, notify_vault_outflow FROM user_thresholds
          WHERE chain_id = ? AND wallet IN (${marks})`,
      )
      .bind(chainId, ...owners),
    db
      .prepare(
        `SELECT lower(json_extract(args_json, '$.account')) AS account, args_json
           FROM activity_events
          WHERE chain_id = ? AND kind = 'ProtectionApplied'
            AND lower(json_extract(args_json, '$.account')) IN (${marks})
          ORDER BY block_number DESC, log_index DESC`,
      )
      .bind(chainId, ...owners),
  ]);
  const out = new Map<string, OwnerSettings>();
  for (const o of owners) out.set(o, { push: false, outflow: null, protected: false });
  for (const r of thresholds!.results as { wallet: string; push_channel: string | null; notify_vault_outflow: number | null }[]) {
    const s = out.get(r.wallet.toLowerCase());
    if (!s) continue;
    s.push = Boolean(r.push_channel);
    s.outflow = r.notify_vault_outflow === 0 || r.notify_vault_outflow === 1 ? r.notify_vault_outflow : null;
  }
  const seen = new Set<string>();
  for (const r of protection!.results as { account: string; args_json: string }[]) {
    if (seen.has(r.account)) continue; // newest first: the first row is the state
    seen.add(r.account);
    const s = out.get(r.account);
    if (!s) continue;
    try {
      const a = JSON.parse(r.args_json) as { enabled?: unknown; retired?: unknown };
      s.protected = a.enabled === true && a.retired !== true;
    } catch {
      // unreadable → not known to be protected; the owner's own choice still applies
    }
  }
  return out;
}

const DECIMALS_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

/** The Worker's wiring: one pass over every chain, rotating nothing — each
 *  chain's step is small and the chains are few. */
export async function runOwnerAlerts(env: Env): Promise<void> {
  const chains = getChainConfigs(env).filter((c) => c.diamond && c.diamond !== ZERO);
  if (chains.length === 0) return;
  const budget: Budget = { remaining: MAX_SUBREQUESTS_PER_TICK };
  const nowSec = Math.floor(Date.now() / 1000);
  const link = env.FRONTEND_ORIGIN.split(',')[0]!.trim();
  const token = env.TG_BOT_TOKEN;
  const pushSigner = env.PUSH_CHANNEL_PK;
  const pushRail = pushRailConfigOf(env);
  for (const chain of chains) {
    const client = createPublicClient({ transport: http(chain.rpc, { retryCount: 0, timeout: 5_000 }) });
    const deps: OwnerAlertDeps = {
      db: env.DB,
      chatsOf: (pairs) => stateStub(env).chatsOf(pairs),
      sendTelegram: token ? (chat, text) => sendMessage(token, chat, text) : null,
      sendPush: pushSigner
        ? (subscriber, title, body, deepLinkUrl) =>
            sendPush({ ...pushRail, channelPk: pushSigner }, { subscriber, title, body, deepLinkUrl })
        : null,
      decimalsProbeCostsARequest: () => !isRpcIdentityVerified(chain.id, chain.rpc),
      readDecimals: async (assets) => {
        const identity = await verifyRpcChainIdentity(client, chain.id, chain.rpc, 'ownerAlerts');
        if (!identity.ok) return null;
        try {
          const slots = await aggregateReads(
            client,
            MULTICALL3_ADDRESS,
            assets.map((a) => ({ address: a, abi: DECIMALS_ABI, functionName: 'decimals' })),
          );
          const out = new Map<string, number>();
          slots.forEach((s, i) => {
            if (s.status === 'success' && typeof s.result === 'number' && s.result <= 36) {
              out.set(assets[i]!.toLowerCase(), s.result);
            }
          });
          return out;
        } catch {
          return null;
        }
      },
      link,
    };
    try {
      await runOwnerAlertsChain(deps, chain, budget, nowSec);
    } catch (err) {
      console.error(`[ownerAlerts] chain=${chain.name} failed: ${describeFailure(err)}`);
    }
  }
}

