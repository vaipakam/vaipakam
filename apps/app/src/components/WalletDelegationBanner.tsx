/**
 * #3434 — warns the connected wallet's owner that the wallet is EIP-7702
 * delegated: another contract's code runs with the wallet's authority, so
 * that contract can act on the owner's vault too.
 *
 * A warning only. Nothing in the app is blocked, and the app never asks a
 * user to sign a 7702 authorization. The owner can answer "I set this up";
 * that answer is kept in this browser for the delegate they saw, and a
 * delegation that moves to another contract is warned about again.
 *
 * The code is read on the wallet's own chain, and only when that chain is
 * supported. A failed read shows nothing: a warning is never shown on a
 * guess. The agent's delegation watch tells a linked owner of the same
 * changes on their channels.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TriangleAlert } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { useActiveChain } from '../chain/useActiveChain';
import { copy } from '../content/copy';
import {
  readDelegationAck,
  walletDelegationNotice,
  writeDelegationAck,
} from '../data/walletDelegationNotice';

/** How often the wallet's code is read again while the app is open. */
const REFRESH_MS = 120_000;

export function WalletDelegationBanner() {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const chainId = walletChain?.chainId;
  const publicClient = usePublicClient({ chainId });
  // Bumped on "I set this up" so the stored answer is read again.
  const [, setAckTick] = useState(0);

  const enabled = Boolean(onSupportedChain && address && publicClient && chainId);
  const code = useQuery({
    queryKey: ['walletDelegation', chainId, address?.toLowerCase()],
    enabled,
    queryFn: async () => ({ code: (await publicClient!.getCode({ address: address! })) ?? null }),
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
    retry: 1,
  });

  if (!enabled || !code.data || !address || !chainId) return null;
  const notice = walletDelegationNotice(code.data.code, readDelegationAck(chainId, address));
  if (notice.kind === 'none') return null;

  return (
    <div className="banner banner-warn" role="alert" data-testid="wallet-delegation-banner">
      <TriangleAlert aria-hidden />
      <div className="banner-body">
        <div className="banner-title">{copy.walletDelegation.title}</div>
        <p>{copy.walletDelegation.body(notice.delegate)}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <Link className="btn btn-secondary btn-sm" to="/vault/protection">
            {copy.walletDelegation.protect}
          </Link>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-testid="wallet-delegation-ack"
            onClick={() => {
              writeDelegationAck(chainId, address, notice.delegate);
              setAckTick((n) => n + 1);
            }}
          >
            {copy.walletDelegation.ack}
          </button>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          {copy.walletDelegation.ackNote}
        </p>
      </div>
    </div>
  );
}
