import { useCopy } from '../copy/useCopy';

/** Where the short page on self-custody wallets and their keys lives (#3671). */
export const WALLET_KEYS_PATH = '/wallet-keys';

/**
 * #3671 — the one statement made before anyone connects: the app needs a
 * self-custody wallet, never holds or recovers its keys, and losing the keys
 * loses the funds. It sits inside the wallet picker (ConnectKit's
 * `disclaimer`, rendered outside the router, so the link is a plain anchor
 * opening a new tab and the picker stays where it was) and on Home for a
 * visitor with no wallet connected. It recommends no wallet.
 */
export function WalletNeeded({ testId }: { testId: string }) {
  const { text } = useCopy();
  return (
    <p className="tier-b wallet-needed" data-testid={testId}>
      {text('walletKeys.needed')}{' '}
      <a href={WALLET_KEYS_PATH} target="_blank" rel="noopener">
        {text('walletKeys.link')}
      </a>
    </p>
  );
}
