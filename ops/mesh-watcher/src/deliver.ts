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

import { selectAlertsToSend, toAlertRecords } from './db';
import type { Finding } from './invariants';
import type { Redactor } from './redact';
import { sendOpsMessage, type TelegramTarget } from './telegram';

export interface DeliveryReport {
  sent: number;
  failures: number;
  /** `true`/`false` once delivery was actually exercised; `null` if not. */
  verified: boolean | null;
  /** Any storage read or write failed — windowed detectors are unreliable. */
  stateDegraded: boolean;
  degradedDetail: string[];
}

export interface DeliveryRequest {
  db: D1Database;
  telegram: TelegramTarget | null;
  findings: readonly Finding[];
  repeatSeconds: number;
  now: number;
  redact: Redactor;
  /** `false` when the streak read already failed — skips dedup entirely. */
  dedupAvailable: boolean;
  /** Streak/prune statements to persist alongside the dedup records. */
  writes: readonly D1PreparedStatement[];
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
  };

  if (!req.telegram) {
    console.error(
      'DEGRADED: TG_OPS_BOT_TOKEN / TG_OPS_CHAT_ID unset — findings are being written to transient Worker logs and delivered to NO ONE.',
    );
    for (const f of req.findings) {
      console.error(`[${f.severity}] ${f.code} chain=${f.chainId}: ${f.title}\n${f.detail}`);
    }
    return report;
  }

  const candidates = toAlertRecords(req.findings);

  // Rule 2 — dedup is best-effort.
  let send = candidates;
  let records: D1PreparedStatement[] = [];
  if (req.dedupAvailable && candidates.length > 0) {
    try {
      const picked = await selectAlertsToSend(
        req.db,
        candidates,
        req.repeatSeconds,
        req.now,
      );
      send = picked.send;
      records = picked.statements;
    } catch (err) {
      report.stateDegraded = true;
      report.degradedDetail.push('repeat-suppression query failed');
      console.error(
        `mesh-watcher: dedup query failed, sending unsuppressed: ${req.redact(err instanceof Error ? err.message : String(err))}`,
      );
      send = candidates;
      records = [];
    }
  }

  // Rule 1 — deliver.
  const byKey = new Map(req.findings.map((f) => [f.key, f]));
  const confirmed: D1PreparedStatement[] = [];
  for (let i = 0; i < send.length; i += 1) {
    const finding = byKey.get(send[i]!.key);
    if (!finding) continue;
    const body = req.format(finding);
    const ok = await sendOpsMessage(
      req.telegram,
      body,
      finding.severity === 'advisory',
    );
    if (!ok) {
      report.failures += 1;
      // Rule 4, in miniature: the send failed, so this is the ONLY
      // surviving copy of the operands. A transient critical that clears
      // before the retry would otherwise lose its figures entirely.
      console.error(
        `mesh-watcher: UNDELIVERED ${finding.severity} ${finding.code} chain=${finding.chainId}\n${body}`,
      );
      continue;
    }
    report.sent += 1;
    const record = records[i];
    if (record) confirmed.push(record);
  }

  if (req.probeText) {
    report.verified = await sendOpsMessage(req.telegram, req.probeText);
    if (!report.verified) report.failures += 1;
  } else if (report.sent > 0) {
    report.verified = report.failures === 0;
  }

  // Rule 3 — recording is best-effort.
  const writes = [...req.writes, ...confirmed];
  if (writes.length > 0) {
    try {
      await req.db.batch(writes);
    } catch (err) {
      report.stateDegraded = true;
      report.degradedDetail.push('streak/dedup write failed');
      console.error(
        `mesh-watcher: alert-state write failed (alerts already delivered): ${req.redact(err instanceof Error ? err.message : String(err))}`,
      );
    }
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
