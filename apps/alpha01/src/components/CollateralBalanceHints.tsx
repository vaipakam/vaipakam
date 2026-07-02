import type { CollateralBalanceAssessment } from '../lib/balanceCheck';
import { AssetAmount } from './AssetAmount';

interface Props {
  assessment: CollateralBalanceAssessment;
  variant: 'available' | 'shortfall';
}

export function CollateralBalanceHint({ assessment, variant }: Props) {
  if (variant === 'available') {
    if (assessment.loading) return <>Checking balance…</>;
    if (!assessment.available) return null;
    return (
      <>
        Available:{' '}
        <AssetAmount
          mode={assessment.available.mode}
          amount={assessment.available.amount}
          address={assessment.available.address}
          meta={assessment.available.meta}
        />{' '}
        (wallet + vault)
      </>
    );
  }

  if (!assessment.shortfall) return null;
  const { need, have } = assessment.shortfall;
  return (
    <>
      Insufficient balance — you need{' '}
      <AssetAmount mode={need.mode} amount={need.amount} address={need.address} meta={need.meta} /> but have{' '}
      <AssetAmount mode={have.mode} amount={have.amount} address={have.address} meta={have.meta} />.
    </>
  );
}