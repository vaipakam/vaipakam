/**
 * Shared eligibility logic for write flows. Turns wallet, network,
 * balance, token-validity, and consent state into Checklist items
 * with inline remedies. Every guided flow calls this so the checks
 * read identically across borrow / lend / repay / claim.
 */
import { useModal } from 'connectkit';
import { useActiveChain } from '../chain/useActiveChain';
import { copy } from '../content/copy';
import type { CheckItem } from './Checklist';
import type { TokenMeta } from '../contracts/erc20';

export interface EligibilityInputs {
  /** Token being locked/paid by the user, once resolved on-chain. */
  asset?: {
    meta: TokenMeta | undefined;
    metaError: boolean;
    /** Wallet balance (undefined while loading). */
    balance: bigint | undefined;
    /** Amount the action needs (undefined = amount not entered yet). */
    required: bigint | undefined;
  };
  /** Risk + terms consent checkbox state; omit for flows without one. */
  consent?: boolean;
}

export function useEligibility(inputs: EligibilityInputs): CheckItem[] {
  const { isConnected, onSupportedChain, switchToSupported, switchPending } =
    useActiveChain();
  const { setOpen } = useModal();

  const items: CheckItem[] = [];

  items.push({
    id: 'wallet',
    label: isConnected ? copy.checks.walletConnected : copy.wallet.connectFirst,
    state: isConnected ? 'pass' : 'fail',
    fix: (
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => setOpen(true)}
      >
        {copy.wallet.connect}
      </button>
    ),
  });

  items.push({
    id: 'network',
    label: copy.checks.supportedChain,
    state: !isConnected ? 'pending' : onSupportedChain ? 'pass' : 'fail',
    fix: (
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={switchPending}
        onClick={() => switchToSupported()}
      >
        {copy.wallet.switchNetwork}
      </button>
    ),
  });

  const asset = inputs.asset;
  if (asset) {
    items.push({
      id: 'token',
      label: asset.metaError ? copy.errors.notAToken : copy.checks.tokenValid,
      state: asset.metaError ? 'fail' : asset.meta ? 'pass' : 'pending',
    });

    const symbol = asset.meta?.symbol ?? 'tokens';
    const balanceKnown =
      asset.balance !== undefined && asset.required !== undefined;
    items.push({
      id: 'balance',
      label:
        balanceKnown && asset.balance! < asset.required!
          ? copy.errors.needMore(symbol)
          : copy.checks.balanceSufficient(symbol),
      state: !balanceKnown
        ? 'pending'
        : asset.balance! >= asset.required!
          ? 'pass'
          : 'fail',
    });
  }

  if (inputs.consent !== undefined) {
    items.push({
      id: 'consent',
      label: copy.checks.consent,
      state: inputs.consent ? 'pass' : 'fail',
    });
  }

  return items;
}
