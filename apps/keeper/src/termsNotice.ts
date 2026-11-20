// apps/keeper/src/termsNotice.ts
//
// #3734 part two — the TERMS ANNOUNCEMENT alert. When a material change to
// the Terms is announced (`LegalFacet.announceTos` / `announceTosMinimum`,
// event `TosAnnounced`), a wallet that has not accepted the version that will
// then be in force takes on no new position from the time it comes into
// force: its open offers, Auto-lend slots and standing instructions stop
// filling and running (they are not cancelled). The design (Terms acceptance
// enforcement, section 5) has every alert channel carry the announcement to
// those wallets, with the date. This pass is the keeper's half: it sends the
// owner alert through the agent's keeper route (#1722) and Push, and does no
// more. It records nothing on chain and sends no transaction.
//
// Per chain, per run:
//
//   1. The pending announcement, read on chain (`getAnnouncedTos`). None
//      pending, or its time already come, and the run ends. The event only
//      tells the pass to look; the chain's own view is what it acts on, so a
//      withdrawn announcement is never alerted.
//   2. The wallets with standing commitments, from the shared indexer's
//      records: creators of open offers and makers of open signed offers,
//      owners of Auto-lend slots (confirmed on chain: the owner still has at
//      least one slot), and owners of standing instructions not cleared
//      since, on loans still active.
//   3. For each wallet not yet handled for THIS announcement, whether it
//      will be current when the change comes into force: it accepted a
//      version from the announced minimum to the then-latest version that is
//      (or then will be) in force. Such a wallet needs nothing and is marked
//      handled without an alert. Every other wallet is alerted once.
//
// An announcement is keyed by its version, minimum and time, so a withdrawn
// announcement that is made again with a new time is a new announcement and
// alerts again. A wallet whose delivery should be retried (the agent or Push
// unreachable) is left for the next run; one with no linked chat and no Push
// subscription is handled. At most WALLETS_PER_RUN wallets are read per chain
// per scan, in address order, and a scan runs at most every SCAN_INTERVAL_SEC,
// so a large book drains over several scans well inside the notice period
// (seven days at least, `MIN_TOS_NOTICE`): 40 wallets every 15 minutes is
// over 26,000 in a week.
//
// Gated by KEEPER_ENABLED and TERMS_NOTICE_ENABLED. Ships unset.

import { createPublicClient, http, type Abi, type Address, type PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { renderTelegramAlert, type AddressedAlert } from '@vaipakam/lib/telegramAlerts/message';
import { TERMS_HOLDS, type TermsHold } from '@vaipakam/lib/telegramAlerts/termsCopy';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { passIsArmed } from './keeper';
import type { PassTick } from './passSchedule';
import { deadlineClient } from './batchRead';
import { shortErr } from './callErrors';
import { d1ScanCursors, type ScanCursors } from './scanCursors';
import { deploymentFloor, listThresholdsForChain, type UserThresholds } from './db';
import { AlertDelivery, delivered, worthRetrying } from './alertDelivery';
import type { NoticeOutcome } from './standingInstructions';

/** How often the pass reads the commitments and alerts while an
 *  announcement is pending, in seconds. The pass itself is scheduled every
 *  tick (every staggered minute of the hour is taken), so with nothing
 *  pending a run is one chain read; the notice is a week or more. */
export const SCAN_INTERVAL_SEC = 15 * 60;
/** The most wallets one chain reads per run. */
export const WALLETS_PER_RUN = 40;

const ABI = DIAMOND_ABI_VIEM as Abi;

/** A pending announcement as `getAnnouncedTos` returns it. */
export interface Announcement {
  version: number;
  effectiveAt: number;
  minVersion: number;
  newVersion: boolean;
}

/** The chain reads the pass makes. Injected so a run is testable. */
export interface TermsReads {
  /** The pending announcement, or null when none is pending. */
  announced(): Promise<Announcement | null>;
  /** The latest version in force now. */
  latest(): Promise<number>;
  /** The versions `wallet` accepted. */
  accepted(wallet: Address): Promise<number[]>;
  /** When `version` came into force (0 = never). */
  inForceAt(version: number): Promise<number>;
  /** Whether `owner` holds at least one Auto-lend slot now. */
  hasSlot(owner: Address): Promise<boolean>;
}

/** The wallets the indexer records with each kind of commitment. Addresses
 *  lowercase. Auto-lend owners are candidates, confirmed on chain. */
export interface CommitmentSources {
  offerCreators(chainId: number): Promise<string[]>;
  slotOwners(chainId: number): Promise<string[]>;
  standingOwners(chainId: number): Promise<string[]>;
}

export interface TermsNoticeDeps {
  reads: TermsReads;
  sources: CommitmentSources;
  cursors: ScanCursors;
  /** Delivers one alert and says whether it may be marked handled. */
  notify: (alert: AddressedAlert) => Promise<NoticeOutcome>;
  /** Unix seconds now. */
  now: number;
}

export interface TermsNoticeReport {
  chainId: number;
  /** The announcement's key, or null when none is pending. */
  key: string | null;
  /** True when the last scan for this announcement was under
   *  SCAN_INTERVAL_SEC ago, so this run read nothing more. */
  waiting: boolean;
  candidates: number;
  alerted: string[];
  /** Wallets that will be current in time, handled without an alert. */
  current: number;
  /** Wallets whose delivery is retried next run. */
  retry: number;
  /** Wallets left for a later run by the per-run bound. */
  deferred: number;
  unread: string[];
}

/** The cursor item holding the wallets handled for announcement `key`. */
const doneItem = (key: string) => `done:${key}`;

/** Whether a wallet that accepted `accepted` is current once the
 *  announcement comes into force. Pure but for `inForceAt`. */
export async function currentAfter(
  accepted: readonly number[],
  a: Announcement,
  latestNow: number,
  inForceAt: (v: number) => Promise<number>,
): Promise<boolean> {
  const latestAfter = a.newVersion ? a.version : latestNow;
  const floor = a.minVersion === 0 ? 1 : a.minVersion;
  for (const v of accepted) {
    if (v < floor || v > latestAfter) continue;
    if (a.newVersion && v === a.version) return true;
    if ((await inForceAt(v)) !== 0) return true;
  }
  return false;
}

export async function termsNoticeOnce(chainId: number, deps: TermsNoticeDeps): Promise<TermsNoticeReport> {
  const report: TermsNoticeReport = { chainId, key: null, waiting: false, candidates: 0, alerted: [], current: 0, retry: 0, deferred: 0, unread: [] };
  let a: Announcement | null;
  try {
    a = await deps.reads.announced();
  } catch (err) {
    report.unread.push(`the pending announcement (${shortErr(err)})`);
    return report;
  }
  if (a === null || a.effectiveAt <= deps.now) return report;
  const key = `${a.version}-${a.minVersion}-${a.effectiveAt}`;
  report.key = key;
  const item = doneItem(key);
  const lastItem = `last:${key}`;
  const stored = await deps.cursors.get([item, lastItem]);
  const last = Number(stored.get(lastItem) ?? '0');
  if (Number.isFinite(last) && deps.now - last < SCAN_INTERVAL_SEC) {
    report.waiting = true;
    return report;
  }
  await deps.cursors.put(lastItem, String(deps.now));

  // Each source on its own: one unread source leaves the others alerted.
  const holds = new Map<string, Set<TermsHold>>();
  const add = (wallets: readonly string[], h: TermsHold) => {
    for (const w of wallets) {
      const k = w.toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(k)) continue;
      (holds.get(k) ?? holds.set(k, new Set()).get(k)!).add(h);
    }
  };
  const read = async (what: string, f: () => Promise<string[]>, h: TermsHold) => {
    try {
      add(await f(), h);
    } catch (err) {
      report.unread.push(`${what} (${shortErr(err)})`);
    }
  };
  await read('the open offers', () => deps.sources.offerCreators(chainId), 'offer');
  await read('the Auto-lend owners', () => deps.sources.slotOwners(chainId), 'autoLend');
  await read('the standing instructions', () => deps.sources.standingOwners(chainId), 'standing');
  report.candidates = holds.size;
  if (holds.size === 0) return report;

  const done = new Set((stored.get(item) ?? '').split('\n').filter((w) => w.length > 0));
  const todo = [...holds.keys()].filter((w) => !done.has(w)).sort();
  report.deferred = Math.max(0, todo.length - WALLETS_PER_RUN);

  let latestNow: number;
  try {
    latestNow = await deps.reads.latest();
  } catch (err) {
    report.unread.push(`the latest Terms version (${shortErr(err)})`);
    return report;
  }
  const inForce = new Map<number, Promise<number>>();
  const inForceAt = (v: number) => inForce.get(v) ?? inForce.set(v, deps.reads.inForceAt(v)).get(v)!;

  let changed = false;
  for (const wallet of todo.slice(0, WALLETS_PER_RUN)) {
    const has = holds.get(wallet)!;
    try {
      // An Auto-lend owner from the records is confirmed on chain.
      if (has.has('autoLend') && !(await deps.reads.hasSlot(wallet as Address))) has.delete('autoLend');
      if (has.size === 0 || (await currentAfter(await deps.reads.accepted(wallet as Address), a, latestNow, inForceAt))) {
        if (has.size > 0) report.current += 1;
        done.add(wallet);
        changed = true;
        continue;
      }
    } catch (err) {
      report.unread.push(`${wallet} (${shortErr(err)})`);
      continue;
    }
    const outcome = await deps.notify({
      chainId,
      wallet,
      alert: { kind: 'termsAnnounced', version: a.version, effectiveAt: a.effectiveAt, holds: TERMS_HOLDS.filter((h) => has.has(h)) },
    });
    if (outcome === 'retry') {
      report.retry += 1;
      continue;
    }
    if (outcome === 'sent') report.alerted.push(wallet);
    done.add(wallet);
    changed = true;
  }
  if (changed) await deps.cursors.put(item, [...done].sort().join('\n'));
  return report;
}

export function describeReport(r: TermsNoticeReport): string {
  if (r.key === null) {
    return `[keeper] termsNotice chain=${r.chainId}: no Terms announcement pending${r.unread.length ? `; not read: ${r.unread.join('; ')}` : ''}`;
  }
  if (r.waiting) return `[keeper] termsNotice chain=${r.chainId} announcement=${r.key}: scanned under ${SCAN_INTERVAL_SEC / 60} minutes ago`;
  return (
    `[keeper] termsNotice chain=${r.chainId} announcement=${r.key}: ${r.candidates} wallet(s) with commitments, ` +
    `${r.alerted.length} alerted, ${r.current} already accepted, ${r.retry} to retry, ${r.deferred} left for later runs` +
    (r.unread.length ? `; not read: ${r.unread.join('; ')}` : '')
  );
}

/** The chain reads, on `diamond`. */
export function chainTermsReads(client: Pick<PublicClient, 'readContract'>, diamond: Address): TermsReads {
  const call = <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address: diamond, abi: ABI, functionName, args }) as Promise<T>;
  return {
    async announced() {
      const [version, , effectiveAt, minVersion, newVersion] = await call<readonly [number, string, bigint, number, boolean]>('getAnnouncedTos');
      return effectiveAt === 0n ? null : { version: Number(version), effectiveAt: Number(effectiveAt), minVersion: Number(minVersion), newVersion };
    },
    async latest() {
      const [latest] = await call<readonly [number, string, number]>('getTosVersions');
      return Number(latest);
    },
    async accepted(wallet) {
      return (await call<readonly number[]>('getUserAcceptedTosVersions', [wallet])).map(Number);
    },
    async inForceAt(version) {
      return Number(await call<bigint>('getTosVersionInForceAt', [version]));
    },
    async hasSlot(owner) {
      const [, total] = await call<readonly [unknown, bigint]>('getLenderIntentsByOwner', [owner, 0n, 1n]);
      return total > 0n;
    },
  };
}

/** The shared indexer's records of who holds what. */
export function d1CommitmentSources(db: D1Database): CommitmentSources {
  const list = async (sql: string, ...binds: unknown[]) =>
    ((await db.prepare(sql).bind(...binds).all<{ w: string }>()).results ?? []).map((r) => String(r.w));
  return {
    offerCreators: (chainId) =>
      list(
        `SELECT DISTINCT lower(creator) AS w FROM offers WHERE chain_id = ?1 AND status = 'active'
         UNION SELECT DISTINCT lower(signer) AS w FROM signed_offers WHERE chain_id = ?1 AND status = 'active'`,
        chainId,
      ),
    slotOwners: (chainId) =>
      list(
        `SELECT DISTINCT lower(json_extract(args_json, '$.owner')) AS w FROM activity_events
          WHERE chain_id = ?1 AND block_number >= ?2 AND kind = 'LenderIntentSet'`,
        chainId,
        deploymentFloor(chainId),
      ),
    // The latest of Set and Cleared per loan, kept when it is a Set and the
    // loan is still active.
    standingOwners: (chainId) =>
      list(
        `WITH last AS (
           SELECT kind, json_extract(args_json, '$.owner') AS owner,
                  CAST(json_extract(args_json, '$.loanId') AS TEXT) AS loan_id,
                  ROW_NUMBER() OVER (PARTITION BY CAST(json_extract(args_json, '$.loanId') AS TEXT)
                                     ORDER BY block_number DESC, log_index DESC) AS n
             FROM activity_events
            WHERE chain_id = ?1 AND block_number >= ?2
              AND kind IN ('StandingInstructionsSet', 'StandingInstructionsCleared'))
         SELECT DISTINCT lower(last.owner) AS w FROM last
           JOIN loans ON loans.chain_id = ?1 AND CAST(loans.loan_id AS TEXT) = last.loan_id
          WHERE last.n = 1 AND last.kind = 'StandingInstructionsSet' AND loans.status = 'active'`,
        chainId,
        deploymentFloor(chainId),
      ),
  };
}

export async function runTermsNotice(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'termsNotice', 'TERMS_NOTICE_ENABLED')) return;
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  const delivery = new AlertDelivery(env);
  const sources = d1CommitmentSources(env.DB);
  await Promise.all(
    chains.map(async (chain: ChainConfig) => {
      try {
        const client = deadlineClient(createPublicClient({ transport: http(chain.rpc) }) as PublicClient, tick.deadlineMs);
        const report = await termsNoticeOnce(chain.id, {
          reads: chainTermsReads(client, chain.diamond as Address),
          sources,
          cursors: d1ScanCursors(env.KEEPER_DB, chain.id, chain.diamond as string, 'termsNotice'),
          notify: notifierFor(env, chain, delivery),
          now: Math.floor(Date.now() / 1000),
        });
        console.log(describeReport(report));
      } catch (err) {
        console.error(`[keeper] termsNotice chain=${chain.id} failed: ${shortErr(err)}`);
      }
    }),
  );
  delivery.disclose('termsNotice');
}

/** One chain's sender: the Telegram half as data for the agent, the Push half
 *  when the wallet subscribed on this chain, in its language. */
function notifierFor(env: Env, chain: ChainConfig, delivery: AlertDelivery): (alert: AddressedAlert) => Promise<NoticeOutcome> {
  let subs: Promise<Map<string, UserThresholds>> | null = null;
  const appOrigin = env.FRONTEND_ORIGIN ?? '';
  return async (alert) => {
    const read = (subs ??= listThresholdsForChain(env.DB, chain.id).then((rows) => new Map(rows.map((r) => [r.wallet.toLowerCase(), r]))));
    const sub = (await read).get(alert.wallet.toLowerCase());
    const rendered = renderTelegramAlert(alert, { locale: sub?.locale ?? null, chainName: chain.name ?? String(chain.id), appOrigin });
    const outcome = await delivery.deliver({
      telegram: { diamond: chain.diamond as string, message: alert },
      pushSubscriber: sub?.push_channel ? alert.wallet : null,
      text: rendered.text,
      pushTitle: rendered.title,
      deepLinkUrl: `${appOrigin}/`,
    });
    return delivered(outcome) ? 'sent' : worthRetrying(outcome) ? 'retry' : 'gone';
  };
}
