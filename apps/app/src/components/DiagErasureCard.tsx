/**
 * Signed erasure of the error reports support keeps (#2002).
 *
 * The Privacy Policy promises this control as a statement of legal
 * right: erasure of the server-side error-diagnostics records "by
 * signing an erasure request with that wallet in the app". The
 * service has existed since T-075; this card is the promised way in,
 * on the page whose scope list used to name these records as the one
 * thing it could not reach.
 *
 * WHAT THIS CARD MUST NOT DO is out-inform the service. The erasure
 * response is deliberately uniform — it never says whether records
 * existed, were deleted, or were retained under a (possibly gagged)
 * legal hold — so the card renders ONE confirmation for every
 * outcome the service reports as processed, with a static,
 * unconditional explainer saying exactly that. The status check
 * surfaces retention only where an operator has explicitly enabled
 * disclosure; its quiet answer is phrased as "no retained records
 * are REPORTED", never "nothing is retained", because the two are
 * different claims and only the first is knowable.
 */
import { useRef, useState } from 'react';
import { FileX2, ShieldCheck } from 'lucide-react';
import { useAccount, useSignMessage } from 'wagmi';
import { chainDisplayName } from '../chain/chains';
import { copy } from '../content/copy';
import {
  diagErasureConfigured,
  requestDiagErasure,
  requestDiagErasureStatus,
  type DiagErasureStatus,
} from '../data/diagErasure';
import { isUserRejection } from '../lib/errors';

type CardResult =
  | { kind: 'erased' }
  // The chain the SERVICE confirmed (#2013 r6) — its own echo, never
  // the wallet's current chain: the confirmation must name the
  // network it actually covered, because the wallet may sit on a
  // different one by the time this renders. Null when the service
  // named none; the banner then describes the scope without a name.
  | { kind: 'erasedChainOnly'; chainId: number | null }
  | { kind: 'status'; status: DiagErasureStatus }
  | { kind: 'unavailable' }
  | { kind: 'expired' }
  | { kind: 'unverifiable' }
  | { kind: 'error' };

export function DiagErasureCard() {
  // The wallet's ACTUAL chain, not the app's read chain (#2008 round
  // 3 P2, repurposed by #2009): `useActiveChain` substitutes the
  // default chain on an unsupported network, and a smart account
  // lives on ITS chain — this id travels with each request as the
  // service's ERC-1271 verification hint.
  const { address, chainId: walletChainId } = useAccount();
  const { signMessageAsync } = useSignMessage();
  // ALL per-operation state is keyed BY WALLET (#2008 rounds 1–3
  // converged here in round 5). A signature prompt has no timeout —
  // the deadline arms only after signing — so wallet A's pending
  // prompt must survive a switch to wallet B AND B starting its own
  // operation: a single pending slot let B's run overwrite A's, so
  // switching back to A re-enabled controls with A's prompt still
  // open (a duplicate request), and a global run counter then
  // suppressed A's original completion. With a map per wallet, each
  // wallet's controls disable exactly while ITS OWN run pends, and
  // one wallet's runs can never disturb another's.
  const [pendingRuns, setPendingRuns] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  // A result belongs to the wallet that asked (#2008 round 1 P1):
  // wallet A's disclosed retention note — or its reassuring clear
  // answer — must never render as wallet B's. Keying the stored
  // results by wallet makes that structural: rendering reads ONLY
  // the connected wallet's entry, so an in-flight request that
  // completes after a switch is stored under its own wallet and
  // never shown to another's.
  const [results, setResults] = useState<ReadonlyMap<string, CardResult>>(
    () => new Map(),
  );
  // Monotonic run identity, PER WALLET (#2008 rounds 3 + 5): a
  // completion publishes its result and clears its pending flag only
  // while it is still that wallet's latest run, so a stale settle
  // cannot overwrite a newer run's state — and one wallet's newer
  // run does not silence another wallet's only completion.
  const runSeqRef = useRef(0);
  const latestRunRef = useRef(new Map<string, number>());

  const configured = diagErasureConfigured();
  const shown = (address && results.get(address)) || null;
  const busy = address !== undefined && pendingRuns.has(address);

  async function run(kind: 'erase' | 'status') {
    if (!address) return;
    // Captured at the moment of the click — the completion below may
    // run after a wallet switch, and everything it touches is keyed
    // to the wallet it answers FOR. The chain travels with it as the
    // service's ERC-1271 verification hint (#2009): the service now
    // verifies smart-account signatures on-chain, so the bytecode
    // detection shim this card carried (#2008 rounds 2–3) is gone —
    // every account type gets the signature controls.
    const forWallet = address;
    const forChain = walletChainId;
    const runId = ++runSeqRef.current;
    latestRunRef.current.set(forWallet, runId);
    // Publish and clear ONLY while this run is still THIS WALLET's
    // latest — an older completion must neither overwrite a newer
    // result nor clear a newer run's pending state, and (round 5) a
    // different wallet's runs are not in this race at all.
    const publish = (r: CardResult) => {
      if (latestRunRef.current.get(forWallet) === runId) {
        setResults((prev) => new Map(prev).set(forWallet, r));
      }
    };
    setPendingRuns((prev) => new Map(prev).set(forWallet, runId));
    setResults((prev) => {
      if (!prev.has(forWallet)) return prev;
      const next = new Map(prev);
      next.delete(forWallet);
      return next;
    });
    try {
      if (kind === 'erase') {
        const res = await requestDiagErasure(
          forWallet,
          (message) => signMessageAsync({ message }),
          forChain,
        );
        publish(
          res.outcome === 'processed'
            ? { kind: 'erased' }
            : res.outcome === 'processedChainOnly'
              ? { kind: 'erasedChainOnly', chainId: res.chainId }
              : res.outcome === 'unavailable'
                ? { kind: 'unavailable' }
                : res.outcome === 'expired'
                  ? { kind: 'expired' }
                  : res.outcome === 'unverifiable'
                    ? { kind: 'unverifiable' }
                    : { kind: 'error' },
        );
      } else {
        const status = await requestDiagErasureStatus(
          forWallet,
          (message) => signMessageAsync({ message }),
          forChain,
        );
        publish(
          status.status === 'unavailable'
            ? { kind: 'unavailable' }
            : status.status === 'expired'
              ? { kind: 'expired' }
              : status.status === 'unverifiable'
                ? { kind: 'unverifiable' }
                : status.status === 'error'
                  ? { kind: 'error' }
                  : { kind: 'status', status },
        );
      }
    } catch (e) {
      // A dismissed wallet prompt is a cancel, not a failure — the
      // card simply returns to rest. Anything else is reported.
      if (!isUserRejection(e)) publish({ kind: 'error' });
    } finally {
      setPendingRuns((prev) => {
        if (prev.get(forWallet) !== runId) return prev;
        const next = new Map(prev);
        next.delete(forWallet);
        return next;
      });
    }
  }

  return (
    <section className="card">
      <div className="card-title">
        <FileX2 size={16} aria-hidden="true" />
        <h2 style={{ margin: 0 }}>{copy.dataRights.diagTitle}</h2>
      </div>
      <p>{copy.dataRights.diagBody}</p>

      {!configured ? (
        <p className="muted">{copy.dataRights.diagNotConfigured}</p>
      ) : !address ? (
        <p className="muted">{copy.dataRights.diagConnect}</p>
      ) : (
        <>
          {shown?.kind === 'erased' ? (
            <div className="banner banner-success" role="status">
              {copy.dataRights.diagProcessed}
            </div>
          ) : null}
          {shown?.kind === 'erasedChainOnly' ? (
            <div className="banner banner-success" role="status">
              {/* Names the chain the SERVICE confirmed — never "the
                  network you are connected to", which may already be
                  a different one (#2013 r6). */}
              {(() => {
                const network = chainDisplayName(shown.chainId ?? undefined);
                return network
                  ? copy.dataRights.diagProcessedChainOnly(network)
                  : copy.dataRights.diagProcessedChainUnknown;
              })()}
            </div>
          ) : null}
          {shown?.kind === 'status' ? (
            <div
              className={
                shown.status.status === 'retained_by_law'
                  ? 'banner'
                  : 'banner banner-success'
              }
              role="status"
            >
              {shown.status.status === 'retained_by_law' ? (
                <>
                  {copy.dataRights.diagRetainedLabel}
                  <br />
                  {/* The operator-authored disclosure note, verbatim —
                      the one message the service chose to surface. */}
                  {shown.status.note}
                </>
              ) : (
                copy.dataRights.diagStatusClear
              )}
            </div>
          ) : null}
          {shown?.kind === 'unavailable' ? (
            <div className="banner banner-danger" role="alert">
              {copy.dataRights.diagUnavailable}
            </div>
          ) : null}
          {shown?.kind === 'expired' ? (
            <div className="banner" role="alert">
              {copy.dataRights.diagExpired}
            </div>
          ) : null}
          {shown?.kind === 'unverifiable' ? (
            <div className="banner" role="alert">
              {copy.dataRights.diagVerifyUnavailable}
            </div>
          ) : null}
          {shown?.kind === 'error' ? (
            <div className="banner banner-danger" role="alert">
              {copy.dataRights.diagError}
            </div>
          ) : null}

          <div className="cluster">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void run('erase')}
              disabled={busy}
            >
              <FileX2 size={14} aria-hidden="true" />
              {busy ? copy.dataRights.diagBusy : copy.dataRights.diagEraseButton}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void run('status')}
              disabled={busy}
            >
              <ShieldCheck size={14} aria-hidden="true" />
              {copy.dataRights.diagStatusButton}
            </button>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            {copy.dataRights.diagSignNote}
          </p>
          {/* Static and unconditional — shown to everyone identically,
              so the explainer itself carries no signal about anyone's
              records. */}
          <p className="muted" style={{ marginBottom: 0 }}>
            {copy.dataRights.diagUniformNote}
          </p>
        </>
      )}
    </section>
  );
}
