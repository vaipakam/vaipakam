// apps/keeper/src/rewardDayClose/run.ts
//
// One run of the pass over every chain carrying a live reward clock, and one
// chain's run (`dayCloseOnce`). A chain's run, in order:
//
//   0. READ the chain's reward role (canonical or mirror; any other role is
//      skipped and its alerts closed), its reward clock and the pause state.
//      A clock not running, or still on day 0, has no elapsed day. A paused
//      protocol refuses every call here, so the run sends nothing and judges
//      no alert.
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
import { deadlineClient } from '../batchRead';
import { retireChainAlerts, settleAlerts } from './alerts';
import { runBase } from './base';
import { closeDays } from './close';
import { ABI, LOOKBACK_DAYS, PASS_ALERT_WINDOW_MS, ROLE_CANONICAL, ROLE_MIRROR } from './constants';
import type { ChainRun, DayCloseDeps, PeerReader } from './deps';
import { shortErr } from './errors';
import { dayFact, known, type PerDay } from './fact';
import type { RunFindings } from './findings';
import { runMirror } from './mirror';
import { postZeroedNotices } from './notices';
import { readDays } from './reads';
import { Sender } from './sender';
import { DayStore } from './store';

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
          sendDeadline,
          runDeadline: tick.deadlineMs,
        });
      } catch (err) {
        console.error(`[keeper] rewardDayClose chain=${chain.id} failed: ${shortErr(err)}`);
      }
    }),
  );
}

function peerReader(chains: readonly ChainConfig[], id: number, deadline: number): PeerReader | null {
  const c = chains.find((x) => x.id === id);
  if (!c) return null;
  return { diamond: c.diamond as Address, client: deadlineClient(createPublicClient({ transport: http(c.rpc) }) as PublicClient, deadline) };
}

/** One chain's run. Exported for tests. */
export async function dayCloseOnce(env: Env, chainId: number, diamond: Address, deps: DayCloseDeps): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const c: ChainRun = { chainId, diamond, deps, where: `chain=${chainId}` };
  const read = <T>(functionName: string): Promise<T> => deps.client.readContract({ address: diamond, abi: ABI, functionName, args: [] }) as Promise<T>;

  // These gate everything: a read that fails here stops the run.
  const role = Number(await read<number>('getRewardRole'));
  if (role !== ROLE_CANONICAL && role !== ROLE_MIRROR) {
    console.log(`[keeper] rewardDayClose ${c.where}: reward role ${role} is neither canonical nor mirror — nothing to close`);
    await retireChainAlerts(env, chainId, role, deps.runDeadline);
    return;
  }
  const [todayRaw, active] = await read<readonly [bigint, boolean]>('getInteractionCurrentDay');
  const today = Number(todayRaw);
  if (!active || today === 0) {
    console.log(`[keeper] rewardDayClose ${c.where}: ${active ? 'reward day 0 is still running' : 'reward clock not running'} — no elapsed day`);
    return;
  }
  if (await read<boolean>('paused')) {
    console.log(`[keeper] rewardDayClose ${c.where}: protocol paused — nothing sent, alerts left as they stand`);
    return;
  }
  const [messenger, , baseChainId, , graceSecRaw] = await read<readonly [Address, number, number, boolean, bigint]>('getRewardReporterConfig');
  const launch = Number(await read<bigint>('getInteractionLaunchTimestamp'));
  const canonical = role === ROLE_CANONICAL;
  const store = new DayStore(env, chainId, diamond);
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
    return s.known && !s.value;
  });

  const f: RunFindings = { chainId, canonical, window, refused: sender.refused, done: () => false, clock: null, base: null, mirror: null };
  let line = '';
  let closed: number[] = [];
  if (canonical) {
    closed = (await closeDays(c, store, sender, unclosed, null)).closed;
    for (const d of closed) reportedHere.set(d, known(true));
    const r = await runBase(c, store, sender, { window, ownReported: reportedHere, messenger, graceSec: Number(graceSecRaw), launch, nowSec });
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
    const r = await runMirror(c, store, sender, { window, unclosed, launch, messenger, baseChainId: Number(baseChainId) });
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
  const isDone = (step: string, d: number): boolean => {
    if (sender.landed.has(`${step}:${d}`)) return true;
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
      (sender.stopped ? ` stopped=${sender.stopReason}` : ''),
  );

  // While paused, alerts are left as they stand and nothing is posted, so no
  // day leaves the ledger: what a day is owed includes its alerts.
  if (sender.paused) {
    await store.settle(today, window, () => false);
    return;
  }
  if (f.base !== null) f.base.noticed = await postZeroedNotices(env, store, window, deps.runDeadline);
  const held = await settleAlerts(env, store, f, nowSec, deps.runDeadline);
  const through = (d: number): boolean => {
    if (held === 'all' || held.has(d)) return false;
    if (f.base !== null) return isDone('finalize', d) && isDone('broadcast', d) && f.base.noticed.has(d);
    const outcome = dayFact(f.mirror!.outcome, d);
    return isDone('close', d) && (!f.mirror!.baseServed || (outcome.known && outcome.value));
  };
  await store.settle(today, window, through);
}
