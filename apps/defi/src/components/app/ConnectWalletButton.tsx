import { Wallet } from 'lucide-react';
import { ConnectKitButton } from 'connectkit';
import { useTranslation } from 'react-i18next';

interface Props {
  /** Extra classes applied to the primary button (e.g. `btn-sm`). */
  className?: string;
  /** When true, renders the button at `width: 100%` — used in the mobile
   *  navbar where the button is the full-row CTA. */
  fullWidth?: boolean;
}

/**
 * Connect-Wallet button — thin custom trigger over ConnectKit.
 *
 * ConnectKit owns the entire wallet-picker UX: clicking this button
 * opens a modal that shows curated wallet icons (MetaMask, Coinbase
 * Wallet, WalletConnect, plus any other connector wagmi has
 * registered). Each wallet inside the modal either auto-detects the
 * browser extension (injected path) or shows a QR code the user scans
 * from their mobile wallet (WalletConnect path). ConnectKit also
 * handles reconnect-on-reload, session restoration, and wallet-app
 * deep-linking on mobile.
 *
 * We keep our own presentational wrapper rather than using ConnectKit's
 * default-styled button so the trigger matches the app's button family
 * (`btn btn-primary`), tooltip tokens, and size classes.
 *
 * Once the user is connected, the surrounding components (Navbar,
 * AppLayout topbar) render the address badge + disconnect control
 * themselves — this button stays mounted only for the disconnected
 * state, which matches the previous component's behaviour.
 */
export function ConnectWalletButton({ className = '', fullWidth = false }: Props) {
  const { t } = useTranslation();
  return (
    <ConnectKitButton.Custom>
      {({ show, isConnecting }) => (
        <button
          type="button"
          className={`btn btn-primary ${className}`}
          onClick={() => show?.()}
          disabled={isConnecting}
          // Mobile / fullWidth render: explicitly centre the icon +
          // label inside the button so the visual matches the
          // sibling "Launch App" CTA. The `.btn` base sets
          // `display: inline-flex; align-items: center` but defaults
          // to `justify-content: flex-start` — fine when the button
          // wraps its content tightly, but at `width: 100%` the
          // content slid to the left edge instead of centering.
          style={
            fullWidth
              ? { width: '100%', justifyContent: 'center' }
              : undefined
          }
        >
          <Wallet size={16} />
          {isConnecting ? t('shared.connecting') : t('common.connectWallet')}
        </button>
      )}
    </ConnectKitButton.Custom>
  );
}
