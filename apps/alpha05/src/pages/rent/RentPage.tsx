import { Link } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { getSupportedChain } from '../../chain/chains';
import { useOwnStateClient } from '../../chain/ownRail';
import { PAGES, currentAppHref } from '../../routes/pageMap';
import { useCopy } from '../../shared/copy/useCopy';
import { faucetAssets } from '../../shared/faucet/faucet';
import { WhyLink } from '../../shared/help/WhyLink';
import { OfferBook } from '../../shared/offers/OfferBook';

/**
 * Rent (NFT-02, NFT-03, NFT-38): the rental book on the wallet's network,
 * the rentals tab alone, owners' listings first; each row opens the offer's
 * page, which reads it from the chain and offers the rental review for an
 * owner's listing. An empty book on a test network offers the faucet as the
 * next step. Listing an NFT for rent and posting a renter's request are not
 * built here yet, and the page says where they are done today.
 */
export function RentPage() {
  const { text, format } = useCopy();
  const { status, chainId } = useAccount();
  const own = useOwnStateClient();
  const chain = getSupportedChain(own?.chainId ?? chainId);
  const connected = status === 'connected';
  const served = connected && chain !== null && own !== null;
  const testAssets = chain ? (faucetAssets(chain) ?? []) : [];
  const testNfts = testAssets.some((a) => a.kind === 'nft' || a.kind === 'multi');
  const page = PAGES.find((p) => p.path === '/rent');
  const listHref = page ? currentAppHref(page, {}) : null;

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
      {served && (
        <OfferBook
          viewer={own.account}
          rentals
          empty={
            <div className="card" data-testid="rent-empty">
              <p className="tier-b">{format('rentPage.empty', { chain: chain.name })}</p>
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
      <section className="home-section" aria-labelledby="rent-list-title" data-testid="rent-list">
        <h2 id="rent-list-title">{text('rentPage.listTitle')}</h2>
        <p className="tier-b">
          {text('rentPage.listLater')}{' '}
          {listHref !== null && (
            <a href={listHref} target="_blank" rel="noreferrer">
              {text('vault.openCurrent')}
            </a>
          )}
        </p>
      </section>
      <WhyLink summaryKey="rentPage.whySummary" detailKey="rentPage.why" />
    </main>
  );
}
