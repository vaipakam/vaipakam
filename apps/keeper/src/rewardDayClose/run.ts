// apps/keeper/src/rewardDayClose/run.ts
//
// One run of the pass over every chain carrying a live reward clock, and one
// chain's run (`dayCloseOnce`). A chain's run, in order:
//
//   0. READ the gate: the chain's reward role (canonical or mirror; any other
//      role is skipped and its alerts closed), its reward day, the pause
//      state, its reporter config and its reward clock, and check that the
//      Diamond names itself this chain (an RPC pointed at another chain's
//      same-address Diamond would otherwise be worked as this one). A gate
//      read that fails, or a Diamond naming another chain, works nothing and
//      judges no other alert, and the gate alert says so. A clock not
//      running, or still on day 0, has no elapsed day. A paused protocol
//      refuses every call here, so the run sends nothing and judges no alert.
//      Every other chain is read only once attested the same way (peers.ts).
//   1. CLOSE every window day not yet reported here (close.ts; on a mirror,
//      only once mirror.ts has shown it safe).
//   2. On Base, FINALIZE and BROADCAST (base.ts, broadcast.ts).
//   3. JUDGE every alert from what the run established (alerts.ts), post the
//      zeroed-day notices (notices.ts), and settle the ledger of owed days.
//
// A day is worked through once nothing more is owed on it here, its alerts
// included: on a mirror, closed, and (when this keeper serves Base) its
// outcome recorded on Base, counted or finalized without it; on Base,
// finalized, broadcast to every destination it is owed, and its zeroed-chain
// notice delivered. Base's own close is owed only until the day is finalized
// (an admin's force-finalize can come first, after which a close is refused
// for good). Every other window day stays owed, and is worked in its turn.
//
// A call the RPC gives no answer about is not the contract's refusal: nothing
// is said about the day, and the run stops sending on that RPC. What a run
// sends is bounded per chain; every call is permissionless, and the only
// value it moves is the CCIP fee the keeper pays.

import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import type { ChainConfig, Env } from '../env';
import { getChainConfigs } from '../env';
import { buildKeeperContext, passIsArmed } from '../keeper';
import type { PassTick } from '../passSchedule';
import { deadlineClient, PastRunDeadline } from '../batchRead';
import { retireChainAlerts, retireUnworkedAlerts, settleAlerts, settleGate } from './alerts';
import { listsStand, runBase } from './base';
import { closeDays } from './close';
import { ABI, LOOKBACK_DAYS, PASS_ALERT_WINDOW_MS, ROLE_CANONICAL, ROLE_MIRROR } from './constants';
import type { ChainRun, DayCloseDeps, PeerReader } from './deps';
import { shortErr } from './errors';
import { feeCeiling } from './feeCeiling';
import { dayFact, known, type PerDay } from './fact';
import type { RunFindings } from './findings';
import { runMirror } from './mirror';
import { postZeroedNotices } from './notices';
import { attestedPeers } from './peers';
import { readDays } from './reads';
import { Sender } from './sender';
import { DayStore, mirrorTenure } from './store';

export async function runRewardDayClose(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'rewardDayClose', 'REWARD_DAY_CLOSE_ENABLED')) return;
  const sendDeadline = tick.deadlineMs - PASS_ALERT_WINDOW_MS;
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  // Chains side by side (runWindow.ts, rule 1): each has its own nonce lane.
  await Promise.all(
    chains.map(async (chain) => {
      try {
        const plain = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
        const client = deadlineClient(plain, sendDeadline);
        await dayCloseOnce(env, chain.id, chain.diamond as Address, {
          client,
          readClient: plain,
          context: () => buildKeeperContext(env, chain, client, { notAfterMs: sendDeadline }),
          peer: (id) => peerReader(chains, id, sendDeadline),
          served: chains.map((x) => x.id),
          sendDeadline,
          runDeadline: tick.deadlineMs,
          feeCeiling: feeCeiling(env.REWARD_DAY_CLOSE_MAX_FEE_WEI, chain.id),
        });
      } catch (err) {
        console.error(`[keeper] rewardDayClose chain=${chain.id} failed: ${shortErr(err)}`);
      }
    }),
  );
  await retireUnworkedAlerts(env, new Map(chains.map((c) => [c.id, (c.diamond as string).toLowerCase()])), tick.deadlineMs);
}

function peerReader(chains: readonly ChainConfig[], id: number, deadline: number): PeerReader | null {
  const c = chains.find((x) => x.id === id);
  if (!c) return null;
  return { diamond: c.diamond as Address, client: deadlineClient(createPublicClient({ transport: http(c.rpc) }) as PublicClient, deadline) };
}

/** What every step on a chain depends on, as read this run. */
interface Gate {
  role: number;
  today: number;
  active: boolean;
  paused: boolean;
  messenger: Address;
  baseChainId: number;
  graceSec: number;
  launch: number;
}

/**
 * The gate reads, or why the chain is not worked this run: one of them did not
 * come back, or the Diamond the RPC serves names itself another chain (an RPC
 * pointed at the wrong chain, where a deterministic deployment puts a Diamond
 * at the same address, would close and pay on that chain's days). Said by the
 * gate alert, never only logged.
 */
async function readGate(c: ChainRun): Promise<Gate | string> {
  const read = async <T>(functionName: string, what: string): Promise<T | string> => {
    try {
      return (await c.deps.client.readContract({ address: c.diamond, abi: ABI, functionName, args: [] })) as T;
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      return `${what} could not be read (${shortErr(err)})`;
    }
  };
  const role = await read<number>('getRewardRole', 'its reward role');
  if (typeof role === 'string') return role;
  const day = await read<readonly [bigint, boolean]>('getInteractionCurrentDay', 'its reward day');
  if (typeof day === 'string') return day;
  const paused = await read<boolean>('paused', 'whether the protocol is paused');
  if (typeof paused === 'string') return paused;
  const cfg = await read<readonly [Address, number, number, boolean, bigint]>('getRewardReporterConfig', 'its reward reporter config');
  if (typeof cfg === 'string') return cfg;
  if (Number(cfg[1]) !== c.chainId) {
    return `the Diamond its RPC serves at ${c.diamond} names itself chain ${Number(cfg[1])}, so the RPC configured for chain ${c.chainId} answers for another chain (or the Diamond's reporter config names the wrong local chain)`;
  }
  const launch = await read<bigint>('getInteractionLaunchTimestamp', 'its reward clock');
  if (typeof launch === 'string') return launch;
  return {
    role: Number(role),
    today: Number(day[0]),
    active: day[1],
    paused,
    messenger: cfg[0],
    baseChainId: Number(cfg[2]),
    graceSec: Number(cfg[4]),
    launch: Number(launch),
  };
}

/** One chain's run. Exported for tests. */
export async function dayCloseOnce(env: Env, chainId: number, diamond: Address, deps: DayCloseDeps): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const c: ChainRun = { chainId, diamond, deps, peers: attestedPeers(deps, `chain=${chainId}`), where: `chain=${chainId}` };
  const g = await readGate(c);
  if (typeof g === 'string') {
    console.error(`[keeper] rewardDayClose ${c.where}: not worked this run: ${g}`);
    await settleGate(env, chainId, diamond, g, nowSec, deps.runDeadline);
    return;
  }
  await settleGate(env, chainId, diamond, null, nowSec, deps.runDeadline);
  const { role, today, active, paused, messenger, baseChainId, graceSec, launch } = g;
  if (role !== ROLE_CANONICAL && role !== ROLE_MIRROR) {
    console.log(`[keeper] rewardDayClose ${c.where}: reward role ${role} is neither canonical nor mirror — nothing to close`);
    await retireChainAlerts(env, chainId, role, deps.runDeadline);
    return;
  }
  if (!active || today === 0) {
    console.log(`[keeper] rewardDayClose ${c.where}: ${active ? 'reward day 0 is still running' : 'reward clock not running'} — no elapsed day`);
    return;
  }
  if (paused) {
    console.log(`[keeper] rewardDayClose ${c.where}: protocol paused — nothing sent, alerts left as they stand`);
    return;
  }
  const canonical = role === ROLE_CANONICAL;
  const store = new DayStore(env, chainId, diamond, canonical ? 'canonical' : mirrorTenure(baseChainId, deps.peer(baseChainId)?.diamond ?? null));
  const window = await store.openWindow(today);
  const sender = new Sender(deps);

  // Reported here, per window day: as read, then as closed this run.
  const sentAt = await readDays<bigint>(c, window, 'getChainReportSentAt');
  const reportedHere: PerDay<boolean> = new Map(window.map((d) => {
    const s = dayFact(sentAt, d);
    return [d, s.known ? known(s.value > 0n) : s];
  }));
  const unclosed = window.filter((d) => {
    const s = dayFact(reportedHere, d);
    if (!s.known) sender.noteUnread(`close:${d}`, 'whether this chain has reported the day');
    return s.known && !s.value;
  });

  const f: RunFindings = { chainId, canonical, window, refused: sender.refused, unread: sender.unread, stall: null, unattested: c.peers.unattested, done: () => false, clock: null, base: null, mirror: null };
  let line = '';
  let closed: number[] = [];
  if (canonical) {
    closed = (await closeDays(c, store, sender, unclosed, null)).closed;
    for (const d of closed) reportedHere.set(d, known(true));
    const r = await runBase(c, store, sender, { window, ownReported: reportedHere, messenger, graceSec, launch, nowSec });
    f.base = r.b;
    f.clock = r.clock;
    const unconfirmed = [...r.b.broadcast].filter(([, p]) => p.done && p.unconfirmed.length > 0).map(([d]) => d);
    const unproven = [...r.b.broadcast].flatMap(([d, p]) => p.unproven.map((k) => `${d}:${k}`));
    const stale = r.clock?.differ.length === 0 && r.clock.stale ? ' clock-unchecked' : '';
    line =
      ` finalized=${r.finalizedNow} broadcast=${r.broadcastNow}` +
      (r.b.finalizeHold !== null ? ` finalize-held(${r.b.finalizeHold})` : '') +
      (r.b.broadcastHold !== null ? ` broadcast-held(${r.b.broadcastHold})` : '') +
      (unconfirmed.length > 0 ? ` broadcast-unconfirmed(unserved destinations)=${unconfirmed.join(',')}` : '') +
      (unproven.length > 0 ? ` broadcast-unproven(unserved, no receipt seen)=${unproven.join(',')}` : '') +
      stale;
  } else {
    const r = await runMirror(c, store, sender, { window, unclosed, launch, messenger, baseChainId });
    closed = r.closed;
    for (const d of closed) reportedHere.set(d, known(true));
    f.mirror = r.m;
    f.clock = r.clock;
    const excluded = window.filter((d) => {
      const x = dayFact(r.m.excluded, d);
      return x.known && x.value;
    });
    line = (r.m.closeHold !== null ? ` close-held(${r.m.closeHold})` : '') + (excluded.length > 0 ? ` finalized-without-this-chain=${excluded.join(',')}` : '');
  }

  // What is done, as read or landed: what clears a refusal, and (with the
  // alerts) what takes a day out of the ledger.
  // A landed call completes a step only where one call is the whole step. A
  // broadcast may take several sends, so only its plan, read before them,
  // says it is done; what this run sent is confirmed by the next run's reads.
  const isDone = (step: string, d: number): boolean => {
    if (step !== 'broadcast' && sender.landed.has(`${step}:${d}`)) return true;
    if (step === 'close') {
      const r = dayFact(reportedHere, d);
      return r.known && r.value;
    }
    if (step === 'finalize') return f.base?.finalized.has(d) === true;
    if (step === 'broadcast') return f.base?.broadcast.get(d)?.done === true;
    return false;
  };
  f.done = (stepDay) => {
    const [step, day] = stepDay.split(':');
    return isDone(step, Number(day));
  };

  console.log(
    `[keeper] rewardDayClose ${c.where} role=${canonical ? 'canonical' : 'mirror'} today=${today} window=${window[0]}..${today - 1}` +
      (window.some((d) => d < today - LOOKBACK_DAYS) ? `+backlog=${window.filter((d) => d < today - LOOKBACK_DAYS).join(',')}` : '') +
      ` unclosed=${unclosed.length} closed=${closed.length}` +
      line +
      (sender.refused.size > 0 ? ` refused=${[...sender.refused.keys()].join(',')}` : '') +
      (sender.unread.size > 0 ? ` unread=${[...sender.unread.keys()].join(',')}` : '') +
      (sender.stopped ? ` stopped=${sender.stopReason}` : ''),
  );

  // While paused, alerts are left as they stand and nothing is posted, so no
  // day leaves the ledger: what a day is owed includes its alerts.
  if (sender.paused) {
    await store.settle(today, window, () => false);
    return;
  }
  f.stall = sender.stall;
  if (f.base !== null) {
    const finalized = f.base.finalized;
    f.base.noticed = await postZeroedNotices(env, store, window.filter((d) => finalized.has(d)), deps.runDeadline, (k, what) => sender.noteUnread(k, what));
  }
  const held = await settleAlerts(env, store, f, nowSec, deps.runDeadline);
  // On Base, a day leaves only on plans made against the lists as they still
  // stand (base.ts, listsStand).
  const stand = f.base === null || (await listsStand(c, f.base, messenger));
  if (!stand) console.log(`[keeper] rewardDayClose ${c.where}: Base's lists changed or could not be read again before settling; every day stays owed for the next run`);
  const through = (d: number): boolean => {
    if (held === 'all' || held.has(d)) return false;
    if (f.base !== null) return stand && isDone('finalize', d) && isDone('broadcast', d) && f.base.noticed.has(d);
    const outcome = dayFact(f.mirror!.outcome, d);
    return isDone('close', d) && (!f.mirror!.baseServed || (outcome.known && outcome.value));
  };
  await store.settle(today, window, through);
}
