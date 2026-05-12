/**
 * "Wallet connect" status banner — companion to ConnectKit's connect
 * modal. Shown on all devices, bottom-anchored, at a z-index one above
 * ConnectKit's modal so it reads as a hint over the modal rather than
 * obscuring it.
 *
 * A small state machine:
 *
 *   pick       — the connect modal is open and the user hasn't been
 *                deep-linked into a wallet app yet → "Select your wallet
 *                app above to connect." (On desktop with an extension,
 *                ConnectKit's "Connecting to <wallet>" screen keeps the
 *                modal open without a deep-link, so this state also
 *                covers those 1-3 seconds before you click Approve in
 *                the extension popup — a minor wart; the modal's own
 *                "confirm in the extension" text is the real
 *                instruction there, and it self-corrects on connect.
 *                Reading ConnectKit's internal modal-route would make it
 *                precise but couples us to a private API.)
 *   connecting — the user got deep-linked into a wallet app, detected by
 *                the tab going `hidden` while a connect attempt is live
 *                (clicking the modal's X / clicking away keeps the tab
 *                visible) → "Still connecting… confirm in your wallet."
 *                **Persists until the wallet is connected** — it
 *                survives the wallet app returning the user to the
 *                browser, ConnectKit's modal re-opening, and the silent
 *                WalletConnect-relay reconnect + approval replay on
 *                return, which is exactly the window where ConnectKit's
 *                own modal often shows no pending state and the page
 *                looks frozen.
 *   slow       — same as `connecting`, but it's been > 25 s → adds a
 *                recovery hint.
 *   hidden     — connected, OR the modal is closed and no deep-link is
 *                in flight (the user backed out via X / click-away).
 *
 * Mounted inside `<ConnectKitProvider>` so `useModal()` works.
 */
import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { useModal } from 'connectkit';
import { Loader2, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './WalletConnectingOverlay.css';

/** After this long still in the `connecting` state, swap the copy from
 *  "hang on" to "you may need to act / try again". */
const SLOW_AFTER_MS = 25_000;

type BannerState = 'pick' | 'connecting' | 'slow' | 'hidden';

export function WalletConnectingOverlay() {
  const { t } = useTranslation();
  const { status, isConnected } = useAccount();
  const { open: modalOpen } = useModal();
  const connecting = status === 'connecting';
  const disconnected = status === 'disconnected';

  // Did the tab go `hidden` while a connect attempt was live? = the user
  // got deep-linked into a wallet app. The listener is gated on
  // `connecting` so switching browser tabs while just browsing the
  // wallet list (no connect in flight) doesn't trip it. Kept in state
  // (not a ref) because it gates render.
  const [deepLinked, setDeepLinked] = useState(false);
  useEffect(() => {
    if (!connecting) return;
    function onVisibility() {
      if (document.visibilityState === 'hidden') setDeepLinked(true);
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [connecting]);

  // Clear the deep-link marker ONLY when the attempt actually finishes —
  // connected (`isConnected`) or failed / aborted (`status` →
  // 'disconnected', which is also what closing the modal mid-connect
  // produces). It must survive the modal opening/closing in between, so
  // there's no modal-open reset: that's what keeps "Still connecting…"
  // up through the post-approval relay-reconnect lull on mobile instead
  // of flipping back to "pick a wallet".
  useEffect(() => {
    if (isConnected || disconnected) setDeepLinked(false);
  }, [isConnected, disconnected]);

  // 25 s escalation — only in the `connecting` state.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!deepLinked || isConnected) {
      setSlow(false);
      return;
    }
    const id = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(id);
  }, [deepLinked, isConnected]);

  let state: BannerState;
  if (isConnected) {
    state = 'hidden';
  } else if (deepLinked) {
    state = slow ? 'slow' : 'connecting';
  } else if (modalOpen) {
    state = 'pick';
  } else {
    state = 'hidden';
  }

  if (state === 'hidden') return null;

  const isPick = state === 'pick';
  const message = isPick
    ? t('walletConnecting.pick', {
        defaultValue: 'Select your wallet app above to connect.',
      })
    : state === 'slow'
      ? t('walletConnecting.slow', {
          defaultValue:
            'Still connecting… if nothing happened, reopen your wallet, or close the wallet picker and try again.',
        })
      : t('walletConnecting.active', {
          defaultValue:
            'Still connecting… confirm the request in your wallet. This can take a few seconds on mobile.',
        });

  return (
    <div className="wallet-connecting-banner" role="status" aria-live="polite">
      {isPick ? (
        <Wallet size={16} className="wallet-connecting-icon" aria-hidden="true" />
      ) : (
        <Loader2
          size={16}
          className="wallet-connecting-icon wallet-connecting-spinner"
          aria-hidden="true"
        />
      )}
      <span>{message}</span>
    </div>
  );
}
