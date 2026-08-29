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
import { useAccount, usePublicClient, useSignMessage } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
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
  | { kind: 'status'; status: DiagErasureStatus }
  | { kind: 'unavailable' }
  | { kind: 'expired' }
  | { kind: 'error' };

export function DiagErasureCard() {
  // The wallet's ACTUAL chain, not the app's read chain (#2008 round
  // 3 P2): `useActiveChain` substitutes the default chain on an
  // unsupported network, and a Safe deployed only elsewhere would
  // then read code-less here — signature controls offered to an
  // account the service must reject.
  const { address, chainId: walletChainId } = useAccount();
  const publicClient = usePublicClient({ chainId: walletChainId });
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

  // Smart-contract accounts (a Safe, a deployed smart wallet) sign
  // via ERC-1271/6492, which the service cannot verify yet — it
  // recovers a plain ECDSA signer and requires it to equal the
  // wallet — so their requests always end in the generic failure
  // (#2008 round 2 P2). Detect the DEPLOYED case by bytecode ON THE
  // WALLET'S OWN CHAIN, and be conservative where that chain cannot
  // be inspected (round 3 P2): a wallet on a network this app has no
  // client for gets the working email route rather than a prompt we
  // cannot vouch for. Only a CONFIRMED ordinary account is offered
  // the signature controls. An UNDEPLOYED counterfactual smart
  // wallet has no bytecode to detect and still lands in the generic
  // failure — that residual, and real ERC-1271 verification across
  // every signed endpoint, is tracked as #2009.
  const accountKind = useQuery({
    queryKey: ['diagErasure', 'accountKind', walletChainId ?? null, address ?? null],
    enabled: Boolean(configured && address),
    staleTime: Infinity,
    retry: false,
    queryFn: async (): Promise<'eoa' | 'contract' | 'uninspectable'> => {
      if (!publicClient) return 'uninspectable';
      try {
        const code = await publicClient.getCode({ address: address! });
        return code && code !== '0x' ? 'contract' : 'eoa';
      } catch {
        return 'uninspectable';
      }
    },
  });

  async function run(kind: 'erase' | 'status') {
    if (!address) return;
    // Captured at the moment of the click — the completion below may
    // run after a wallet switch, and everything it touches is keyed
    // to the wallet it answers FOR.
    const forWallet = address;
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
        const outcome = await requestDiagErasure(forWallet, (message) =>
          signMessageAsync({ message }),
        );
        publish(
          outcome === 'processed'
            ? { kind: 'erased' }
            : outcome === 'unavailable'
              ? { kind: 'unavailable' }
              : outcome === 'expired'
                ? { kind: 'expired' }
                : { kind: 'error' },
        );
      } else {
        const status = await requestDiagErasureStatus(forWallet, (message) =>
          signMessageAsync({ message }),
        );
        publish(
          status.status === 'unavailable'
            ? { kind: 'unavailable' }
            : status.status === 'expired'
              ? { kind: 'expired' }
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
      ) : accountKind.data === 'contract' ? (
        <p className="muted">{copy.dataRights.diagContractWallet}</p>
      ) : accountKind.data === 'uninspectable' || accountKind.isError ? (
        <p className="muted">{copy.dataRights.diagUninspectable}</p>
      ) : accountKind.data !== 'eoa' ? (
        <p className="muted">{copy.dataRights.diagBusy}</p>
      ) : (
        <>
          {shown?.kind === 'erased' ? (
            <div className="banner banner-success" role="status">
              {copy.dataRights.diagProcessed}
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
