// apps/keeper/src/rewardDayClose/alerts.ts
//
// The pass's ops alerts: conditions that hold, each under its own key,
// de-duplicated, and cleared.
//
// ONE rule decides every alert's life. Each kind of alert has one judge, and
// every run asks it about every subject that matters this run: the ones the
// run found AND the ones already open. The same judgement raises, clears and
// holds, so an alert can never be raised by one rule and cleared by another:
//
//   holds     raise it (repeated at most every ALERT_REPEAT_SEC). Its day
//             stays owed while it stands, so no alert leaves with its day.
//   gone      a read has shown the condition gone: clear it.
//   unjudged  nothing this run read settles it: leave it as it stands (its
//             day stays owed).
//   retired   it can never be judged here again (the chain it is about is no
//             longer served, its record is gone): close it, and say so once.
//
// A STATEMENT (Base finalized a day without this chain; a dispatch whose
// outcome cannot be learned here) is a thing that happened, not a condition:
// said once a window, it holds its day only until delivered.
//
// Keys: `dayclose-<kind>:<chain>:<diamond>:<tenure>:<subject>`, the tenure
// being `canonical` or a mirror's toward its Base Diamond (store.ts) and the subject
// `<day>` for a day, `all` for the chain, and `<step>:<day>` for a refused
// call. An alert belongs to the Diamond and the tenure it was raised about, as
// the day ledger does: a chain repointed to another Diamond, a Diamond moved
// between canonical and mirror, or a mirror rebound to another Base or Base Diamond, starts
// afresh, and the old work's open alerts are closed with a notice rather than
// judged against the new work's same-numbered days. Another tenure's are
// closed by the chain's own run. A chain repointed to another Diamond has
// every open alert closed, with one notice naming them, by the keeper's
// deployment-epoch reset before any pass runs (keeperEpoch.ts); another
// Diamond's that remain, and a chain's no longer served, are closed by the
// run-wide sweep ({@link retireUnworkedAlerts}), which reads only the
// configuration and so is not held by the new Diamond's gate. A
// per-day alert whose day is no longer worked (out of the window and not
// owed) is cleared with it.
//
// One alert sits outside the roles: the GATE (`dayclose-gate:<chain>:
// <diamond>:all`), raised when a read every step depends on fails, or the
// chain's RPC answers for another chain, before any role's work is judged
// ({@link settleGate}). While it holds nothing else is judged or sent.

import type { Env } from '../env';
import { listOpsAlertKeys } from '../db';
import { resolveOpsAlert, sendOpsAlert, sendOpsNoticeDigest } from '../opsAlert';
import { ALERT_REPEAT_SEC, BROADCAST_RESEND_AFTER_SEC, SERVES, SERVES_ON_BASE, STATEMENT_REPEAT_SEC } from './constants';
import { shortErr } from './errors';
import type { RunFindings } from './findings';
import { topologyFaults } from './plan';
import { TENURE_PATTERN, tenureWords, type DayStore, type RoleTenure } from './store';

export type Judgement = { verdict: 'holds'; text: string; statement?: boolean } | { verdict: 'gone' } | { verdict: 'unjudged' } | { verdict: 'retired'; why: string };

const HOLDS = (text: string, statement = false): Judgement => ({ verdict: 'holds', text, statement });
const GONE: Judgement = { verdict: 'gone' };
const UNJUDGED: Judgement = { verdict: 'unjudged' };
const RETIRED = (why: string): Judgement => ({ verdict: 'retired', why });

interface AlertKind {
  kind: string;
  /** Subjects are days (`<day>`, or `<step>:<day>` for refusals); otherwise 'all'. */
  perDay: boolean;
  /** Every alert of this kind is a statement. */
  statement?: boolean;
  /** Repeat interval when it holds. */
  repeat?: number;
  /** The subjects this run's findings raise. Open subjects are added. */
  raised(f: RunFindings): string[];
  judge(f: RunFindings, subject: string, tag: string): Judgement;
}

const iso = (t: number) => new Date(t * 1000).toISOString();

const STEP_WORDS: Record<string, string> = {
  close: 'closing the day (closeDay)',
  advance: 'advancing the interest fold (advanceInterestFrontiers)',
  finalize: 'finalizing the day (finalizeDay)',
  broadcast: 'broadcasting the day (broadcastGlobal)',
  notice: "recording and announcing the chains the day's finalization zeroed",
  outcome: "learning Base's outcome for this chain's report, so the day stays owed here",
};

const KINDS: readonly AlertKind[] = [
  {
    kind: 'refused',
    perDay: true,
    raised: (f) => [...f.refused.keys()],
    judge(f, subject, tag) {
      const why = f.refused.get(subject);
      const [step, day] = subject.split(':');
      if (why !== undefined) {
        return HOLDS(`${tag}: ${STEP_WORDS[step] ?? step} for reward day ${day} is refused (${why}). The day stays open on this chain until the call goes through; the pass retries every run until it does.`);
      }
      // Over once the step is no longer owed: done, or what it serves done.
      const serves = f.canonical ? SERVES_ON_BASE : SERVES;
      for (let s: string | undefined = step; s !== undefined; s = serves[s]) if (f.done(`${s}:${day}`)) return GONE;
      return UNJUDGED;
    },
  },
  {
    kind: 'waiting',
    perDay: true,
    raised: (f) => [...(f.base?.waiting.keys() ?? [])].map(String),
    judge(f, subject, tag) {
      const b = f.base;
      const day = Number(subject);
      if (b === null || b.finalized.has(day)) return GONE;
      const w = b.waiting.get(day);
      // Judged and not near its end with a chain missing: grace was
      // lengthened, or the report landed.
      if (w === undefined) return b.judged.has(day) ? GONE : UNJUDGED;
      const each = w.missing
        .map((c) => {
          const s = w.sent.get(c);
          if (!s?.known) return `chain ${c} (${s?.why === 'not served by this keeper' ? 'not served by this keeper' : 'its own record could not be read'}: whether it sent is unknown)`;
          if (s.value === 0) return `chain ${c} (has not sent its report)`;
          return `chain ${c} (sent at ${iso(s.value)}, not yet landed on Base)`;
        })
        .join('; ');
      const unread = w.unknown.length > 0 ? `; Base's record of the report could not be read this run for chain(s) ${w.unknown.join(', ')}` : '';
      const ends = w.graceEndsAt === null ? 'unknown' : iso(w.graceEndsAt);
      const hold = b.finalizeHold === null ? '' : ` This keeper finalizes no day while ${b.finalizeHold}; any other caller still can.`;
      return HOLDS(
        `${tag}: reward day ${day} ` +
          (w.missing.length > 0 ? `is still missing ${w.missing.length} expected report(s): ${each}` : 'has no expected report Base shows as missing') +
          `${unread}. Grace ends ${ends}; from then the day can be finalized with the reports that have landed, and each expected chain still missing then counts as zero for the day.${hold}`,
      );
    },
  },
  {
    kind: 'broadcast',
    perDay: true,
    raised: (f) => [...(f.base?.broadcast ?? [])].filter(([, p]) => p.late.length > 0).map(([d]) => String(d)),
    judge(f, subject, tag) {
      if (f.base === null) return GONE;
      const day = Number(subject);
      const plan = f.base.broadcast.get(day);
      if (plan === undefined) return UNJUDGED;
      if (plan.late.length > 0) {
        const each = (state: 'missing' | 'unread') =>
          plan.late
            .filter((x) => x.state === state)
            .map((x) => `chain ${x.chain} (last sent ${iso(x.sentAt)}, or sent then with no receipt seen)`)
            .join(', ');
        const missing = each('missing');
        const unread = each('unread');
        return HOLDS(
          `${tag}: the broadcast of reward day ${day} ` +
            [missing ? `has not reached ${missing}` : '', unread ? `could not be confirmed on ${unread}, whose state this keeper could not read, so whether it arrived there is unknown` : '']
              .filter(Boolean)
              .join('; and it ') +
            `. Until it lands, users there cannot claim that day. The pass re-sends to a chain it reads as missing ${BROADCAST_RESEND_AFTER_SEC / 3600}h after each send to it, and this alert stands until every such chain is read holding the day; check the lane's CCIP delivery and the keeper's RPC for that chain.`,
        );
      }
      if (plan.done && plan.unconfirmed.length === 0) return GONE;
      if (plan.done) {
        return RETIRED(
          `the day was sent to chain(s) ${plan.unconfirmed.join(', ')}, which this keeper no longer serves, so whether it arrived there cannot be read here; check those chains directly`,
        );
      }
      return UNJUDGED;
    },
  },
  {
    kind: 'excluded',
    perDay: true,
    statement: true,
    repeat: STATEMENT_REPEAT_SEC,
    raised: (f) => [...(f.mirror?.excluded ?? [])].filter(([, x]) => x.known && x.value).map(([d]) => String(d)),
    judge(f, subject, tag) {
      const x = f.mirror?.excluded.get(Number(subject));
      if (f.mirror === null) return GONE;
      if (x === undefined || !x.known) return UNJUDGED;
      if (!x.value) return GONE;
      if (f.mirror.landedNotCounted.has(Number(subject))) {
        return HOLDS(
          `${tag}: Base finalized reward day ${subject} without counting this chain's report, although the report had landed: this chain was not on Base's expected-source list when the day finalized. Its interest counts as zero for that day; the chain-wide figures the report carried still applied.`,
          true,
        );
      }
      return HOLDS(
        `${tag}: Base finalized reward day ${subject} without this chain's report, so this chain's interest counts as zero for that day. The report is still sent (or was): Base drops its day figures but applies the chain-wide figures it carries.`,
        true,
      );
    },
  },
  {
    kind: 'dispatch',
    perDay: true,
    repeat: ALERT_REPEAT_SEC,
    raised: (f) => [...(f.mirror?.dispatched.keys() ?? [])].map(String),
    judge(f, subject, tag) {
      const m = f.mirror;
      if (m === null) return GONE;
      const day = Number(subject);
      const outcome = m.outcome.get(day);
      if (outcome?.known && outcome.value) return GONE;
      const rec = m.dispatched.get(day);
      if (rec === undefined) return RETIRED("this keeper's record of the dispatch is gone, so it can no longer be followed here");
      const via = rec.via.length > 0 ? `messenger ${rec.via.join(', ')}` : 'no messenger this keeper could see (the receipt carries no report event)';
      const head =
        `${tag}: the close of reward day ${day} sent its report through ${via}, not the reward messenger this run checked (${rec.checked}); it was rotated between the check and the transaction. ` +
        'The contract held its route to Base and its shape (#2621), but whether Base\'s end accepts reports from that messenger was not checked, and the day cannot be closed again. If it never reaches Base, or Base finalizes the day before it lands, this chain\'s interest counts as zero for the day.';
      // A dispatch is recorded only by a close, which only a tenure that
      // serves Base makes (store.ts), so its outcome is always learnable here;
      // a Base no longer served is another tenure, which retires this alert.
      return HOLDS(`${head} This alert stands until Base records the day's outcome.`);
    },
  },
  {
    kind: 'noexpected',
    perDay: false,
    raised: () => ['all'],
    judge(f, _s, tag) {
      const b = f.base;
      if (b === null) return GONE;
      if (!b.expected.known) return UNJUDGED;
      if (b.expected.value.length > 0) return GONE;
      return HOLDS(
        `${tag}: Base's expected-source list is empty, so no day is finalized: a day finalized against an empty list sums no chain and finalizes as zero, irreversibly. Set the list (setExpectedSourceChainIds) before rewards can be finalized.`,
      );
    },
  },
  {
    kind: 'selfmissing',
    perDay: false,
    raised: () => ['all'],
    judge(f, _s, tag) {
      const b = f.base;
      if (b === null) return GONE;
      if (!b.expected.known) return UNJUDGED;
      if (b.expected.value.length === 0 || b.expected.value.includes(f.chainId)) return GONE;
      return HOLDS(
        `${tag}: this chain is not on its own expected-source list. Finalization sums only the listed chains, so this chain's own interest is left out of every day's global total while its users' shares are still worked out against it; and its own report still counts toward the contract's report count. Add it (setExpectedSourceChainIds). Until it is added, the pass finalizes no day: a day finalized now would leave this chain's interest out of its total for good.`,
      );
    },
  },
  {
    kind: 'topology',
    perDay: false,
    raised: () => ['all'],
    judge(f, _s, tag) {
      const b = f.base;
      if (b === null) return GONE;
      if (b.topology === null) return UNJUDGED;
      const faults = topologyFaults(b.topology, f.chainId);
      if (faults.length === 0) return GONE;
      return HOLDS(
        `${tag}: Base's expected-source list and the reward messenger's broadcast destinations do not line up: ${faults.join('; ')}. Make each mirror appear once on both lists, and Base on the expected-source list only (setExpectedSourceChainIds on the Diamond, setBroadcastDestinations on the messenger).`,
      );
    },
  },
  {
    // Every hold on an irreversible or user-facing step is said here, whatever
    // its cause, read from the same value that holds the step. The alerts
    // naming a cause (clock, wire) say what to fix; this one says what is
    // held, so no hold can be silent, including one with no alert of its own.
    kind: 'held',
    perDay: false,
    raised: () => ['all'],
    judge(f, _s, tag) {
      const parts: string[] = [];
      if (f.base !== null) {
        if (f.base.finalizeHold !== null) parts.push(`finalizes no reward day while ${f.base.finalizeHold} (finalizing is irreversible; any other caller still can)`);
        if (f.base.broadcastHold !== null) parts.push(`broadcasts no finalized day while ${f.base.broadcastHold}, so users on the mirrors cannot claim those days yet`);
      } else if (f.mirror !== null) {
        if (f.mirror.closeHold !== null) parts.push(`closes no reward day while ${f.mirror.closeHold} (a report is sent once and cannot be recalled)`);
      } else return UNJUDGED;
      // Days a failed read kept from being worked this run, by step.
      const byStep = new Map<string, string[]>();
      for (const [k, what] of [...f.unread].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))) {
        const [step, day] = k.split(':');
        byStep.set(step, [...(byStep.get(step) ?? []), `day ${day} (${what} could not be read)`]);
      }
      for (const [step, days] of byStep) parts.push(`did not try ${STEP_WORDS[step] ?? step} this run for ${days.join(', ')}`);
      // A run that stopped sending on a fault that repeats: until a run sends
      // without it, whatever it would have sent stays owed.
      if (f.stall !== null) parts.push(`stopped sending this run: ${f.stall}`);
      // A peer read as unreadable holds whatever waits on it; say why.
      for (const [chain, why] of [...f.unattested].sort(([a], [b]) => a - b)) parts.push(`read chain ${chain} as unreadable this run, because ${why}`);
      if (parts.length === 0) return GONE;
      return HOLDS(
        `${tag}: this keeper ${parts.join('; and it ')}. Each step resumes on the first run that reads what it waits on as safe. Any alert naming a cause says what to fix; an unread value usually means the keeper's RPC for that chain failed, or the contract does not answer that read.`,
      );
    },
  },
  {
    kind: 'notexpected',
    perDay: false,
    raised: () => ['all'],
    judge(f, _s, tag) {
      const m = f.mirror;
      if (m === null) return GONE;
      if (m.notExpectedOnBase === 'unserved') return RETIRED("this keeper no longer serves Base, so Base's expected-source list cannot be read here");
      if (!m.notExpectedOnBase.known) return UNJUDGED;
      if (!m.notExpectedOnBase.value) return GONE;
      return HOLDS(
        `${tag}: this chain is not on Base's expected-source list, so its interest counts toward no day Base finalizes while it stays off. What else follows depends on Base's build, which this keeper does not read. A Base built with #2618 still takes each report: the chain-wide figures it carries (its custody era, and its recycled-availability and commitment ratchets) apply, and its day figures are stored and count if the chain is listed again before that day finalizes. A Base built before #2618 refuses every report (SourceChainIdNotExpected), so those chain-wide figures do not reach it either and commitments this chain has retired stay outstanding there; CCIP records each refused report as a failed message, which can be executed again by hand once the chain is back on the list, and a chain being detached should stay listed until its last report has landed. The pass still closes each day here.`,
      );
    },
  },
  {
    kind: 'clock',
    perDay: false,
    raised: () => ['all'],
    judge(f, _s, tag) {
      const c = f.clock;
      if (c === null) return UNJUDGED;
      if (c.differ.length === 0) return c.unknown.length === 0 && !c.stale ? GONE : UNJUDGED;
      const base = c.base === null ? 'unknown' : iso(c.base);
      if (f.canonical) {
        const each = c.differ.map((x) => `chain ${x.chain} (day 0 starts ${iso(x.launch)}${x.lastRead ? ', as last read; this run could not read it' : ''})`).join(', ');
        return HOLDS(
          `${tag}: ${each} run(s) a reward clock different from Base's (day 0 starts ${base}), so the same day number covers different hours there and here. A day finalized with such a report sums unrelated interest into one global total, irreversibly, so the pass finalizes no day until every listed chain runs Base's clock. Days already finalized are still broadcast.`,
        );
      }
      return HOLDS(
        `${tag}: this chain's reward clock (day 0 starts ${iso(c.differ[0].launch)}) differs from Base's (day 0 starts ${base}${c.stale ? ', as last read; this run could not read it' : ''}), so the same day number covers different hours here and on Base. A report sent now would be summed into Base's day with interest from other hours, irreversibly, so the pass closes no day here until the two match.`,
      );
    },
  },
  {
    kind: 'clockunknown',
    perDay: false,
    raised: () => ['all'],
    judge(f, _s, tag) {
      const c = f.clock;
      if (c === null) return UNJUDGED;
      if (c.unknown.length === 0) return GONE;
      const each = c.unknown.map((x) => `chain ${x.chain} (${x.why})`).join('; ');
      return HOLDS(
        `${tag}: the reward clock of ${each} is not known to this keeper. A day number must cover the same hours on every chain, or interest from different hours is summed into one day irreversibly, so the pass ${f.canonical ? 'finalizes' : 'closes'} no day until that clock is read. Serve that chain's RPC to this keeper, or check its Diamond.`,
      );
    },
  },
  {
    kind: 'wire',
    perDay: false,
    raised: () => ['all'],
    judge(f, _s, tag) {
      const m = f.mirror;
      if (m === null) return GONE;
      if (m.wire.known && m.wire.value.length === 0) return GONE;
      const after =
        'A report is sent once and stamped sent here for good, its fee paid, and one the receiving end refuses is a failed CCIP message on Base until the wiring is fixed and it is executed again by hand; a day Base finalizes before then counts this chain as zero. So the pass closes no day here until every link of the channel reads as wired.';
      return HOLDS(
        !m.wire.known
          ? `${tag}: whether a report from this chain would be accepted on Base (chain ${m.baseChainId}, as this Diamond names it) is unknown: ${m.wire.why}. ${after}`
          : `${tag}: a report from this chain would not be accepted on Base (chain ${m.baseChainId}, as this Diamond names it): ${m.wire.value.join('; ')}. ${after}`,
      );
    },
  },
];

const BY_KIND = new Map(KINDS.map((k) => [k.kind, k]));

// `mirror` alone: keys written before a mirror's tenure named its Base.
const KEY_PATTERN = new RegExp(`^dayclose-([a-z]+):(\\d+):(?:(0x[0-9a-f]{40}):(?:(${TENURE_PATTERN}|mirror):)?)?(.+)$`);

/** An open key's parts, or null when it is not one of this chain's. The
 *  Diamond, and the role, are null on a key that names none. */
function parseKey(key: string, chainId: number): { kind: string; diamond: string | null; role: string | null; subject: string } | null {
  const m = KEY_PATTERN.exec(key);
  if (m === null || Number(m[2]) !== chainId) return null;
  return { kind: m[1], diamond: m[3] ?? null, role: m[4] ?? null, subject: m[5] };
}

function keyOf(kind: string, chainId: number, diamond: string, role: RoleTenure, subject: string): string {
  return `dayclose-${kind}:${chainId}:${diamond}:${role}:${subject}`;
}

const GATE = 'gate';
const gateKey = (chainId: number, diamond: string) => `dayclose-${GATE}:${chainId}:${diamond.toLowerCase()}:all`;

/** The day a per-day subject names (`<day>` or `<step>:<day>`). */
function dayOf(subject: string): number | null {
  const d = Number(subject.split(':').at(-1));
  return Number.isSafeInteger(d) && d >= 0 ? d : null;
}

/** What became of the run's alerts: the days they hold owed, or 'all' when
 *  the open alerts could not be read and nothing could be judged. */
export type AlertsHeld = Set<number> | 'all';

/**
 * Judge every alert for one chain, raise and clear accordingly, and return
 * the days the alerts hold: every day an alert still stands on, and every day
 * whose due alert this run did not deliver (the deadline came first, or the
 * post failed or was refused). Such a day stays owed, so an alert is never
 * lost with a day leaving the ledger. A statement holds its day only until
 * it is delivered.
 */
export async function settleAlerts(env: Env, store: DayStore, f: RunFindings, nowSec: number, deadline: number): Promise<AlertsHeld> {
  const chainId = f.chainId;
  let openKeys: string[];
  try {
    openKeys = await listOpsAlertKeys(env.KEEPER_DB, 'dayclose-', chainId);
  } catch (err) {
    console.error(`[keeper] rewardDayClose chain=${chainId}: open alerts unread, alerts left for the next run: ${shortErr(err)}`);
    return 'all';
  }
  const diamond = store.diamond.toLowerCase();
  const role = store.role;
  const open = new Map<string, { kind: string; subject: string }>();
  // Another tenure's alerts cannot be judged from this work's reads. Another
  // Diamond's are not this run's to judge or close: they are closed for every
  // served chain, gate or no gate, by {@link retireUnworkedAlerts}.
  const foreign: { key: string; why: string; day: null }[] = [];
  for (const k of openKeys) {
    const p = parseKey(k, chainId);
    if (p === null || p.diamond !== diamond || p.kind === GATE) continue; // the sweep's, or settleGate's
    if (p.role === role) open.set(k, p);
    else
      foreign.push({
        key: k,
        why:
          p.role === null
            ? 'it names no reward role, so it cannot be judged against the role this Diamond reads now'
            : `it is about this Diamond's work as ${tenureWords(p.role)}, and the Diamond now works as ${tenureWords(role)}, whose days this keeper works afresh; what that work left owed is no longer done here, so check those days on the Diamond directly`,
        day: null,
      });
  }
  const inWindow = new Set(f.window);
  const outside = [...new Set([...open.values()].filter((p) => BY_KIND.get(p.kind)?.perDay).map((p) => dayOf(p.subject)).filter((d): d is number => d !== null && !inWindow.has(d)))];
  let owed: Set<number>;
  try {
    owed = await store.owedAmong(outside);
  } catch (err) {
    console.error(`[keeper] rewardDayClose chain=${chainId}: owed days unread, their alerts left for the next run: ${shortErr(err)}`);
    owed = new Set(outside);
  }

  const tag = `[chain ${chainId}] reward day close`;
  const held = new Set<number>();
  const retire: { key: string; why: string; day: number | null }[] = [...foreign];
  const hold = (d: number | null) => {
    if (d !== null) held.add(d);
  };

  for (const k of KINDS) {
    const subjects = new Set(k.perDay ? k.raised(f) : ['all']);
    for (const p of open.values()) if (p.kind === k.kind) subjects.add(p.subject);
    for (const subject of subjects) {
      const key = keyOf(k.kind, chainId, diamond, role, subject);
      const isOpen = open.has(key);
      const day = k.perDay ? dayOf(subject) : null;
      let j: Judgement;
      if (day !== null && !inWindow.has(day)) j = owed.has(day) ? UNJUDGED : GONE; // a day no longer worked takes its alerts with it
      else j = k.judge(f, subject, tag);

      if (j.verdict === 'holds') {
        // eslint-disable-next-line no-await-in-loop
        const outcome = Date.now() >= deadline ? 'deadline' : await sendOpsAlert(env, key, j.text, k.repeat ?? ALERT_REPEAT_SEC, nowSec, chainId);
        // 'suppressed' was delivered before; 'unconfigured' is journaled.
        const delivered = outcome === 'sent' || outcome === 'suppressed' || outcome === 'unconfigured';
        if (!delivered || !(j.statement || k.statement)) hold(day);
      } else if (j.verdict === 'gone') {
        if (!isOpen) continue;
        if (Date.now() >= deadline) hold(day);
        // eslint-disable-next-line no-await-in-loop
        else await resolveOpsAlert(env, key);
      } else if (j.verdict === 'unjudged') {
        if (isOpen && !k.statement) hold(day);
      } else if (isOpen) {
        retire.push({ key, why: j.why, day });
      }
    }
  }
  // An open alert of a kind this pass no longer raises cannot be judged.
  for (const [key, p] of open) {
    if (!BY_KIND.has(p.kind)) retire.push({ key, why: 'this pass no longer raises this alert', day: null });
  }
  if (retire.length > 0) {
    const ok = await closeWithNotice(
      env,
      chainId,
      retire,
      `${tag}: alerts closed, no longer judged here`,
      'Each condition below can no longer be judged by this keeper, so it is no longer retried or watched here. What it named may still hold; the reason says where to look.',
      Date.now() >= deadline,
    );
    if (!ok) for (const r of retire) hold(r.day);
  }
  return held;
}

/** Close `items` (open alerts), telling the ops channel which and why. Closed
 *  only once said: a notice that did not go out is tried next run. Returns
 *  whether they were closed. */
export async function closeWithNotice(env: Env, chainId: number, items: readonly { key: string; why: string }[], header: string, footer: string, pastDeadline: boolean, logPrefix = ''): Promise<boolean> {
  if (pastDeadline) return false;
  const lines = items.map((i) => `closed: ${i.key} (${i.why})`);
  for (const l of lines) console.log(`[keeper] rewardDayClose chain=${chainId}: ${logPrefix}${l}`);
  const outcome = await sendOpsNoticeDigest(env, header, lines, footer, chainId);
  if (outcome !== 'sent' && outcome !== 'unconfigured') return false;
  for (const i of items) {
    // eslint-disable-next-line no-await-in-loop
    await resolveOpsAlert(env, i.key);
  }
  return true;
}

/**
 * A chain that has left the reward set (its role is neither canonical nor
 * mirror) is no longer worked, so nothing the pass said about it is still
 * retried or watched. Its open alerts are closed, and the ops channel told
 * once which and why. Should the chain rejoin, a run judges it afresh.
 */
export async function retireChainAlerts(env: Env, chainId: number, role: number, deadline: number): Promise<void> {
  let open: string[];
  try {
    open = (await listOpsAlertKeys(env.KEEPER_DB, 'dayclose-', chainId)).filter((k) => parseKey(k, chainId) !== null).sort();
  } catch (err) {
    console.error(`[keeper] rewardDayClose chain=${chainId}: open alerts unread, left for the next run: ${shortErr(err)}`);
    return;
  }
  if (open.length === 0) return;
  await closeWithNotice(
    env,
    chainId,
    open.map((key) => ({ key, why: `the chain left the reward set (role ${role})` })),
    `[chain ${chainId}] reward day close: chain left the reward set (role ${role}), its alerts closed`,
    'This chain is neither the canonical reward chain nor a mirror, so the pass no longer closes, finalizes or broadcasts its days, and the conditions these alerts named are no longer retried or watched. If the chain rejoins, the pass judges it afresh.',
    Date.now() >= deadline,
    `reward role ${role}, `,
  );
}

/**
 * Alerts no run can judge, closed once per run over every configured chain,
 * whatever any chain's gate read: a chain this keeper no longer serves (its
 * RPC or deployment is no longer configured) is never run, and a chain
 * repointed to another Diamond judges only the Diamond it names now, so
 * neither {@link settleAlerts} nor {@link settleGate} reaches the old one's
 * alerts (its gate alert included). `served` maps each served chain to the
 * Diamond it is configured with. The ops channel is told, per chain, which
 * alerts and why. Should a chain, or a Diamond, be worked again, a run judges
 * it afresh.
 */
export async function retireUnworkedAlerts(env: Env, served: ReadonlyMap<number, string>, deadline: number): Promise<void> {
  let keys: string[];
  try {
    keys = await listOpsAlertKeys(env.KEEPER_DB, 'dayclose-');
  } catch (err) {
    console.error(`[keeper] rewardDayClose: open alerts unread, unworked alerts left for the next run: ${shortErr(err)}`);
    return;
  }
  const byChain = new Map<number, { key: string; why: string }[]>();
  for (const k of keys) {
    const m = /^dayclose-[a-z]+:(\d+):/.exec(k);
    if (m === null) continue;
    const chain = Number(m[1]);
    const configured = served.get(chain)?.toLowerCase();
    let why: string | null = null;
    if (configured === undefined) why = 'this keeper no longer serves the chain';
    else {
      const p = parseKey(k, chain);
      if (p === null) continue;
      if (p.diamond === null) why = 'it names no Diamond, so it cannot be judged against the one this chain names now';
      else if (p.diamond !== configured) why = `it is about Diamond ${p.diamond}, and this chain now names Diamond ${configured}, whose days this keeper works afresh; check the old Diamond directly`;
    }
    if (why !== null) byChain.set(chain, [...(byChain.get(chain) ?? []), { key: k, why }]);
  }
  for (const [chain, items] of [...byChain].sort(([a], [b]) => a - b)) {
    const unserved = !served.has(chain);
    // eslint-disable-next-line no-await-in-loop
    await closeWithNotice(
      env,
      chain,
      items.sort((a, b) => a.key.localeCompare(b.key)),
      unserved
        ? `[chain ${chain}] reward day close: chain no longer served by this keeper, its alerts closed`
        : `[chain ${chain}] reward day close: alerts about a Diamond this chain no longer names, closed`,
      unserved
        ? "This keeper has no RPC or deployment configured for this chain any more, so the pass no longer works its days, and the conditions these alerts named are no longer retried or watched here. What they named may still hold; check the chain directly. If it is served again, the pass judges it afresh."
        : 'This chain is configured with another Diamond now, so the pass works only that one, and the conditions these alerts named about the old one are no longer retried or watched here. What they named may still hold there; check the old Diamond directly. If it is configured again, the pass judges it afresh.',
      Date.now() >= deadline,
      unserved ? 'unserved, ' : 'old Diamond, ',
    );
  }
}

/**
 * The gate: whether the reads every step depends on (the chain's reward role,
 * its reward day, the pause, its reporter config and its reward clock) came
 * back, and the chain's RPC answers for this chain. `failed` is why not (null
 * = all read, and the chain is the one configured). While it holds, nothing on
 * the chain is sent or judged, so the alert is the one record that the chain
 * is not being worked; it clears on the first run that reads them all.
 */
export async function settleGate(env: Env, chainId: number, diamond: string, failed: string | null, nowSec: number, deadline: number): Promise<void> {
  const key = gateKey(chainId, diamond);
  try {
    if (failed === null) {
      if (Date.now() < deadline) await resolveOpsAlert(env, key);
      return;
    }
    if (Date.now() >= deadline) return;
    await sendOpsAlert(
      env,
      key,
      `[chain ${chainId}] reward day close: this keeper is not working this chain's reward days: ${failed}. Nothing is closed, finalized or broadcast here, and no other alert about the chain is judged, until a run reads them. An unread value usually means the keeper's RPC for this chain failed, or the contract does not answer that read.`,
      ALERT_REPEAT_SEC,
      nowSec,
      chainId,
    );
  } catch (err) {
    console.error(`[keeper] rewardDayClose chain=${chainId}: gate alert not settled, tried next run: ${shortErr(err)}`);
  }
}
