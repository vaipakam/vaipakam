/**
 * The retired app's routes that need more than a `<Navigate>` (#2076).
 * The plain aliases live in `App.tsx`; the mappings are in
 * `lib/legacyRoutes.ts`.
 */
import { Link, Navigate, useParams } from 'react-router-dom';
import { BookOpen, LoaderCircle, Repeat } from 'lucide-react';
import { copy } from '../content/copy';
import { EmptyState } from '../components/EmptyState';
import { useActiveChain } from '../chain/useActiveChain';
import { useOffer } from '../data/hooks';
import { offerAcceptPath } from '../data/offerLinks';
import { parseLegacyOfferId } from '../lib/legacyRoutes';
import { NotFound } from './NotFound';

/**
 * `/offers/:offerId` → the flow that takes that offer.
 *
 * The retired app had an offer detail page; here an offer is opened in the
 * guided flow for its side, the same place the Offer Book's "Use this
 * offer" goes. Which flow depends on the offer, so it is read first.
 *
 * The old link carries no network, and offer numbers repeat across
 * networks, so it is resolved on the network the app is reading now — and
 * the not-found state says that, rather than implying the offer is gone.
 */
export function LegacyOfferRedirect() {
  const id = parseLegacyOfferId(useParams().offerId);
  const { readChain } = useActiveChain();
  const offer = useOffer(id);
  if (id === undefined) return <NotFound />;
  if (offer.data) return <Navigate to={offerAcceptPath(offer.data)} replace />;
  if (offer.isPending) {
    return (
      <EmptyState
        icon={LoaderCircle}
        titleAs="h1"
        title={copy.legacyRoutes.offerLookup(String(id), readChain.name)}
      />
    );
  }
  // `useOffer` answers null both for an offer that does not exist and for
  // one neither the index nor the chain could be asked about, so the copy
  // names both rather than choosing.
  return (
    <EmptyState
      icon={BookOpen}
      titleAs="h1"
      title={copy.legacyRoutes.offerMissingTitle(String(id), readChain.name)}
      body={copy.legacyRoutes.offerMissingBody}
      action={
        <Link to="/offers" className="btn btn-primary">
          {copy.legacyRoutes.toOfferBook}
        </Link>
      }
    />
  );
}

/**
 * `/auto-lend` — the retired standing-intent page. This app has no page for
 * standing lending intents yet (#2526), so there is no destination that does
 * what the bookmark was for. It says so, and says what it cannot show,
 * instead of a not-found page that reads as a broken app.
 */
export function RetiredAutoLend() {
  return (
    <EmptyState
      icon={Repeat}
      titleAs="h1"
      title={copy.legacyRoutes.autoLendTitle}
      body={copy.legacyRoutes.autoLendBody}
      action={
        <Link to="/lend" className="btn btn-primary">
          {copy.legacyRoutes.toLend}
        </Link>
      }
    />
  );
}
