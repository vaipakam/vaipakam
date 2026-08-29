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
import { useState } from 'react';
import { FileX2, ShieldCheck } from 'lucide-react';
import { useAccount, usePublicClient, useSignMessage } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import {
  diagErasureConfigured,
  requestDiagErasure,
  requestDiagErasureStatus,
  type DiagErasureStatus,
} from '../data/diagErasure';
import { isUserRejection } from '../lib/errors';

type CardResult = { forWallet: string } & (
  | { kind: 'erased' }
  | { kind: 'status'; status: DiagErasureStatus }
  | { kind: 'unavailable' }
  | { kind: 'error' }
);

export function DiagErasureCard() {
  const { address } = useAccount();
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const { signMessageAsync } = useSignMessage();
  // Busy is scoped to the wallet that started the operation (#2008
  // round 2 P2): a signature prompt has no timeout — the deadline
  // arms only after signing — so wallet A's pending prompt must not
  // pin wallet B's controls shut for however long A's wallet takes.
  // Rendering disables only when the pending operation belongs to
  // the CONNECTED wallet, and the completion clears the flag only if
  // it still owns it, so A's late settle cannot clear a pending
  // operation B started meanwhile.
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const [result, setResult] = useState<CardResult | null>(null);
  // A result belongs to the wallet that asked (#2008 round 1 P1):
  // wallet A's disclosed retention note — or its reassuring clear
  // answer — must never render as wallet B's. Two guards, because
  // the failure has two routes: this render-time reset clears the
  // card the moment the connected wallet changes (the AlertsCard
  // scope pattern — state init runs once), and every stored result
  // carries the wallet it answered FOR, with rendering gated on the
  // match, so an in-flight request that completes AFTER the switch
  // is stored but never shown to the wrong wallet.
  const [walletScope, setWalletScope] = useState(address ?? '');
  if (walletScope !== (address ?? '')) {
    setWalletScope(address ?? '');
    setResult(null);
  }

  const configured = diagErasureConfigured();
  const shown = result && result.forWallet === address ? result : null;
  const busy = busyFor !== null && busyFor === address;

  // Smart-contract accounts (a Safe, a deployed smart wallet) sign
  // via ERC-1271/6492, which the service cannot verify yet — it
  // recovers a plain ECDSA signer and requires it to equal the
  // wallet — so their requests always end in the generic failure
  // (#2008 round 2 P2). Detect the DEPLOYED case by bytecode and
  // present the working email route instead of a prompt that cannot
  // succeed. Fail-open on a failed or pending read: blocking an EOA
  // on a hiccup would withhold a working control, while letting a
  // contract wallet through merely reproduces the honest generic
  // failure. An UNDEPLOYED counterfactual smart wallet has no
  // bytecode to detect and still lands in that generic failure —
  // that residual, and real ERC-1271 verification across every
  // signed endpoint, is tracked as a follow-up issue.
  const contractWallet = useQuery({
    queryKey: ['diagErasure', 'isContract', readChain.chainId, address ?? null],
    enabled: Boolean(configured && publicClient && address),
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const code = await publicClient!.getCode({ address: address! });
      return Boolean(code && code !== '0x');
    },
  });

  async function run(kind: 'erase' | 'status') {
    if (!address) return;
    // Captured at the moment of the click — the completion below may
    // run after a wallet switch, and it must record who it answers.
    const forWallet = address;
    setBusyFor(forWallet);
    setResult(null);
    try {
      if (kind === 'erase') {
        const outcome = await requestDiagErasure(forWallet, (message) =>
          signMessageAsync({ message }),
        );
        setResult(
          outcome === 'processed'
            ? { forWallet, kind: 'erased' }
            : outcome === 'unavailable'
              ? { forWallet, kind: 'unavailable' }
              : { forWallet, kind: 'error' },
        );
      } else {
        const status = await requestDiagErasureStatus(forWallet, (message) =>
          signMessageAsync({ message }),
        );
        setResult(
          status.status === 'unavailable'
            ? { forWallet, kind: 'unavailable' }
            : status.status === 'error'
              ? { forWallet, kind: 'error' }
              : { forWallet, kind: 'status', status },
        );
      }
    } catch (e) {
      // A dismissed wallet prompt is a cancel, not a failure — the
      // card simply returns to rest. Anything else is reported.
      if (!isUserRejection(e)) setResult({ forWallet, kind: 'error' });
    } finally {
      setBusyFor((prev) => (prev === forWallet ? null : prev));
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
      ) : contractWallet.data === true ? (
        <p className="muted">{copy.dataRights.diagContractWallet}</p>
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
