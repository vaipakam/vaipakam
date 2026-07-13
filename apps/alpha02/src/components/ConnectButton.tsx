/**
 * Wallet connect button — thin wrapper over ConnectKit so every
 * surface shows the same connect affordance. Shows the connected
 * account's ENS name when it has one, else the short address
 * (#1030); the full picker/account modal is ConnectKit's.
 */
import { ConnectKitButton } from 'connectkit';
import { Wallet } from 'lucide-react';
import { copy } from '../content/copy';
import { AddressName } from './AddressName';

export function ConnectButton({ block = false }: { block?: boolean }) {
  return (
    <ConnectKitButton.Custom>
      {({ isConnected, show, address }) => (
        <button
          type="button"
          className={`btn ${isConnected ? 'btn-secondary' : 'btn-primary'} ${block ? 'btn-block' : ''} connect-btn`}
          onClick={show}
        >
          <Wallet aria-hidden size={18} className="connect-btn-icon" />
          {isConnected && address ? (
            /* The shortened address is one token — never let the header
               chip wrap it onto two lines ("0x1DAe…" / "8282" reads
               like two unrelated values on phones — UX-020). Long ENS
               reverse names get ellipsized instead of forcing the chip
               wider than a narrow viewport (Codex #1156 r2). Styling
               lives on .connect-addr (not inline) so the phone-width
               header rules can tighten it — UX2-001. */
            <span className="connect-addr">
              <AddressName address={address} />
            </span>
          ) : (
            /* One token too — the label used to wrap "Connect /
               wallet" onto two lines at 390px (UX2-006). */
            <span className="connect-label">{copy.wallet.connect}</span>
          )}
        </button>
      )}
    </ConnectKitButton.Custom>
  );
}
