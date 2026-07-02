/**
 * NFT rental entry — deliberately separated from debt lending
 * (Journey N1/N2: "the app does not describe NFT rental as a debt
 * loan"). The guided posting/renting flows are the next alpha02
 * milestone; this page already teaches the custody model correctly
 * so the mental model is right before the writes arrive.
 */
import { Images, KeyRound } from 'lucide-react';
import { copy } from '../content/copy';

export function Rent() {
  return (
    <div>
      <h1 className="page-title">{copy.rent.title}</h1>
      <p className="page-lede">{copy.rent.lede}</p>

      <div className="banner banner-info">
        <span className="banner-body">{copy.rent.comingSoon}</span>
      </div>

      <div className="intent-grid">
        <div className="intent-card" aria-disabled>
          <span className="intent-icon">
            <Images aria-hidden />
          </span>
          <span>
            <h3>{copy.rent.ownPath}</h3>
            <p>
              Set a daily fee and a duration. Renters prepay the whole rental
              plus a small refundable buffer. {copy.rent.custodyNote}
            </p>
          </span>
        </div>
        <div className="intent-card" aria-disabled>
          <span className="intent-icon">
            <KeyRound aria-hidden />
          </span>
          <span>
            <h3>{copy.rent.wantPath}</h3>
            <p>
              Browse rentable NFTs, see the full prepay before signing, and use
              the NFT until the rental ends. You get use rights — never
              ownership.
            </p>
          </span>
        </div>
      </div>
    </div>
  );
}
