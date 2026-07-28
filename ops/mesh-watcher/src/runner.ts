/**
 * Tick orchestration: read the mesh, evaluate both tiers, deliver what is
 * due, persist what the windowed signals need next time.
 */

import { assertAbiShape } from './abi';
import { deploymentFor } from './chains';
import {
  fingerprint,
  loadStreaks,
  pruneStreaksStatement,
  retainOnlyActiveStatement,
  saveStreakStatement,
  selectAlertsToSend,
  toAlertRecords,
} from './db';
import { readConfig, readTelegramTarget, type Env } from './env';
import {
  advanceStreak,
  checkHardInvariants,
  fmt,
  reportLagCondition,
  stuckSettlementCondition,
  type Finding,
} from './invariants';
import { observeMesh } from './mesh';
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
  chainsObserved: number;
  critical: number;
  advisory: number;
  coverageGaps: number;
  sent: number;
  findings: { severity: string; code: string; chainId: number; title: string }[];
  error?: string;
}

function chainLabel(chainId: number): string {
  const row = deploymentFor(chainId);
  return row ? `${row.chainSlug} (${chainId})` : `chain ${chainId}`;
}

/** Run one full tick. Never throws — failures surface as the summary's
 *  `error` plus an infrastructure alert, because a thrown scheduled
 *  handler is invisible outside the Cloudflare logs. */
export async function runTick(env: Env): Promise<TickSummary> {
  const now = Math.floor(Date.now() / 1000);

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
    const [stuckPrior, lagPrior] = await Promise.all([
      loadStreaks(env.DB, STUCK_SIGNAL),
      loadStreaks(env.DB, REPORT_LAG_SIGNAL),
    ]);

    const streakWrites: D1PreparedStatement[] = [];

    for (const books of obs.books) {
      // Base's own books are inert by construction, so neither windowed
      // signal has a meaning there — `base-self-inert` is what guards
      // that chain id.
      if (books.chainId === obs.canonicalChainId) continue;

      const local = obs.locals.get(books.chainId);

      const stuck = stuckSettlementCondition(books, local);
      const stuckOutcome = advanceStreak(
        stuckPrior.get(books.chainId) ?? null,
        stuck.holds,
        stuck.marker,
        config.stuckWindowTicks,
      );
      streakWrites.push(
        saveStreakStatement(
          env.DB,
          STUCK_SIGNAL,
          books.chainId,
          stuckOutcome.next,
          now,
        ),
      );
      if (stuckOutcome.fire) {
        findings.push({
          key: `${STUCK_SIGNAL}:${books.chainId}`,
          code: STUCK_SIGNAL,
          severity: 'advisory',
          chainId: books.chainId,
          title: 'Recycled commitments outstanding with no retirement',
          // The FIGURES only — no observation count. That count rises
          // every tick, so fingerprinting the detail made each tick look
          // like new information and bypassed the quiet window entirely
          // (Codex #1443 r1).
          fingerprintSource: `stuck:${books.outstanding}:${local ? local.localRetired : books.retired}:${books.released}:${books.avail}`,
          detail:
            `outstanding > 0 and retirement flat for ${stuckOutcome.next?.streak ?? 0} consecutive observations\n` +
            `  outstanding       = ${fmt(books.outstanding)}\n` +
            `  retired (${stuck.source === 'chain' ? "chain's own" : 'base copy'})  = ${fmt(local ? local.localRetired : books.retired)}\n` +
            `  released          = ${fmt(books.released)}\n` +
            `  availability      = ${fmt(books.avail)}\n` +
            (local
              ? `  chain bucket      = ${fmt(local.bucket)}\n`
              : `  (chain unreachable this tick — retirement read from Base's copy, which also moves only when a report lands)\n`),
        });
      }

      const lag = reportLagCondition(books, local);
      const lagOutcome = advanceStreak(
        lagPrior.get(books.chainId) ?? null,
        lag.holds,
        lag.marker,
        config.reportLagWindowTicks,
      );
      streakWrites.push(
        saveStreakStatement(
          env.DB,
          REPORT_LAG_SIGNAL,
          books.chainId,
          lagOutcome.next,
          now,
        ),
      );
      if (lagOutcome.fire && local) {
        findings.push({
          key: `${REPORT_LAG_SIGNAL}:${books.chainId}`,
          code: REPORT_LAG_SIGNAL,
          severity: 'advisory',
          chainId: books.chainId,
          title: 'Base has not accepted a newer report from this chain',
          // Figures only, for the same reason as the stuck signal above.
          fingerprintSource: `lag:${books.reported}:${books.retired}:${books.released}:${local.reportedCumulative}:${local.localRetired}:${local.localReleased}`,
          detail:
            `Base's accepted cumulative trails the chain's own and has not moved for ${lagOutcome.next?.streak ?? 0} consecutive observations\n` +
            `  base accepted = ${fmt(books.reported)}\n` +
            `  chain reports = ${fmt(local.reportedCumulative)}\n` +
            `  behind by     = ${fmt(local.reportedCumulative - books.reported)}`,
        });
      }
    }

    // ── Coverage gaps ────────────────────────────────────────────────
    // Always surfaced. A watcher that quietly narrows its scope reports
    // "all clear" for chains it never looked at.
    for (const gap of obs.gaps) {
      findings.push({
        key: `coverage-gap:${gap.chainId}`,
        code: 'coverage-gap',
        severity: 'advisory',
        chainId: gap.chainId,
        title: 'Chain not covered this tick',
        detail: gap.detail,
      });
    }

    // ── Deliver ──────────────────────────────────────────────────────
    const candidates = toAlertRecords(findings);

    let sent = 0;
    const writes: D1PreparedStatement[] = [...streakWrites];

    if (config.telegram) {
      const { send, statements } = await selectAlertsToSend(
        env.DB,
        candidates,
        config.alertRepeatSeconds,
        now,
      );
      const byKey = new Map(findings.map((f) => [f.key, f]));
      for (let i = 0; i < send.length; i += 1) {
        const record = send[i]!;
        const finding = byKey.get(record.key);
        if (!finding) continue;
        const ok = await sendOpsMessage(
          config.telegram,
          formatAlert({
            severity: finding.severity,
            title: finding.title,
            chainLabel: chainLabel(finding.chainId),
            detail: finding.detail,
            footer:
              finding.code === STUCK_SIGNAL ? STUCK_CAVEAT : undefined,
          }),
        );
        if (!ok) continue;
        sent += 1;
        // Record the quiet window only for what ACTUALLY went out, and
        // pair it with its own send rather than a positional prefix: a
        // Telegram failure on one alert must not consume the window of a
        // different alert that succeeded after it.
        const statement = statements[i];
        if (statement) writes.push(statement);
      }
    } else {
      console.warn(
        'TG_OPS_BOT_TOKEN / TG_OPS_CHAT_ID unset — findings logged only, not delivered',
      );
      for (const f of findings) {
        console.warn(`[${f.severity}] ${f.code} ${chainLabel(f.chainId)}: ${f.title}`);
      }
    }

    writes.push(
      // Runs for chains that have left the mesh are stale — a later
      // re-add must serve its full window, not resume the old count.
      pruneStreaksStatement(
        env.DB,
        obs.books.map((b) => b.chainId),
      ),
      retainOnlyActiveStatement(
        env.DB,
        findings.map((f) => f.key),
      ),
    );
    if (writes.length > 0) await env.DB.batch(writes);

    const critical = findings.filter((f) => f.severity === 'critical').length;
    return {
      ok: critical === 0,
      chainsObserved: obs.books.length,
      critical,
      advisory: findings.length - critical,
      coverageGaps: obs.gaps.length,
      sent,
      findings: findings.map((f) => ({
        severity: f.severity,
        code: f.code,
        chainId: f.chainId,
        title: f.title,
      })),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`mesh-watcher tick failed: ${message}`);

    // Resolve the destination WITHOUT re-parsing the configuration that
    // may itself be what failed — see `readTelegramTarget`. The repeat
    // window falls back to its default here for the same reason.
    const telegram = readTelegramTarget(env);
    const config = { telegram, alertRepeatSeconds: 21_600 };
    if (config.telegram) {
      // Route the self-failure alert through the same quiet window where
      // possible: an RPC or config outage lasts hours, and one message per
      // tick would bury the ledger alerts this Worker exists to deliver.
      // If D1 is itself the thing that is broken, fall back to sending —
      // noise beats silence when the watcher is blind.
      let due = true;
      let record: D1PreparedStatement | null = null;
      try {
        const picked = await selectAlertsToSend(
          env.DB,
          [{ key: 'watcher-tick-failed:0', fingerprint: fingerprint(message) }],
          config.alertRepeatSeconds,
          now,
        );
        due = picked.send.length > 0;
        record = picked.statements[0] ?? null;
      } catch {
        due = true;
      }

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
        if (ok && record) {
          try {
            await record.run();
          } catch {
            /* best effort — the alert already went out */
          }
        }
      }
    }

    return {
      ok: false,
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
