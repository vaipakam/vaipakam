/**
 * Shared eligibility logic for write flows. Turns wallet, network,
 * balance, token-validity, and consent state into Checklist items
 * with inline remedies. Every guided flow calls this so the checks
 * read identically across borrow / lend / repay / claim.
 */
import { useModal } from 'connectkit';
import { Link } from 'react-router-dom';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { useActiveChain } from '../chain/useActiveChain';
import { useSanctionsCheck } from '../data/sanctions';
import { copy } from '../content/copy';
import { formatTokenAmount } from '../lib/format';
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
  const {
    isConnected,
    onSupportedChain,
    switchToSupported,
    switchPending,
    readChain,
  } = useActiveChain();
  const { setOpen } = useModal();
  const sanctions = useSanctionsCheck();
  // UX-010 — on a seeded testnet, "not enough balance" must not
  // dead-end: the faucet is one tap away. Same availability predicate
  // as the nav entry (chain is a testnet AND its mocks are deployed).
  const hasFaucet =
    readChain.testnet && Boolean(getDeployment(readChain.chainId)?.testnetMocks);

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
  // gas is spent. While the check is still LOADING the item shows as
  // pending (holds allChecksPass false); once settled it disappears
  // for clean wallets and fails for flagged ones.
  if (isConnected && !sanctions.ready) {
    items.push({
      id: 'sanctions',
      label: copy.checks.sanctionsChecking,
      state: 'pending',
    });
  } else if (sanctions.flagged) {
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
          ? // F-20260703-005 (#988) — state the shortfall when decimals
            // are known; plain "need more" only when they aren't.
            (asset.meta
              ? copy.errors.needMoreBy(
                  formatTokenAmount(
                    asset.required! - asset.balance!,
                    asset.meta.decimals,
                  ),
                  symbol,
                )
              : copy.errors.needMore(symbol))
          : copy.checks.balanceSufficient(symbol),
      state: !balanceKnown
        ? 'pending'
        : asset.balance! >= asset.required!
          ? 'pass'
          : 'fail',
      fix: hasFaucet ? (
        <Link to="/faucet" className="btn btn-secondary btn-sm">
          {copy.checks.getTestAssets}
        </Link>
      ) : undefined,
    });
  }

  const counter = inputs.counterAsset;
  if (counter) {
    items.push({
      id: 'counter-token',
      label: counter.metaError
        ? `${counter.label}: ${copy.errors.notAToken}`
        : copy.checks.recognised(counter.label, counter.meta?.symbol ?? '…'),
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
