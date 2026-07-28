/**
 * Tick orchestration: read the mesh, evaluate both tiers, deliver what is
 * due, persist what the windowed signals need next time.
 */

import { assertAbiShape } from './abi';
import { deploymentFor } from './chains';
import { deliverFindings } from './deliver';
import { classify, describeFailure } from './errors';
import { hashIdentity, makeFinding } from './finding';
import { assessHealth } from './health';
import { stepSignal, type Observation } from './signal';
import { AlertStore, type StoreOp } from './store';
import {
  readAlertRepeatSeconds,
  readConfig,
  readTelegramTarget,
  type Env,
} from './env';
import {
  checkHardInvariants,
  fmt,
  lagPairs,
  lagLabels,
  reportLagConditions,
  stuckSettlementCondition,
  type Finding,
  type StreakState,
} from './invariants';
import { observeMesh } from './mesh';
import { makeBaseRedactor } from './redact';
import { formatAlert, sendOpsMessage } from './telegram';

const STUCK_SIGNAL = 'stuck-settlement';
const REPORT_LAG_SIGNAL = 'report-lag';

/**
 * Why the stuck-settlement advisory is not a pager, restated in every
 * alert so the operator does not have to remember it.
 */
const STUCK_CAVEAT =
  'ADVISORY — this condition is NECESSARY but NOT SUFFICIENT. A chain with no claims, forfeits or expiries falling due in the window satisfies it legitimately: commitments stay reserved until a user or horizon event retires them. The settlement-EXPECTED qualifier that would make this pageable is open design work on vaipakam#1442. Treat as a prompt to look, not as evidence of a fault.';

export interface TickSummary {
  ok: boolean;
  /**
   * Whether an alert DESTINATION is configured.
   *
   * Surfaced because alert delivery is the whole point of the Worker: a
   * tick that found nothing and a tick whose findings went into transient
   * Worker logs look identical otherwise, so the documented post-deploy
   * `POST /run` check could not tell a working pager from one that will
   * discard every future alert (Codex #1443 r3). A tick is never `ok`
   * while this is false.
   */
  deliveryConfigured: boolean;
  /**
   * Whether delivery was actually EXERCISED and succeeded this tick.
   *
   * `deliveryConfigured` only says a token and chat id are present —
   * nonempty but invalid credentials, or a wrong chat id, still read as
   * configured, and a healthy tick with no findings never calls Telegram
   * at all. The documented post-deploy check would then certify a pager
   * that cannot deliver (Codex #1443 r4). `POST /run` therefore sends a
   * probe, so a green verification means a message actually landed.
   * `null` on cron ticks that had nothing to send.
   */
  deliveryVerified: boolean | null;
  /** Sends attempted this tick that Telegram rejected. */
  deliveryFailures: number;
  /** Any alert-state read or write failed — see `deliver.ts` rule 4. */
  stateDegraded: boolean;
  /** Which health preconditions failed. Empty when `ok`. */
  unhealthyBecause: string[];
  chainsObserved: number;
  critical: number;
  advisory: number;
  coverageGaps: number;
  sent: number;
  findings: { severity: string; code: string; chainId: number; title: string }[];
  error?: string;
}

/** Translate a signal transition into a store operation, if any. */
function pushStreak(
  into: StoreOp[],
  signal: string,
  chainId: number,
  transition: { action: 'save'; state: StreakState } | { action: 'clear' } | { action: 'keep' },
  at: number,
): void {
  if (transition.action === 'save') {
    into.push({ kind: 'saveStreak', signal, chainId, state: transition.state, at });
  } else if (transition.action === 'clear') {
    into.push({ kind: 'clearStreak', signal, chainId });
  }
  // 'keep' — deliberately no write.
}

function chainLabel(chainId: number): string {
  const row = deploymentFor(chainId);
  return row ? `${row.chainSlug} (${chainId})` : `chain ${chainId}`;
}

/** Run one full tick. Never throws — failures surface as the summary's
 *  `error` plus an infrastructure alert, because a thrown scheduled
 *  handler is invisible outside the Cloudflare logs. */
export async function runTick(
  env: Env,
  options: { probeDelivery?: boolean; persistState?: boolean } = {},
): Promise<TickSummary> {
  // Manual `POST /run` reads the windowed state but never ADVANCES it.
  // The 6- and 130-tick windows are denominated in CRON observations, so
  // an operator running the endpoint a few times — during a delivery
  // outage, say — could otherwise manufacture a stuck-settlement
  // advisory advertised as 1.5 hours of stasis (Codex #1443 r6).
  const persistState = options.persistState ?? true;
  const now = Math.floor(Date.now() / 1000);
  let deliveryFailures = 0;
  let deliveryVerified: boolean | null = null;

  try {
    // Fail before any read if the compiled ABI no longer matches what the
    // readers assume — a mislabelled ledger figure would otherwise be
    // checked against the wrong invariant and reported as healthy.
    assertAbiShape();

    const config = readConfig(env);
    const obs = await observeMesh(env, config);

    const findings: Finding[] = checkHardInvariants(
      obs,
      config.bucketCoverageToleranceWei,
    );

    // ── Windowed advisories ──────────────────────────────────────────
    //
    // D1 FAILS OPEN. The hard invariants above are already computed and
    // stateless — a database outage must not discard a real ledger
    // violation whose complete evidence we already hold (Codex #1443 r5).
    // A failed load means the windowed advisories are skipped this tick
    // (their runs restart, which only delays them), the dedup layer is
    // bypassed so criticals go out unsuppressed, and the outage is
    // reported as its own critical finding.
    const store = new AlertStore(env.DB);
    let stuckPrior = new Map<number, StreakState>();
    const lagPrior = new Map<string, StreakState>();
    let stateAvailable = true;

    const loaded = await Promise.all([
      store.loadStreaks(STUCK_SIGNAL),
      ...lagLabels.map((l) => store.loadStreaks(`${REPORT_LAG_SIGNAL}/${l}`)),
    ]);
    const firstFailure = loaded.find((r) => !r.ok);
    if (firstFailure && !firstFailure.ok) {
      stateAvailable = false;
      findings.push(
        makeFinding({
          code: 'watcher-state-unavailable',
          variant: 'load',
          identity: [firstFailure.failure.kind],
          severity: 'critical',
          chainId: 0,
          title: 'Alert state database unreachable',
          detail:
            `The streak/dedup database could not be read, so the windowed advisories are NOT being evaluated this tick and repeat-suppression is bypassed.\n` +
            `Any hard ledger findings in this batch were computed BEFORE the failure and are still valid.\n\n` +
            describeFailure(firstFailure.failure),
        }),
      );
    } else {
      const first = loaded[0];
      if (first?.ok) stuckPrior = first.value;
      lagLabels.forEach((label, i) => {
        const r = loaded[i + 1];
        if (!r?.ok) return;
        for (const [chainId, st] of r.value) lagPrior.set(`${chainId}/${label}`, st);
      });
    }

    const streakWrites: StoreOp[] = [];

    for (const books of stateAvailable ? obs.books : []) {
      // Base's own books are inert by construction, so neither windowed
      // signal has a meaning there — `base-self-inert` is what guards
      // that chain id.
      if (books.chainId === obs.canonicalChainId) continue;

      const local = obs.freshLocals.get(books.chainId);

      const stuck = stuckSettlementCondition(books, local);
      const stuckObs: Observation = stuck.holds
        ? { state: 'holds', marker: stuck.marker }
        : { state: 'clear' };
      const stuckOutcome = stepSignal(
        stuckPrior.get(books.chainId) ?? null,
        stuckObs,
        // Base-only observations move solely through day-close reports,
        // so they are judged on the report-cycle window — the short one
        // would fire once per cycle on a healthy chain.
        stuck.windowKind === 'local'
          ? config.stuckWindowTicks
          : config.reportLagWindowTicks,
        persistState,
      );
      pushStreak(streakWrites, STUCK_SIGNAL, books.chainId, stuckOutcome.transition, now);
      if (stuckOutcome.fire) {
        findings.push(makeFinding({
          code: STUCK_SIGNAL,
          variant: stuck.source,
          severity: 'advisory',
          chainId: books.chainId,
          title: 'Recycled commitments outstanding with no retirement',
          // The FIGURES THE BODY SHOWS — never the observation count,
          // which rises every tick and would defeat the quiet window.
          identity: [
            local ? local.outstandingRecycled : books.outstanding,
            local ? local.localRetired : books.retired,
            books.released,
            books.avail,
            local ? local.bucket : 0n,
          ],
          detail:
            `outstanding > 0 and retirement flat across the window\n` +
            `  outstanding       = ${fmt(local ? local.outstandingRecycled : books.outstanding)}\n` +
            `  retired (${stuck.source === 'chain' ? "chain's own" : 'base copy'})  = ${fmt(local ? local.localRetired : books.retired)}\n` +
            `  released          = ${fmt(books.released)}\n` +
            `  availability      = ${fmt(books.avail)}\n` +
            (local
              ? `  chain bucket      = ${fmt(local.bucket)}\n`
              : `  (chain unreachable this tick — retirement read from Base's copy, which also moves only when a report lands)\n`),
        }));
      }

      // One run PER CUMULATIVE. A single combined run reset every time an
      // unrelated field advanced, so a permanently-stuck one never fired.
      // With no local snapshot the lag conditions are UNKNOWN, not
      // false — and clearing a run on an unknown observation lets
      // intermittent RPC gaps erase up to 32.5 hours of valid evidence
      // repeatedly (Codex #1443 r7). Both sides are monotonic, so the
      // next real observation decides whether the run continues.
      const lagObservable = local !== undefined;
      const firing = reportLagConditions(books, local).filter((c) => {
        // No local snapshot ⇒ UNKNOWN, not false. `stepSignal` keeps the
        // run rather than erasing it — see `signal.ts`.
        const obs: Observation = !lagObservable
          ? { state: 'unknown' }
          : c.holds
            ? { state: 'holds', marker: c.marker }
            : { state: 'clear' };
        const outcome = stepSignal(
          lagPrior.get(`${books.chainId}/${c.label}`) ?? null,
          obs,
          config.reportLagWindowTicks,
          persistState,
        );
        pushStreak(
          streakWrites,
          `${REPORT_LAG_SIGNAL}/${c.label}`,
          books.chainId,
          outcome.transition,
          now,
        );
        return outcome.fire;
      });

      if (firing.length > 0 && local) {
        findings.push(makeFinding({
          code: REPORT_LAG_SIGNAL,
          variant: firing.map((c) => c.label).join('+'),
          identity: [
            books.reported, books.retired, books.released,
            local.reportedCumulative, local.localRetired, local.localReleased,
          ],
          severity: 'advisory',
          chainId: books.chainId,
          title: 'Base has not accepted a newer report from this chain',
          // Figures only, for the same reason as the stuck signal above.
          // Every pair a day-close report carries, each marked with
          // whether it is the one lagging. Showing absorption alone
          // printed `behind by = 0` whenever retirement or release was
          // what actually triggered the advisory — omitting the only
          // evidence of the lag (Codex #1443 r2).
          detail:
            `Frozen and behind for the full window: ${firing.map((c) => c.label).join(', ')}\n` +
            lagPairs(books, local)
              .map(
                (p) =>
                  `  ${p.behind ? 'BEHIND' : '  ok  '} ${p.label.padEnd(11)} base = ${fmt(p.base)} | chain = ${fmt(p.chain)}` +
                  (p.behind ? `\n           behind by = ${fmt(p.chain - p.base)}` : ''),
              )
              .join('\n'),
        }));
      }
    }

    // ── Coverage gaps ────────────────────────────────────────────────
    // Always surfaced. A watcher that quietly narrows its scope reports
    // "all clear" for chains it never looked at.
    for (const gap of obs.gaps) {
      findings.push(makeFinding({
        code: 'coverage-gap',
        // Reason AND source: one chain can fail both its Base-side and
        // its own-ledger read in a tick, and both are `no-rpc`.
        variant: `${gap.reason}/${gap.source}`,
        // NOT the detail — a stale-head detail carries an age that rises
        // every tick and would defeat the quiet window (#1443 r8).
        identity: [gap.reason, gap.source],
        severity: 'advisory',
        chainId: gap.chainId,
        title: 'Chain not covered this tick',
        detail: gap.detail,
      }));
    }

    if (stateAvailable && persistState) {
      streakWrites.push(
        // Runs for chains that have LEFT the mesh are stale — a later
        // re-add must serve its full window, not resume the old count.
        // Keyed on the EXPECTED set, not the successfully-read one: a
        // chain whose read merely failed is still in the mesh.
        { kind: 'pruneStreaks', keepChainIds: obs.expectedChainIds },
        { kind: 'retainAlerts', keepKeys: findings.map((f) => f.key) },
      );
    }

    // ── Deliver ─────────────────────────────────────────────────────
    // One pipeline, one fail-open contract — see `deliver.ts` for why
    // this is not inline any more.
    const delivery = await deliverFindings({
      store,
      telegram: config.telegram,
      findings,
      repeatSeconds: config.alertRepeatSeconds,
      now,
      dedupAvailable: stateAvailable,
      writes: streakWrites,
      probeText: options.probeDelivery
        ? `✅ vaipakam-mesh-watcher delivery probe — manual POST /run. ` +
          `Chains observed: ${obs.books.length}. ` +
          `Critical: ${findings.filter((f) => f.severity === 'critical').length}. ` +
          `Advisory: ${findings.filter((f) => f.severity === 'advisory').length}. ` +
          `If you can read this, the ops pager works.`
        : null,
      format: (finding) =>
        formatAlert({
          severity: finding.severity,
          title: finding.title,
          chainLabel: chainLabel(finding.chainId),
          detail: finding.detail,
          footer: finding.code === STUCK_SIGNAL ? STUCK_CAVEAT : undefined,
        }),
    });

    const critical = findings.filter((f) => f.severity === 'critical').length;
    const deliveryConfigured = config.telegram !== null;
    const health = assessHealth({
      criticalFindings: critical,
      deliveryConfigured,
      deliveryFailures: delivery.failures,
      deliveryVerified: delivery.verified,
      coverageGaps: obs.gaps.length,
      stateDegraded: delivery.stateDegraded,
    });
    return {
      // Undeliverable alerts are not a healthy state, however clean the
      // ledgers are — so an unconfigured destination, a REJECTED send, or
      // a failed probe all fail the tick and the post-deploy check with
      // it. A silent pager is the one failure this Worker cannot report.
      // Coverage gaps keep their non-paging severity, but a watcher that
      // is not observing its full mesh is not HEALTHY — `curl --fail` on
      // a first-deploy verification with a missing mirror RPC must not
      // certify it (Codex #1443 r6).
      ok: health.ok,
      unhealthyBecause: health.failing,
      deliveryConfigured,
      deliveryVerified: delivery.verified,
      deliveryFailures: delivery.failures,
      stateDegraded: delivery.stateDegraded,
      chainsObserved: obs.books.length,
      critical,
      advisory: findings.length - critical,
      coverageGaps: obs.gaps.length,
      sent: delivery.sent,
      findings: findings.map((f) => ({
        severity: f.severity,
        code: f.code,
        chainId: f.chainId,
        title: f.title,
      })),
    };
  } catch (err) {
    // REDACT before this string touches a log or an alert: a failed
    // canonical read carries the provider URL, API key included.
    // CLASSIFIED, not forwarded — see `errors.ts`. The redactor is a
    // second layer only.
    const message = makeBaseRedactor(env)(
      describeFailure(classify(err, 'mesh watcher tick')),
    );
    console.error(`mesh-watcher tick failed: ${message}`);

    // Resolve the destination WITHOUT re-parsing the configuration that
    // may itself be what failed — see `readTelegramTarget`. The repeat
    // window falls back to its default here for the same reason.
    const telegram = readTelegramTarget(env);
    const config = {
      telegram,
      // The operator's configured cadence, resolved independently of
      // whatever knob made the tick throw.
      alertRepeatSeconds: readAlertRepeatSeconds(env),
    };
    if (config.telegram) {
      // Route the self-failure alert through the same quiet window where
      // possible: an RPC or config outage lasts hours, and one message per
      // tick would bury the ledger alerts this Worker exists to deliver.
      // If D1 is itself the thing that is broken, fall back to sending —
      // noise beats silence when the watcher is blind.
      const store = new AlertStore(env.DB);
      const candidate = {
        key: 'watcher-tick-failed/tick:0',
        fingerprint: hashIdentity(['watcher-tick-failed', message]),
      };
      // The store cannot throw, and a failed check degrades to "send it".
      const picked = await store.selectDue(
        [candidate],
        config.alertRepeatSeconds,
        now,
      );
      const due = picked.ok ? picked.value.length > 0 : true;

      if (due) {
        const ok = await sendOpsMessage(
          config.telegram,
          formatAlert({
            severity: 'critical',
            title: 'Mesh watcher tick failed',
            chainLabel: 'n/a',
            detail: message,
            footer:
              'The watcher itself is down — every invariant it checks is UNVERIFIED until this clears.',
          }),
        );
        if (!ok) deliveryFailures += 1;
        if (ok) {
          await store.commit([
            { kind: 'recordAlert', key: candidate.key, fingerprint: candidate.fingerprint, at: now },
          ]);
        }
      }
    }

    return {
      ok: false,
      deliveryConfigured: telegram !== null,
      deliveryVerified,
      deliveryFailures,
      stateDegraded: true,
      unhealthyBecause: ['tick failed before completion'],
      chainsObserved: 0,
      critical: 0,
      advisory: 0,
      coverageGaps: 0,
      sent: 0,
      findings: [],
      error: message,
    };
  }
}
