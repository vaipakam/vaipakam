import { Link } from 'react-router-dom';
import { useCopy, type CopyKey } from '../../shared/copy/useCopy';
import { RISKS_PATH } from '../../shared/risk/keyRisks';

/** The key-safety points, in reading order. */
const KEY_POINTS: readonly CopyKey[] = ['walletKeys.whatIs', 'walletKeys.phrase', 'walletKeys.never', 'walletKeys.check', 'walletKeys.device', 'walletKeys.small'];

/**
 * #3671 — what a self-custody wallet is and how to keep its keys safe. A
 * public page: no wallet, nothing read from the chain, no wallet brand
 * named. The platform creates no wallets (owner decision 2026-11-15, #3662
 * parked), so this page is where a visitor without one learns what they
 * need, and what nobody here can do for them.
 */
export function WalletKeysPage() {
  const { text } = useCopy();
  return (
    <section aria-labelledby="wallet-keys-title" data-testid="wallet-keys-page">
      <h1 id="wallet-keys-title">{text('walletKeys.pageTitle')}</h1>
      <p className="tier-a">{text('walletKeys.pageIntro')}</p>
      <ul className="consequences tier-a" data-testid="wallet-keys-points">
        {KEY_POINTS.map((k) => (
          <li key={k}>{text(k)}</li>
        ))}
      </ul>
      <h2>{text('walletKeys.connectTitle')}</h2>
      <p className="tier-b" data-testid="wallet-keys-connect">
        {text('walletKeys.connectComputer')} {text('walletKeys.connectPhone')}
      </p>
      <p className="tier-b" data-testid="wallet-keys-browse">
        {text('walletKeys.browse')}
      </p>
      <p className="tier-b">
        <Link to={RISKS_PATH}>{text('keyRisks.all')}</Link>
      </p>
    </section>
  );
}
