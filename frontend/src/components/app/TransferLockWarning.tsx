import { AlertTriangle, Lock } from 'lucide-react';
import { LockReason } from '../../hooks/usePositionLock';

export type LockFlow = 'preclose' | 'early-withdrawal' | 'refinance';

interface PreConfirmProps {
  mode: 'pre-confirm';
  flow: LockFlow;
  tokenId: bigint;
  role: 'lender' | 'borrower';
}

interface ActiveProps {
  mode: 'active';
  lock: LockReason;
  tokenId: bigint;
}

type Props = PreConfirmProps | ActiveProps;

const FLOW_COPY: Record<LockFlow, { side: 'lender' | 'borrower'; label: string }> = {
  preclose: { side: 'borrower', label: 'preclose' },
  'early-withdrawal': { side: 'lender', label: 'early-withdrawal' },
  refinance: { side: 'borrower', label: 'refinance' },
};

const LOCK_COPY: Record<LockReason, string | null> = {
  [LockReason.None]: null,
  [LockReason.PrecloseOffset]: 'preclose offset (Option 3)',
  [LockReason.EarlyWithdrawalSale]: 'lender early-withdrawal sale',
};

/**
 * Surfaces the native Vaipakam-NFT transfer lock per WebsiteReadme spec
 * (§"Strategic-flow transfer-lock UX requirements").
 *
 * - `pre-confirm` mode renders the mandatory pre-signature warning so the
 *   user knows the NFT will be locked the moment they sign.
 * - `active` mode renders the current lock state read from
 *   {@link VaipakamNFTFacet.positionLock}, letting pages communicate that a
 *   flow is already in progress and how to unwind it.
 */
export function TransferLockWarning(props: Props) {
  if (props.mode === 'pre-confirm') {
    const { flow, tokenId, role } = props;
    const side = FLOW_COPY[flow].side;
    const sideName = side === 'lender' ? 'lender-side' : 'borrower-side';
    return (
      <div className="alert alert-warning" style={{ display: 'block' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
          <AlertTriangle size={18} />
          <strong>Vaipakam NFT transfer lock</strong>
        </div>
        <p style={{ margin: 0 }}>
          Submitting this transaction will lock your {sideName} Vaipakam NFT
          {' '}<span className="mono">#{tokenId.toString()}</span> from transfer and approval until this {FLOW_COPY[flow].label} flow
          completes or is cancelled. While locked, the NFT cannot be moved to another wallet, listed,
          sold, or approved on any marketplace, and its ownership-driven actions remain bound to this
          in-progress flow.
          {role !== side && (
            <>
              {' '}Note: you are acting as the current NFT holder — the lock applies to whoever owns the NFT at submission time.
            </>
          )}
        </p>
      </div>
    );
  }

  const { lock, tokenId } = props;
  const reason = LOCK_COPY[lock];
  if (!reason) return null;
  return (
    <div className="alert alert-warning" style={{ display: 'block' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
        <Lock size={18} />
        <strong>Vaipakam NFT #{tokenId.toString()} is locked</strong>
      </div>
      <p style={{ margin: 0 }}>
        This position NFT is currently locked by an in-progress {reason} flow.
        It cannot be transferred or approved until the responsible flow completes or the
        linked offer is cancelled.
      </p>
    </div>
  );
}
