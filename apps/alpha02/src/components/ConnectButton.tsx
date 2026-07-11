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
          className={`btn ${isConnected ? 'btn-secondary' : 'btn-primary'} ${block ? 'btn-block' : ''}`}
          onClick={show}
        >
          <Wallet aria-hidden size={18} />
          {isConnected && address ? (
            /* The shortened address is one token — never let the header
               chip wrap it onto two lines ("0x1DAe…" / "8282" reads
               like two unrelated values on phones — UX-020). */
            <span style={{ whiteSpace: 'nowrap' }}>
              <AddressName address={address} />
            </span>
          ) : (
            copy.wallet.connect
          )}
        </button>
      )}
    </ConnectKitButton.Custom>
  );
}
