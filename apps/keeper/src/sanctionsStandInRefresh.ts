// apps/keeper/src/sanctionsStandInRefresh.ts
//
// #3113 — keeps the TESTNET sanctions stand-in fresh, so the delisting
// timelocks' cross-chain clearance route stays open (owner decision
// 2026-11-04: the keeper refreshes it weekly instead of the admin by hand).
//
// The testnet route: each chain's `SanctionsDelistingTimelock` asks the
// `SanctionsClearanceAttestor` on the attestor chain over CCIP, the attestor
// reads a `TestnetSanctionsOracleStandIn`, and the timelock refuses an answer
// whose list is older than its `oracleMaxAge`. The stand-in's age is the time
// of its last publication, never the clock, so a stand-in nobody refreshes
// closes the route once that age passes, as a frozen RedStone would.
//
// Per chain whose deployment records a clearance attestor, per run (hourly):
//
//   1. A mainnet is refused before anything is read: a stand-in cannot exist
//      there, and a mainnet attestor reads RedStone itself.
//   2. The stand-in is the one the attestor actually reads (`oracle()`), and
//      it must say it is a testnet stand-in (`isTestnetStandIn`).
//   3. The age limit is the smallest `oracleMaxAge` among the timelocks this
//      keeper serves whose clearance source is this attestor on this chain.
//      With none readable the run sends nothing and says why.
//   4. Once the stand-in is older than that limit less `REFRESH_MARGIN_SEC`,
//      the keeper calls `markUpdated()`, which re-publishes the owner's list
//      unchanged; the stand-in lets its named refresher do that and nothing
//      else, so the keeper can flag or clear no address. The keeper must be
//      that refresher (`refresher()`); otherwise nothing is sent.
//   5. The ops chat is told when the stand-in is past the limit (the route is
//      closed), when the keeper is not its refresher, and when a refresh was
//      refused; each alert clears once its condition does.
//
// Gated by KEEPER_ENABLED + STANDIN_REFRESH_ENABLED. Ships disarmed. On a
// chain with no clearance attestor recorded the pass does nothing.

import { createPublicClient, http, type Abi, type Address, type PublicClient } from 'viem';
import {
  SanctionsClearanceAttestorABI,
  SanctionsDelistingTimelockABI,
  TestnetSanctionsOracleStandInABI,
} from '@vaipakam/contracts/abis';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { isTestnet } from '@vaipakam/lib/chainPlatforms';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, resolveKeeperAccount, type KeeperContext } from './keeper';
import type { PassTick } from './passSchedule';
import { deadlineClient, PastRunDeadline } from './batchRead';
import { shortErr } from './callErrors';
import { resolveOpsAlerts, sendOpsAlert } from './opsAlert';
import { StepSender } from './stepSender';

export const ABI = [
  ...(TestnetSanctionsOracleStandInABI as Abi),
  ...(SanctionsClearanceAttestorABI as Abi),
  ...(SanctionsDelistingTimelockABI as Abi),
] as Abi;

/** The pass's cadence, in seconds; the scheduler reads it from here. */
export const PASS_CADENCE_SEC = 60 * 60;
/** How long before the age limit the stand-in is refreshed: a day of hourly
 *  runs to get one refresh through. */
export const REFRESH_MARGIN_SEC = 24 * 60 * 60;
export const RECEIPT_TIMEOUT_MS = 30_000;
/** How often an open alert is repeated while its condition holds. */
export const ALERT_REPEAT_SEC = 6 * 60 * 60;

/** One timelock that may take its clearance from this attestor. */
export interface TimelockSource {
  chainId: number;
  timelock: Address;
  client: PublicClient;
}

/** What one chain's run reads and signs with. Injected so a run is testable. */
export interface RefreshDeps {
  /** Deadline-bound client for the attestor chain. */
  client: PublicClient;
  context: () => KeeperContext | null;
  /** The keeper's address, or null when the key is unset or malformed. */
  keeper: Address | null;
  sendDeadline: number;
  /** The clearance attestor this chain's deployment records. */
  attestor: Address;
  /** Every other chain's timelock this keeper can read. */
  timelocks: readonly TimelockSource[];
}

/** What a run did on one chain: its log line, and its alerts' conditions. */
export interface RefreshReport {
  chainId: number;
  /** Why the run did nothing, when it did nothing. */
  skipped?: string;
  standIn: Address | null;
  /** The stand-in's age at the chain's clock, in seconds. */
  ageSec: bigint | null;
  /** The binding age limit, and which timelocks set it. */
  maxAgeSec: bigint | null;
  servedBy: number[];
  /** Timelocks whose source could not be read: they bind nothing this run. */
  unreadTimelocks: string[];
  /** `landed`, a refusal, or why nothing was sent. */
  refresh: string | null;
  /** Conditions the ops chat is told about. */
  stale: boolean;
  notRefresher: Address | null;
  refused: string | null;
}

export async function runSanctionsStandInRefresh(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'sanctionsStandInRefresh', 'STANDIN_REFRESH_ENABLED')) return;
  const sendDeadline = tick.deadlineMs;
  const resolved = env.KEEPER_PRIVATE_KEY ? resolveKeeperAccount(env.KEEPER_PRIVATE_KEY) : null;
  const keeper = resolved && 'account' in resolved ? resolved.account.address : null;
  const chains = getChainConfigs(env);
  const clientOf = new Map<number, PublicClient>(
    chains.map((c) => [c.id, deadlineClient(createPublicClient({ transport: http(c.rpc) }) as PublicClient, sendDeadline)]),
  );
  const timelocks: TimelockSource[] = [];
  for (const c of chains) {
    const timelock = getDeployment(c.id)?.sanctionsDelistingTimelock as Address | undefined;
    if (timelock) timelocks.push({ chainId: c.id, timelock, client: clientOf.get(c.id)! });
  }
  await Promise.all(
    chains.map(async (chain: ChainConfig) => {
      const attestor = getDeployment(chain.id)?.sanctionsClearanceAttestor as Address | undefined;
      if (!attestor) return;
      try {
        const client = clientOf.get(chain.id)!;
        const report = await refreshOnce(chain.id, {
          client,
          context: () => buildKeeperContext(env, chain, client, { notAfterMs: sendDeadline }),
          keeper,
          sendDeadline,
          attestor,
          timelocks: timelocks.filter((t) => t.chainId !== chain.id),
        });
        console.log(describeReport(report));
        await alert(env, report);
      } catch (err) {
        console.error(`[keeper] sanctionsStandInRefresh chain=${chain.id} failed: ${shortErr(err)}`);
      }
    }),
  );
}

/** The run's one line for a chain. */
export function describeReport(r: RefreshReport): string {
  const head = `[keeper] sanctionsStandInRefresh chain=${r.chainId}`;
  if (r.skipped) return `${head}: not worked this run: ${r.skipped}`;
  return [
    head,
    `stand-in=${r.standIn}`,
    `age=${r.ageSec ?? 'unread'}s`,
    `max-age=${r.maxAgeSec ?? 'unread'}s (timelocks on ${r.servedBy.join(',') || 'none'})`,
    ...(r.unreadTimelocks.length > 0 ? [`timelocks-unread=${r.unreadTimelocks.join('; ')}`] : []),
    `refresh=${r.refresh ?? 'none'}`,
  ].join(' ');
}

const blank = (chainId: number): RefreshReport => ({
  chainId,
  standIn: null,
  ageSec: null,
  maxAgeSec: null,
  servedBy: [],
  unreadTimelocks: [],
  refresh: null,
  stale: false,
  notRefresher: null,
  refused: null,
});

/** One chain's run. Exported for tests. */
export async function refreshOnce(chainId: number, deps: RefreshDeps): Promise<RefreshReport> {
  const report = blank(chainId);
  if (!isTestnet(chainId)) return { ...report, skipped: 'not a testnet; a mainnet attestor reads RedStone, which no keeper refreshes' };
  const read = <T>(address: Address, functionName: string, client: PublicClient = deps.client): Promise<T> =>
    client.readContract({ address, abi: ABI, functionName, args: [] }) as Promise<T>;
  try {
    let served: number;
    try {
      served = await deps.client.getChainId();
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      return { ...report, skipped: `the RPC's chain id could not be read (${shortErr(err)})` };
    }
    if (served !== chainId) return { ...report, skipped: `the RPC configured for chain ${chainId} serves chain ${served}` };

    // 2. The stand-in the attestor reads, which must say it is one.
    let standIn: Address;
    let isStandIn: boolean;
    try {
      standIn = (await read<Address>(deps.attestor, 'oracle')).toLowerCase() as Address;
      isStandIn = await read<boolean>(standIn, 'isTestnetStandIn');
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      return { ...report, skipped: `the attestor's oracle could not be read as a testnet stand-in (${shortErr(err)})` };
    }
    if (isStandIn !== true) return { ...report, skipped: `the attestor's oracle ${standIn} does not say it is a testnet stand-in` };
    report.standIn = standIn;

    // 3. The binding age limit: the timelocks this attestor answers.
    const mine = deps.attestor.toLowerCase();
    await Promise.all(
      deps.timelocks.map(async (t) => {
        try {
          const [source, attestor, maxAge] = await Promise.all([
            read<bigint>(t.timelock, 'clearanceSourceChainId', t.client),
            read<Address>(t.timelock, 'clearanceAttestor', t.client),
            read<number | bigint>(t.timelock, 'oracleMaxAge', t.client),
          ]);
          if (BigInt(source) !== BigInt(chainId) || attestor.toLowerCase() !== mine) return;
          const age = BigInt(maxAge);
          if (report.maxAgeSec === null || age < report.maxAgeSec) report.maxAgeSec = age;
          report.servedBy.push(t.chainId);
        } catch (err) {
          if (err instanceof PastRunDeadline) throw err;
          report.unreadTimelocks.push(`chain ${t.chainId} (${shortErr(err)})`);
        }
      }),
    );
    report.servedBy.sort((a, b) => a - b);

    let lastUpdate: bigint;
    let refresher: Address;
    let now: bigint;
    try {
      [lastUpdate, refresher, now] = await Promise.all([
        read<bigint>(standIn, 'getLastUpdateBlockTimestamp'),
        read<Address>(standIn, 'refresher'),
        deps.client.getBlock().then((b) => b.timestamp),
      ]);
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      return { ...report, skipped: `the stand-in's freshness, its refresher or the chain's clock could not be read (${shortErr(err)})` };
    }
    report.ageSec = now > lastUpdate ? now - lastUpdate : 0n;
    if (report.maxAgeSec === null) {
      report.refresh = report.unreadTimelocks.length > 0 ? 'not judged: no timelock it serves could be read' : 'not judged: no timelock this keeper reads takes its clearance from it';
      return report;
    }
    report.stale = report.ageSec > report.maxAgeSec;

    // 4. Refresh once inside the margin, as its named refresher only.
    const due = report.ageSec + BigInt(REFRESH_MARGIN_SEC) >= report.maxAgeSec;
    if (!due) return report;
    if (deps.keeper === null) {
      report.refresh = 'due, but the keeper has no usable signing key';
      return report;
    }
    if (refresher.toLowerCase() !== deps.keeper.toLowerCase()) {
      report.notRefresher = refresher;
      report.refresh = `due, but the stand-in's refresher is ${refresher}, not this keeper`;
      return report;
    }
    const sender = new StepSender(
      {
        pass: 'sanctionsStandInRefresh',
        abi: ABI,
        maxSends: 1,
        receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
        races: new Set(),
        pausedRefusal: 'EnforcedPause',
        describe: (s) => String(s),
        spends: 'the gas',
        target: standIn,
      },
      { context: deps.context, sendDeadline: deps.sendDeadline },
    );
    const res = await sender.call('refresh', standIn, 'markUpdated', []);
    report.refresh = res;
    if (res === 'landed') {
      report.stale = false;
      report.ageSec = 0n;
    } else if (res !== 'skipped' && res !== 'idle') {
      report.refused = res;
    } else if (sender.stopped) {
      report.refresh = `not sent: ${sender.stall ?? sender.stopReason}`;
    }
  } catch (err) {
    if (!(err instanceof PastRunDeadline)) throw err;
    report.refresh = report.refresh ?? 'the run deadline passed during its reads';
  }
  return report;
}

/** Tell the ops chat what needs a person, and clear what no longer does. */
async function alert(env: Env, r: RefreshReport): Promise<void> {
  if (r.skipped || r.standIn === null) return;
  const where = `chain ${r.chainId}, stand-in ${r.standIn}`;
  const conditions: [string, boolean, () => string][] = [
    [
      `standin-stale:${r.chainId}`,
      r.stale,
      () =>
        `Sanctions stand-in is stale on ${where}: its list is ${r.ageSec}s old, past the ${r.maxAgeSec}s the timelocks on ${r.servedBy.join(', ')} accept, so their automated delisting route is closed until it is refreshed.`,
    ],
    [
      `standin-not-refresher:${r.chainId}`,
      r.notRefresher !== null,
      () =>
        `The keeper cannot refresh the sanctions stand-in on ${where}: its refresher is ${r.notRefresher}. The admin names the keeper with setRefresher, or refreshes it with markUpdated.`,
    ],
    [`standin-refused:${r.chainId}`, r.refused !== null, () => `The stand-in refresh on ${where} was refused: ${r.refused}.`],
  ];
  for (const [key, on, text] of conditions) {
    if (on) await sendOpsAlert(env, key, text(), ALERT_REPEAT_SEC, undefined, r.chainId);
  }
  await resolveOpsAlerts(
    env,
    conditions.filter(([, on]) => !on).map(([key]) => key),
  );
}
