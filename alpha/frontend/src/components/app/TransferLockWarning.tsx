import { AlertTriangle, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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

const FLOW_SIDE: Record<LockFlow, 'lender' | 'borrower'> = {
  preclose: 'borrower',
  'early-withdrawal': 'lender',
  refinance: 'borrower',
};

const FLOW_LABEL_KEY: Record<LockFlow, string> = {
  preclose: 'transferLockWarning.flowPreclose',
  'early-withdrawal': 'transferLockWarning.flowEarlyWithdrawal',
  refinance: 'transferLockWarning.flowRefinance',
};

const LOCK_LABEL_KEY: Record<LockReason, string | null> = {
  [LockReason.None]: null,
  [LockReason.PrecloseOffset]: 'transferLockWarning.lockPrecloseOffset',
  [LockReason.EarlyWithdrawalSale]: 'transferLockWarning.lockEarlyWithdrawalSale',
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
  const { t } = useTranslation();
  if (props.mode === 'pre-confirm') {
    const { flow, tokenId, role } = props;
    const side = FLOW_SIDE[flow];
    const flowLabel = t(FLOW_LABEL_KEY[flow]);
    const tokenIdStr = tokenId.toString();
    return (
      <div className="alert alert-warning" style={{ display: 'block' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
          <AlertTriangle size={18} />
          <strong>{t('transferLockWarning.preconfirmTitle')}</strong>
        </div>
        <p style={{ margin: 0 }}>
          {side === 'lender'
            ? t('transferLockWarning.preconfirmBodyLender', { tokenId: tokenIdStr, flow: flowLabel })
            : t('transferLockWarning.preconfirmBodyBorrower', { tokenId: tokenIdStr, flow: flowLabel })}
          {role !== side && (
            <>{' '}{t('transferLockWarning.preconfirmCrossRoleNote')}</>
          )}
        </p>
      </div>
    );
  }

  const { lock, tokenId } = props;
  const labelKey = LOCK_LABEL_KEY[lock];
  if (!labelKey) return null;
  return (
    <div className="alert alert-warning" style={{ display: 'block' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
        <Lock size={18} />
        <strong>{t('transferLockWarning.activeTitle', { tokenId: tokenId.toString() })}</strong>
      </div>
      <p style={{ margin: 0 }}>
        {t('transferLockWarning.activeBody', { reason: t(labelKey) })}
      </p>
    </div>
  );
}
