/**
 * Paid Push billing consent (#2723) — the on-chain half of paid Push alerts,
 * inside the Alerts card.
 *
 * What it states, every time a wallet is connected:
 *  - the fee per loan side, in VPFI, as configured on chain right now, where
 *    it is paid from and how often;
 *  - whether the alert service charges it on this network — the service's
 *    own answer, read from `GET /push/status`, never inferred from the fee;
 *  - the wallet's stored cap, and the contract's answer on whether it covers
 *    the current fee.
 *
 * What it offers:
 *  - AGREE (sign `setNotificationFeeConsent` at the current fee) only on a
 *    network the service says it bills on, and only while the stored cap does
 *    not already cover the fee. Where nothing charges the fee there is
 *    nothing to agree to, so the card says so instead of collecting an
 *    authorisation no service uses. Agreeing is enrolment: the write path's
 *    Terms gate applies to it.
 *  - WITHDRAW (`setNotificationFeeConsent(0)`) whenever any cap is stored,
 *    whatever the billing posture. It is an exit write — not held by the
 *    Terms — and the contract keeps it open while paused.
 *  - A warning when a covering consent stands on a billed network and the
 *    vault's free VPFI is below the fee; the bill itself stays authoritative.
 *
 * The consent is per network (each network's Diamond keeps its own record),
 * so every line names the network it describes.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { chainDisplayName } from '../chain/chains';
import { useActiveChain } from '../chain/useActiveChain';
import { copy } from '../content/copy';
import { useDiamondWrite } from '../contracts/diamond';
import type { PushBillingState } from '../data/alerts';
import {
  notificationFeeConsentKey,
  paidPushConsentView,
  useNotificationFeeConsent,
  type NotificationFeeConsent,
} from '../data/notificationFee';
import { useVpfi, VPFI_DECIMALS } from '../data/vpfi';
import { captureTxError } from '../lib/errors';
import { formatTokenAmountExact } from '../lib/format';

const vpfi = (raw: bigint) => formatTokenAmountExact(raw, VPFI_DECIMALS);

export function PaidPushConsent({ billing }: { billing: PushBillingState | undefined }) {
  const { readChain, address, onSupportedChain } = useActiveChain();
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const consentQuery = useNotificationFeeConsent();
  const vpfiSnapshot = useVpfi();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chainId = readChain.chainId;
  const chainName = chainDisplayName(chainId) ?? String(chainId);

  async function setCap(next: bigint) {
    if (!address) return;
    // Captured at the click: the mined write is reported against the network
    // it was sent on, even if the wallet switches while it is pending.
    const forChain = chainId;
    const forName = chainName;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await write('setNotificationFeeConsent', [next]);
      // The write is MINED, so `next` is the chain's record now. Patch the
      // cache rather than refetching at once: a lagging public RPC would
      // serve the old record and make the click look like it did nothing.
      // `coversCurrentFee` is the contract's own rule (a non-zero cap at or
      // above the fee); the periodic read reconciles it with the chain.
      queryClient.setQueryData(
        notificationFeeConsentKey(forChain, address),
        (old: NotificationFeeConsent | undefined) =>
          old
            ? { ...old, capVpfi: next, coversCurrentFee: next !== 0n && old.feeVpfi <= next }
            : old,
      );
      setNotice(
        next === 0n ? copy.alerts.paidWithdrawn(forName) : copy.alerts.paidAgreed(vpfi(next), forName),
      );
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  // A failed FIRST read is stated as unread. A failed background refresh
  // keeps the last read on screen (TanStack keeps `data` with an error
  // status), so the withdrawal it offers stays reachable rather than
  // vanishing behind a transient RPC error.
  let body: React.ReactNode;
  if (!consentQuery.data) {
    body = consentQuery.isError ? (
      <p className="muted" role="status" style={{ margin: 0 }}>
        {copy.alerts.paidReadFailed}
      </p>
    ) : null;
  } else {
    const consent = consentQuery.data;
    const snapshot = vpfiSnapshot.data;
    const view = paidPushConsentView({
      billing,
      chainId,
      consent,
      freeVpfi: snapshot && snapshot.registered ? snapshot.freeBalance : undefined,
    });
    const fee = vpfi(consent.feeVpfi);
    body = (
      <>
        <p className="muted" style={{ margin: 0 }}>
          {copy.alerts.paidFee(chainName, fee)}
        </p>
        {view.billed !== 'billed' ? (
          <p className="muted" role="status" style={{ margin: 0 }} data-testid="paid-push-billing">
            {view.billed === 'not-billed'
              ? copy.alerts.paidNotBilled(chainName)
              : copy.alerts.paidBilledUnknown(chainName)}
          </p>
        ) : null}
        <p style={{ margin: 0 }} data-testid="paid-push-consent">
          {view.consent === 'none'
            ? copy.alerts.paidConsentNone(chainName)
            : view.consent === 'covers'
              ? copy.alerts.paidConsentCovers(vpfi(consent.capVpfi), chainName)
              : copy.alerts.paidConsentBelow(vpfi(consent.capVpfi), chainName)}
        </p>
        {view.lowVaultBalance && snapshot ? (
          <div className="banner banner-warn" role="alert">
            <span className="banner-body">
              {copy.alerts.paidLowVault(vpfi(snapshot.freeBalance), fee)}
            </span>
          </div>
        ) : null}
        {view.offerAgree || view.offerWithdraw ? (
          onSupportedChain ? (
            <div className="cluster">
              {view.offerAgree ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void setCap(consent.feeVpfi)}
                >
                  {copy.alerts.paidAgree(fee)}
                </button>
              ) : null}
              {view.offerWithdraw ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void setCap(0n)}
                >
                  {copy.alerts.paidWithdraw}
                </button>
              ) : null}
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>{copy.vpfi.switchToChange}</p>
          )
        ) : null}
        {view.offerAgree || view.consent === 'covers' ? (
          <p className="muted" style={{ margin: 0 }}>{copy.alerts.paidRaiseNote}</p>
        ) : null}
        {view.offerWithdraw ? (
          <p className="muted" style={{ margin: 0 }}>{copy.alerts.paidWithdrawNote}</p>
        ) : null}
      </>
    );
  }

  return (
    <div className="stack" style={{ gap: 8 }} data-testid="paid-push">
      <h3 style={{ margin: 0 }}>{copy.alerts.paidTitle}</h3>
      {body}
      {notice ? <p className="muted" style={{ margin: 0 }}>{notice}</p> : null}
      {error ? (
        <div className="banner banner-danger" role="alert">
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </div>
  );
}
