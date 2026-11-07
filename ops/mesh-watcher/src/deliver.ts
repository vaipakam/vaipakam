/**
 * Delivery + persistence, with ONE contract instead of per-call-site
 * handling.
 *
 * This module exists because the same defect was found four times across
 * review rounds (#1443 r5 P2, r6 P1, r7 P1 twice), each time in a
 * different call site: a D1 read fails, or a D1 write fails, or the dedup
 * query fails, and the rejection escapes to the tick's outer catch, which
 * replaces every already-computed ledger finding with a generic
 * "watcher down" message. Complete evidence of a real violation, thrown
 * away because a bookkeeping call failed. Patching each site in turn kept
 * leaving the next one, so the rule is stated once and enforced here:
 *
 * 1. **Evidence already computed is always delivered.** No storage
 *    failure may prevent a send. The findings were computed from chain
 *    reads that already succeeded; D1 only decides whether to SUPPRESS a
 *    repeat, and "we could not check" must degrade to "send it" — never
 *    to "send nothing".
 * 2. **Dedup is best-effort.** If the query rejects, everything is sent
 *    unsuppressed.
 * 3. **Recording is best-effort.** If the write rejects, the alerts have
 *    already gone out; the tick must not then report itself as failed.
 * 4. **Degradation is reported, never swallowed.** A storage failure
 *    freezes the windowed detectors below their thresholds, so it is a
 *    health problem in its own right: it fails the tick and is announced
 *    on the same channel.
 */

import { describeFailure } from './errors';
import type { Finding } from './finding';
import type { AlertStore, DueAlert, StoreOp } from './store';
import { sendOpsMessage, TELEGRAM_MAX_CHARS, type TelegramTarget } from './telegram';

/** Between two findings packed into one message. */
export const ALERT_SEPARATOR = '\n\n━━━━━━━━━━\n\n';

/** One Telegram message: the findings it carries and its text. */
export interface AlertBatch {
  /** Advisory-only messages are sent without a notification. */
  silent: boolean;
  findings: Finding[];
  text: string;
}

/**
 * Pack findings into as few messages as fit under `maxChars`.
 *
 * Criticals and advisories never share a message, so a critical always
 * notifies and an advisory never does. Criticals go first. Order within a
 * severity is kept. A finding whose own text is over the limit gets a message
 * to itself, which `sendOpsMessage` truncates as it always has; it is never
 * cut to make room for another.
 */
export function packAlerts(
  findings: readonly Finding[],
  format: (finding: Finding) => string,
  maxChars: number,
): AlertBatch[] {
  const batches: AlertBatch[] = [];
  for (const silent of [false, true]) {
    let current: AlertBatch | null = null;
    for (const finding of findings) {
      if ((finding.severity === 'advisory') !== silent) continue;
      const body = format(finding);
      if (current && current.text.length + ALERT_SEPARATOR.length + body.length <= maxChars) {
        current.text += ALERT_SEPARATOR + body;
        current.findings.push(finding);
        continue;
      }
      current = { silent, findings: [finding], text: body };
      batches.push(current);
    }
  }
  return batches;
}

export interface DeliveryReport {
  sent: number;
  failures: number;
  /** `true`/`false` once delivery was actually exercised; `null` if not. */
  verified: boolean | null;
  /** Any storage read or write failed — windowed detectors are unreliable. */
  stateDegraded: boolean;
  degradedDetail: string[];
  /**
   * Keys of the findings that reached the operator: sent this tick, or
   * suppressed because the same alert was already sent inside the repeat
   * window. A finding whose send failed, or that went only to the Worker
   * log because no destination is configured, is NOT here. The event-alert
   * scan advances its position only past these (`eventAlerts.ts`).
   */
  delivered: Set<string>;
}

export interface DeliveryRequest {
  store: AlertStore;
  telegram: TelegramTarget | null;
  findings: readonly Finding[];
  repeatSeconds: number;
  now: number;
  /** `false` when the streak read already failed — skips dedup entirely. */
  dedupAvailable: boolean;
  /** Writes to persist, DESCRIBED not prepared — see `store.ts`. */
  writes: readonly StoreOp[];
  /** Manual-verification probe text, or `null` on scheduled ticks. */
  probeText: string | null;
  format: (finding: Finding) => string;
}

export async function deliverFindings(
  req: DeliveryRequest,
): Promise<DeliveryReport> {
  const report: DeliveryReport = {
    sent: 0,
    failures: 0,
    verified: null,
    stateDegraded: !req.dedupAvailable,
    degradedDetail: req.dedupAvailable
      ? []
      : ['streak state could not be read'],
    delivered: new Set<string>(),
  };

  if (!req.telegram) {
    console.error(
      'DEGRADED: TG_OPS_BOT_TOKEN / TG_OPS_CHAT_ID unset — findings are being written to transient Worker logs and delivered to NO ONE.',
    );
    for (const f of req.findings) {
      console.error(`[${f.severity}] ${f.code} chain=${f.chainId}: ${f.title}\n${f.detail}`);
    }
    // The observations themselves are still valid, so the windowed
    // detectors keep accumulating: an unconfigured pager must not also
    // cost the runs their evidence, or restoring it would be followed by
    // another full window of silence (#1443 r8).
    const committed = await req.store.commit(req.writes);
    if (!committed.ok) {
      report.stateDegraded = true;
      report.degradedDetail.push(describeFailure(committed.failure));
    }
    return report;
  }

  const candidates: DueAlert[] = req.findings.map((f) => ({
    key: f.key,
    fingerprint: f.fingerprint,
    once: f.once === true,
  }));

  // Rule 2 — dedup is best-effort. The store cannot throw, so there is
  // no path by which this decision escapes the boundary.
  let send = candidates;
  if (req.dedupAvailable && candidates.length > 0) {
    const picked = await req.store.selectDue(candidates, req.repeatSeconds, req.now);
    if (picked.ok) {
      send = picked.value;
      // Not due = sent before with this fingerprint inside the window.
      const due = new Set(send.map((c) => c.key));
      for (const c of candidates) if (!due.has(c.key)) report.delivered.add(c.key);
    } else {
      report.stateDegraded = true;
      report.degradedDetail.push(describeFailure(picked.failure));
      send = candidates;
    }
  }

  // Rule 1 — deliver, packed into as few messages as fit (`packAlerts`).
  // Each message is one subrequest, and Workers Free allows 50 per tick, so
  // one message per finding let a burst of findings starve the tick's own
  // reads and the probe. Counts stay per FINDING: `sent` and `failures` say
  // how many findings were delivered or lost, not how many messages.
  const byKey = new Map(req.findings.map((f) => [f.key, f]));
  const due = send
    .map((s) => byKey.get(s.key))
    .filter((f): f is Finding => f !== undefined);
  const confirmed: StoreOp[] = [];
  for (const batch of packAlerts(due, req.format, TELEGRAM_MAX_CHARS)) {
    const ok = await sendOpsMessage(req.telegram, batch.text, batch.silent);
    if (!ok) {
      report.failures += batch.findings.length;
      // Rule 4, in miniature: the send failed, so this is the ONLY
      // surviving copy of the operands. A transient critical that clears
      // before the retry would otherwise lose its figures entirely.
      for (const finding of batch.findings) {
        console.error(
          `mesh-watcher: UNDELIVERED ${finding.severity} ${finding.code} chain=${finding.chainId}\n${req.format(finding)}`,
        );
      }
      continue;
    }
    for (const finding of batch.findings) {
      report.sent += 1;
      report.delivered.add(finding.key);
      confirmed.push({
        kind: 'recordAlert',
        key: finding.key,
        fingerprint: finding.fingerprint,
        at: req.now,
      });
    }
  }

  if (req.probeText) {
    report.verified = await sendOpsMessage(req.telegram, req.probeText);
    if (!report.verified) report.failures += 1;
  } else if (report.sent > 0) {
    report.verified = report.failures === 0;
  }

  // Rule 3 — recording is best-effort, and construction happens inside
  // the store's own guard (`store.ts`), not here.
  const committed = await req.store.commit([...req.writes, ...confirmed]);
  if (!committed.ok) {
    report.stateDegraded = true;
    report.degradedDetail.push(describeFailure(committed.failure));
  }

  // Rule 4 — announce the degradation. A frozen streak table means both
  // windowed detectors sit below their thresholds indefinitely while
  // everything else looks fine, so this must reach the operator rather
  // than living only in Worker logs.
  if (report.stateDegraded) {
    const ok = await sendOpsMessage(
      req.telegram,
      `🔴 CRITICAL — VPFI recycling mesh\n` +
        `Alert state storage is degraded\n` +
        `chain: n/a\n\n` +
        `${report.degradedDetail.join('; ')}\n\n` +
        `Ledger findings in this tick were still delivered — they are computed from chain reads and do not depend on storage. What IS affected: repeat-suppression may be bypassed (expect duplicates), and the windowed advisories (stuck-settlement, report-lag) cannot accumulate, so they will not fire until this clears.`,
    );
    if (!ok) report.failures += 1;
  }

  return report;
}
