/**
 * #1028 item 2 — advisory pre-sign dry-run footer for the review
 * step. Renders the `useTxSimulation` verdict in plain words:
 * a passing dry run, a would-fail warning with the revert reason,
 * the benign "an approval happens first" note, or a subdued
 * no-verdict line. NEVER gates signing — flows must not read this
 * component's state into `canSign`.
 */
import { CheckCircle2, Info, Loader2, TriangleAlert } from 'lucide-react';
import { copy } from '../content/copy';
import {
  useTxSimulation,
  type SimResult,
  type TxSimInput,
} from '../contracts/useTxSimulation';

export function SimulationPreview({
  tx,
  result: lifted,
}: {
  tx: TxSimInput | null;
  /** Optional lifted verdict. When a parent already runs `useTxSimulation`
   *  for the same tx (e.g. OfferFlow, so its submit handler can prefer the
   *  concrete revert reason over a generic gas message), it passes the
   *  result here to avoid a duplicate eth_call. */
  result?: SimResult;
}) {
  // Hooks must run unconditionally; ignore the self-run result when a lifted
  // one is supplied.
  const own = useTxSimulation(lifted ? null : tx);
  const result = lifted ?? own.result;
  if (!tx || result.status === 'idle') return null;

  if (result.status === 'loading') {
    return (
      <p className="muted cluster" style={{ alignItems: 'center', gap: 6 }}>
        <Loader2 size={14} className="spin" aria-hidden />
        {copy.simulation.running}
      </p>
    );
  }
  if (result.status === 'unavailable') {
    return <p className="muted">{copy.simulation.unavailable}</p>;
  }
  if (result.status === 'approval-needed') {
    return (
      <p className="muted cluster" style={{ alignItems: 'flex-start', gap: 6 }}>
        <Info size={14} style={{ marginTop: 3 }} aria-hidden />
        <span style={{ flex: 1 }}>{copy.simulation.approvalNeeded}</span>
      </p>
    );
  }
  if (result.status === 'revert') {
    return (
      <div className="banner banner-warn" role="status">
        <TriangleAlert aria-hidden />
        <span className="banner-body">
          {copy.simulation.wouldFail}
          {result.revertReason ? (
            <>
              {' '}
              <strong>{result.revertReason}</strong>
            </>
          ) : null}{' '}
          {copy.simulation.wouldFailNote}
        </span>
      </div>
    );
  }
  return (
    <p className="muted cluster" style={{ alignItems: 'center', gap: 6 }}>
      <CheckCircle2 size={14} aria-hidden />
      {copy.simulation.passed}
    </p>
  );
}
