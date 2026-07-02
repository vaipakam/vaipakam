/**
 * Shared eligibility logic for write flows. Turns wallet, network,
 * balance, token-validity, and consent state into Checklist items
 * with inline remedies. Every guided flow calls this so the checks
 * read identically across borrow / lend / repay / claim.
 */
import { useModal } from 'connectkit';
import { useActiveChain } from '../chain/useActiveChain';
import { useSanctionsCheck } from '../data/sanctions';
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
  /** The OTHER ERC-20 leg of the deal (not paid by this user) — its
   *  token validity still gates the receipt, so surface it as a
   *  fixable item instead of an eternal "Preparing your review…". */
  counterAsset?: {
    label: string;
    meta: TokenMeta | undefined;
    metaError: boolean;
  };
  /** Risk + terms consent checkbox state; omit for flows without one. */
  consent?: boolean;
}

export function useEligibility(inputs: EligibilityInputs): CheckItem[] {
  const { isConnected, onSupportedChain, switchToSupported, switchPending } =
    useActiveChain();
  const { setOpen } = useModal();
  const sanctioned = useSanctionsCheck();

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

  // Sanctions gate: a flagged wallet's create/accept would revert
  // on-chain AFTER the approval tx already mined — block before any
  // gas is spent. Fail-open (unflagged/unknown → no item shown).
  if (sanctioned) {
    items.push({
      id: 'sanctions',
      label: copy.sanctions.line2,
      state: 'fail',
    });
  }

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

  const counter = inputs.counterAsset;
  if (counter) {
    items.push({
      id: 'counter-token',
      label: counter.metaError
        ? `${counter.label}: ${copy.errors.notAToken}`
        : `${counter.label} recognised (${counter.meta?.symbol ?? '…'})`,
      state: counter.metaError ? 'fail' : counter.meta ? 'pass' : 'pending',
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
