import { Link } from "react-router-dom";
import { ArrowRight, Coins } from "lucide-react";
import "./Hero.css";

export default function Hero() {
  return (
    <section className="hero" id="hero">
      <div className="hero-bg-glow" />
      <div className="container hero-container">
        <div className="hero-content">
          <div className="hero-brand">Vaipakam</div>

          <h1 className="hero-title">
            Peer-to-Peer Lending
            <br />
            <span className="hero-gradient">Fully On-Chain</span>
          </h1>

          <p className="hero-subtitle">
            <strong>Vaipakam</strong> lets you lend and borrow tokens, rent
            NFTs, and set your own terms. Every position is tracked by a unique
            NFT — transparent, traceable and trustless from offer to settlement.
          </p>

          <div className="hero-actions">
            <Link to="/app" className="btn btn-primary btn-lg">
              Launch App <ArrowRight size={18} />
            </Link>
            <Link to="/buy-vpfi" className="btn btn-secondary btn-lg">
              <Coins size={18} /> Buy VPFI
            </Link>
            <a href="#how-it-works" className="btn btn-ghost btn-lg">
              How It Works
            </a>
          </div>

          <div className="hero-stats">
            <div className="hero-stat">
              <span className="hero-stat-value">P2P</span>
              <span className="hero-stat-label">Direct Lending</span>
            </div>
            <div className="hero-stat-divider" />
            <div className="hero-stat">
              <span className="hero-stat-value">NFT</span>
              <span className="hero-stat-label">Position Tracking</span>
            </div>
            <div className="hero-stat-divider" />
            <div className="hero-stat">
              <span className="hero-stat-value">1:1</span>
              <span className="hero-stat-label">Isolated Escrow</span>
            </div>
          </div>
        </div>

        <div className="hero-visual">
          <div className="hero-card hero-card-1">
            <div className="hero-card-icon lend">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="1" x2="12" y2="23" />
                <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            </div>
            <div>
              <div className="hero-card-title">Lend 1,000 USDC</div>
              <div className="hero-card-meta">
                5% APR &middot; 30 days &middot; ETH collateral
              </div>
            </div>
            <span className="hero-card-status active">Active</span>
          </div>

          <div className="hero-card hero-card-2">
            <div className="hero-card-icon rent">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
              </svg>
            </div>
            <div>
              <div className="hero-card-title">Rent Axie #1234</div>
              <div className="hero-card-meta">
                10 USDC/day &middot; 7 days &middot; ERC-4907
              </div>
            </div>
            <span className="hero-card-status pending">Matched</span>
          </div>

          <div className="hero-card hero-card-3">
            <div className="hero-card-icon repay">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <div>
              <div className="hero-card-title">Loan Repaid</div>
              <div className="hero-card-meta">
                1,004.11 USDC settled &middot; Collateral released
              </div>
            </div>
            <span className="hero-card-status settled">Closed</span>
          </div>
        </div>
      </div>
    </section>
  );
}
