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
import type { AlertStore, StoreOp } from './store';
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

  const candidates = req.findings.map((f) => ({
    key: f.key,
    fingerprint: f.fingerprint,
  }));

  // Rule 2 — dedup is best-effort. The store cannot throw, so there is
  // no path by which this decision escapes the boundary.
  let send = candidates;
  if (req.dedupAvailable && candidates.length > 0) {
    const picked = await req.store.selectDue(candidates, req.repeatSeconds, req.now);
    if (picked.ok) {
      send = picked.value;
    } else {
      report.stateDegraded = true;
      report.degradedDetail.push(describeFailure(picked.failure));
      send = candidates;
    }
  }

  // Rule 1 — deliver.
  const byKey = new Map(req.findings.map((f) => [f.key, f]));
  const confirmed: StoreOp[] = [];
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
    confirmed.push({
      kind: 'recordAlert',
      key: finding.key,
      fingerprint: finding.fingerprint,
      at: req.now,
    });
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
