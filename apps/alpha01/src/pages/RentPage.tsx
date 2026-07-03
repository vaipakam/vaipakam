import { Link } from 'react-router-dom';
import { HelpLink } from '../components/HelpLink';

export function RentPage() {
  return (
    <div>
      <h1 className="page-title">Rent or lend an NFT</h1>
      <p className="page-subtitle">
        NFT rentals use temporary use rights — not a debt loan. <HelpLink anchor="nft-rental" />
      </p>

      <div className="intent-grid" style={{ marginTop: 16 }}>
        <div className="intent-card">
          <h3>I own an NFT</h3>
          <p>List your NFT for rent. It stays in vault custody; the renter gets temporary rights only.</p>
          <a href="https://defi.vaipakam.com" className="btn btn-secondary" style={{ marginTop: 12 }} target="_blank" rel="noreferrer">
            Open classic app to list
          </a>
        </div>
        <div className="intent-card">
          <h3>I want to rent one</h3>
          <p>Browse ERC-721 and ERC-1155 rental offers. You will see daily fee, prepay, and duration before signing.</p>
          <a href="https://defi.vaipakam.com" className="btn btn-secondary" style={{ marginTop: 12 }} target="_blank" rel="noreferrer">
            Browse rentals in classic app
          </a>
        </div>
      </div>

      <p style={{ marginTop: 16, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
        Full NFT rental wizards land in alpha01 Phase P4. <Link to="/">Back to home</Link>
      </p>
    </div>
  );
}