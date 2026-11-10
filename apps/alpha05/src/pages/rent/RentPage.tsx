import { Link } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { getSupportedChain } from '../../chain/chains';
import { useOwnStateClient } from '../../chain/ownRail';
import { useCopy } from '../../shared/copy/useCopy';
import { faucetAssets } from '../../shared/faucet/faucet';
import { WhyLink } from '../../shared/help/WhyLink';
import { OfferBook } from '../../shared/offers/OfferBook';
import { useTerms } from '../../shared/terms/useTerms';
import { Notice } from '../../shared/ui/Notice';
import { RentPostSection, useRentPostOpen } from './RentPostSection';

/**
 * Rent (NFT-01, NFT-02, NFT-03, NFT-38): the rental book on the wallet's
 * network, the rentals tab alone, owners' listings first; each row opens the
 * offer's page, which reads it from the chain and offers the rental review
 * for an owner's listing. An empty book on a test network offers the faucet
 * as the next step. Below it, an owner lists an NFT for rent and a renter
 * posts a request to rent one, each through its own form and review, behind
 * the Terms gate; while either is open the book steps aside, and only one
 * is open at a time.
 */
export function RentPage() {
  const { text, format } = useCopy();
  const { status, chainId } = useAccount();
  const own = useOwnStateClient();
  const chain = getSupportedChain(own?.chainId ?? chainId);
  const connected = status === 'connected';
  const served = connected && chain !== null && own !== null ? { chain, own } : null;
  const testAssets = chain ? (faucetAssets(chain) ?? []) : [];
  const testNfts = testAssets.some((a) => a.kind === 'nft' || a.kind === 'multi');

  const terms = useTerms();
  const termsUnknown = served !== null && terms.state === 'failed';
  const listing = useRentPostOpen('list');
  const requesting = useRentPostOpen('request');

  return (
    <main className="page rent" aria-labelledby="rent-title">
      <h1 id="rent-title">{text('rentPage.title')}</h1>
      <p className="tier-b">{text('rentPage.lead')}</p>
      {!connected && (
        <p className="tier-b" data-testid="rent-connect">
          {text('rentPage.connect')}
        </p>
      )}
      {connected && chain === null && <p className="tier-b">{text('rentPage.unsupported')}</p>}
      {termsUnknown && (
        <Notice tone="warn" tier="A">
          {format('consent.termsUnknown', { chain: served.chain.name, reason: terms.error ?? 'no answer' })}{' '}
          <button type="button" className="btn" onClick={terms.refetch}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      {served && !listing && !requesting && (
        <OfferBook
          viewer={served.own.account}
          rentals
          empty={
            <div className="card" data-testid="rent-empty">
              <p className="tier-b">{format('rentPage.empty', { chain: served.chain.name })}</p>
              {testNfts && (
                <p className="tier-b">
                  {text('rentPage.emptyFaucet')}{' '}
                  <Link to="/#faucet" data-testid="rent-faucet">
                    {text('rentPage.faucetLink')}
                  </Link>
                </p>
              )}
            </div>
          }
        />
      )}
      <RentPostSection side="list" served={served} terms={terms} otherOpen={requesting} />
      <RentPostSection side="request" served={served} terms={terms} otherOpen={listing} />
      <WhyLink summaryKey="rentPage.whySummary" detailKey="rentPage.why" />
    </main>
  );
}
