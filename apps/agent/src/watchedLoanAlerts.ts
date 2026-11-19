/**
 * #3769 — the alert pass for loans a wallet watches without holding them
 * (FeaturesOverExistingPartsDesign.md §9; the routes are in
 * `watchedLoanRoutes.ts`).
 *
 * For each chain this agent serves it takes the watches least recently
 * checked, reads their loans from the shared `loans` projection and, for the
 * active ones, the health level and due dates from the chain in ONE
 * Multicall3 read, then tells each watching wallet's linked Telegram chat:
 *
 *   - the health level fell into a worse band (the app's default bands; a
 *     recovery is recorded without a message, so a level moving around a
 *     line does not repeat itself);
 *   - the loan's final due date is within three days, or has passed (once per
 *     due date: a due date moved by a protocol pause is told again);
 *   - the loan was repaid, or closed any other way. The watch then ends.
 *
 * Every message says the wallet is watching and holds no position (§12
 * test 8). A wallet that has since come to hold a side of the loan gets its
 * own holder alerts, so the pass sends it nothing here rather than a sentence
 * that is no longer true.
 *
 * WHAT IT DOES NOT COVER, stated rather than implied: periodic interest
 * checkpoints (only the final due date), a partial repayment, and alerts in
 * any language but English. And a wallet with no Telegram chat linked on the
 * loan's chain is told nothing; the add route says so when the watch is made.
 *
 * ITS OWN INVOCATION. The pass runs on minute 2 of each five-minute window
 * (`WATCH_TICK_OFFSET`), never on the main tick's minute 0, so the
 * pre-notify lane's subrequest allowance and this one never share an
 * invocation. Its own allowance is {@link WATCH_LANE_MAX_SUBREQUESTS}, and
 * every outbound call (state object, D1, RPC, Telegram) counts against it.
 *
 * DELIVERY. A message Telegram refused for now, or did not answer, is not
 * recorded as told: the band, the due date or the ending is decided again on
 * the next run and sent again. A refusal for good is recorded as told, so a
 * blocked bot does not retry forever.
 */
import { createPublicClient, http, type Abi, type Address } from 'viem';
import { LoanClockFacetABI, RiskFacetABI } from '@vaipakam/contracts/abis';
import { aggregateReads, MULTICALL3_ADDRESS } from '@vaipakam/lib/multicall';
import { isRpcIdentityVerified, verifyRpcChainIdentity } from '@vaipakam/lib/rpcIdentity';
import {
  WATCH_BAND_RANK,
  WATCH_DUE_NOTICE_SECONDS,
  watchAlertText,
  watchBandOf,
  type WatchBand,
  type WatchEvent,
} from '@vaipakam/lib/watchedLoans';
import type { TelegramOutcome } from './telegram';
import type { ChainDeployment } from './telegramState/store';
import type { WatchRow, WatchUpdate } from './telegramState/watches';
import type { LoanView } from './watchedLoanRoutes';

/** Every outbound call one run may make. */
export const WATCH_LANE_MAX_SUBREQUESTS = 40;
/** Most watches checked per chain per run. */
export const WATCH_BATCH = 25;
/** The cadence and the minute within it this pass runs on. */
export const WATCH_TICK_CADENCE_MINUTES = 5;
export const WATCH_TICK_OFFSET = 2;
/** The calls a chain costs before any message: due watches, loans, the
 *  chain read (plus an identity probe when not yet verified), chats and the
 *  record. */
const CHAIN_FIXED_SUBREQUESTS = 5;

/** What the chain says about one active loan. `hf` is null when the loan has
 *  no health level (an NFT side, a missing price); `maturity` is 0 when the
 *  due dates could not be read. */
export interface LoanReading {
  hf: number | null;
  maturity: number;
  graceEnd: number;
}

/** One message to send, and what to record once it is delivered. */
export interface WatchDecision {
  events: WatchEvent[];
  /** Recorded whatever happens to the messages (the check itself). */
  base: WatchUpdate;
  /** Recorded only when every message was delivered or refused for good. */
  onTold: WatchUpdate;
}

/**
 * Decide one watch. Pure, so the rules are tested without a chain.
 * `reading` is undefined when the chain could not be read this run.
 */
export function decideWatch(
  row: WatchRow,
  loan: LoanView | undefined,
  reading: LoanReading | undefined,
  now: number,
): WatchDecision {
  const key = { wallet: row.wallet, loanId: row.loanId };
  const none: WatchDecision = { events: [], base: key, onTold: key };
  // Not indexed (yet): the indexer may be behind the loan; check again later.
  if (!loan) return none;
  const wallet = row.wallet.toLowerCase();
  const holds = wallet === loan.lenderHolder.toLowerCase() || wallet === loan.borrowerHolder.toLowerCase();
  if (loan.status !== 'active') {
    const event: WatchEvent = loan.status === 'repaid' ? { kind: 'repaid' } : { kind: 'closed', status: loan.status };
    // A holder is told by its own alerts; the watch ends either way.
    return { events: holds ? [] : [event], base: key, onTold: { ...key, end: true } };
  }
  if (holds || !reading) return none;

  const events: WatchEvent[] = [];
  const base: WatchUpdate = { ...key };
  const onTold: WatchUpdate = { ...key };
  if (reading.hf !== null) {
    const band = watchBandOf(reading.hf);
    const last = (row.lastBand in WATCH_BAND_RANK ? row.lastBand : 'healthy') as WatchBand;
    if (WATCH_BAND_RANK[band] > WATCH_BAND_RANK[last] && band !== 'healthy') {
      events.push({ kind: 'band', band, hf: reading.hf });
      onTold.lastBand = band;
    } else {
      // A recovery, or no change: recorded now, told never.
      base.lastBand = band;
    }
  }
  if (reading.maturity > 0 && now >= reading.maturity - WATCH_DUE_NOTICE_SECONDS && row.dueToldFor !== reading.maturity) {
    events.push({ kind: 'due', dueAt: reading.maturity, graceEnd: reading.graceEnd, now });
    onTold.dueToldFor = reading.maturity;
  }
  return { events, base, onTold };
}

export interface WatchLaneChain {
  id: number;
  name: string;
  diamond: string;
}

export interface WatchLaneDeps {
  chains: WatchLaneChain[];
  state: {
    dueWatches(dep: ChainDeployment, limit: number): Promise<WatchRow[]> | WatchRow[];
    recordWatches(dep: ChainDeployment, updates: WatchUpdate[], now: number): Promise<void> | void;
    chatsOf(pairs: { wallet: string; chainId: number }[]): Promise<(string | null)[]> | (string | null)[];
  };
  /** The indexed loans by id (one D1 read). */
  loans(chainId: number, ids: number[]): Promise<Map<number, LoanView>>;
  /** The chain's readings of active loans by id; null when the chain could
   *  not be read. `costs` is how many subrequests the read will spend. */
  reader(chain: WatchLaneChain): { costs: number; read(ids: number[]): Promise<Map<number, LoanReading> | null> };
  send: ((chatId: string, text: string) => Promise<TelegramOutcome>) | null;
  appOrigin: string;
  now: number;
}

/** One run of the pass. Returns how many messages were delivered. */
export async function runWatchedLoanAlerts(d: WatchLaneDeps): Promise<{ sent: number }> {
  let budget = WATCH_LANE_MAX_SUBREQUESTS;
  let sent = 0;
  for (const chain of d.chains) {
    const reader = d.reader(chain);
    if (budget < CHAIN_FIXED_SUBREQUESTS + reader.costs) {
      console.warn(`[watchedLoanAlerts] chain=${chain.name} skipped: ${budget} subrequest(s) left; it goes on a later run`);
      break;
    }
    const dep: ChainDeployment = { chainId: chain.id, diamond: chain.diamond };
    budget -= 1;
    const rows = await d.state.dueWatches(dep, WATCH_BATCH);
    if (rows.length === 0) continue;
    const ids = [...new Set(rows.map((r) => r.loanId))];
    budget -= 1;
    const loans = await d.loans(chain.id, ids);
    const active = ids.filter((id) => loans.get(id)?.status === 'active');
    let readings: Map<number, LoanReading> | null = new Map();
    if (active.length > 0) {
      budget -= reader.costs;
      readings = await reader.read(active);
    }
    const decisions = rows.map((r) => decideWatch(r, loans.get(r.loanId), readings?.get(r.loanId), d.now));
    const wallets = [...new Set(decisions.filter((x) => x.events.length > 0).map((x) => x.base.wallet))];
    let chats = new Map<string, string | null>();
    if (wallets.length > 0) {
      budget -= 1;
      const found = await d.state.chatsOf(wallets.map((wallet) => ({ wallet, chainId: chain.id })));
      chats = new Map(wallets.map((w, i) => [w, found[i] ?? null]));
    }

    const updates: WatchUpdate[] = [];
    for (const dec of decisions) {
      const chat = chats.get(dec.base.wallet) ?? null;
      // No chat, or no bot: nothing can be told, so nothing is pending either.
      if (dec.events.length === 0 || chat === null || d.send === null) {
        updates.push({ ...dec.base, ...dec.onTold });
        continue;
      }
      // Keep one subrequest for the record.
      if (budget - 1 < dec.events.length) break;
      let allTold = true;
      for (const event of dec.events) {
        budget -= 1;
        const outcome = await d.send(chat, watchAlertText({ event, chainName: chain.name, loanId: dec.base.loanId, appOrigin: d.appOrigin }));
        if (outcome === 'accepted') sent += 1;
        else if (outcome !== 'refused') allTold = false;
      }
      updates.push(allTold ? { ...dec.base, ...dec.onTold } : dec.base);
    }
    // Watches never reached for want of allowance are left unrecorded, so
    // they come first on the next run.
    budget -= 1;
    await d.state.recordWatches(dep, updates, d.now);
  }
  return { sent };
}

/** The chain reader over viem: one identity probe the first time, then one
 *  Multicall3 call for every loan's health level and due dates. */
export function viemWatchReader(chain: WatchLaneChain & { rpc: string }): ReturnType<WatchLaneDeps['reader']> {
  const client = createPublicClient({ transport: http(chain.rpc) });
  return {
    costs: isRpcIdentityVerified(chain.id, chain.rpc) ? 1 : 2,
    async read(ids) {
      const identity = await verifyRpcChainIdentity(client, chain.id, chain.rpc, 'watchedLoanAlerts');
      if (!identity.ok) return null;
      const diamond = chain.diamond as Address;
      try {
        const slots = await aggregateReads(
          client,
          MULTICALL3_ADDRESS,
          ids.flatMap((id) => [
            { address: diamond, abi: RiskFacetABI as Abi, functionName: 'calculateHealthFactor', args: [BigInt(id)] },
            { address: diamond, abi: LoanClockFacetABI as Abi, functionName: 'getLoanDeadlines', args: [BigInt(id)] },
          ]),
        );
        const out = new Map<number, LoanReading>();
        ids.forEach((id, i) => {
          const hfSlot = slots[2 * i]!;
          const dlSlot = slots[2 * i + 1]!;
          const hf = hfSlot.status === 'success' ? Number(hfSlot.result as bigint) / 1e18 : null;
          const dl = dlSlot.status === 'success' ? (dlSlot.result as readonly bigint[]) : null;
          out.set(id, {
            hf,
            maturity: dl ? Number(dl[2]) : 0,
            graceEnd: dl ? Number(dl[3]) : 0,
          });
        });
        return out;
      } catch (err) {
        console.warn(`[watchedLoanAlerts] chain=${chain.name}: read failed (${err instanceof Error ? err.name : 'error'})`);
        return null;
      }
    },
  };
}

/** The statement {@link d1LoansOf} runs; exported so a test runs it on the
 *  migrated schema. */
export const LOANS_BY_IDS_SQL = `SELECT loan_id, status, lender_current_owner, borrower_current_owner FROM loans
  WHERE chain_id = ? AND loan_id IN (SELECT value FROM json_each(?))`;

/** The indexed loans by id, in one D1 read. */
export async function d1LoansOf(db: D1Database, chainId: number, ids: number[]): Promise<Map<number, LoanView>> {
  const { results } = await db
    .prepare(LOANS_BY_IDS_SQL)
    .bind(chainId, JSON.stringify(ids))
    .all<{ loan_id: number; status: string; lender_current_owner: string; borrower_current_owner: string }>();
  return new Map(
    results.map((r) => [
      Number(r.loan_id),
      { status: r.status, lenderHolder: r.lender_current_owner, borrowerHolder: r.borrower_current_owner },
    ]),
  );
}
