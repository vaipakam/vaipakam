import {
  Repeat,
  Shield,
  Image,
  Wallet,
  BarChart3,
  Bell,
  Award,
  ArrowLeftRight,
} from 'lucide-react';
import './Features.css';

const FEATURES = [
  {
    icon: <Repeat size={24} />,
    title: 'P2P Lending & Borrowing',
    description:
      'Create or accept offers for ERC-20 tokens with your own terms — interest rate, collateral type, and loan duration. No intermediary pools.',
  },
  {
    icon: <Image size={24} />,
    title: 'NFT Rentals (ERC-4907)',
    description:
      'Rent out ERC-721 and ERC-1155 NFTs with daily pricing. Borrowers get user rights while the NFT stays safely in escrow.',
  },
  {
    icon: <Wallet size={24} />,
    title: 'Per-User Isolated Escrow',
    description:
      'Every user gets their own UUPS upgradeable escrow proxy. No fund commingling — your assets are always isolated.',
  },
  {
    icon: <Award size={24} />,
    title: 'NFT Position Tracking',
    description:
      'Every offer and loan mints a unique Vaipakam NFT with on-chain metadata. Prove ownership, claim funds, and track status on any marketplace.',
  },
  {
    icon: <BarChart3 size={24} />,
    title: 'Liquid vs Illiquid Assets',
    description:
      'Chainlink oracles + on-chain DEX liquidity checks determine asset status. Liquid assets get LTV monitoring; illiquid assets use full collateral transfer.',
  },
  {
    icon: <Shield size={24} />,
    title: 'Two Liquidation Paths',
    description:
      'Health Factor drops below threshold? Permissionless DEX liquidation kicks in. Grace period expired? Time-based default with collateral transfer.',
  },
  {
    icon: <ArrowLeftRight size={24} />,
    title: 'Preclose & Refinance',
    description:
      'Borrowers can early-repay, transfer debt to another borrower, or offset with a new lender position — all while protecting the original lender.',
  },
  {
    icon: <Bell size={24} />,
    title: 'Smart Notifications',
    description:
      'Platform-funded SMS and email alerts for LTV warnings, repayment reminders, liquidation events, and claimable funds.',
  },
];

export default function Features() {
  return (
    <section className="section features" id="features">
      <div className="container">
        <div className="features-header">
          <span className="section-label">Features</span>
          <h2 className="section-title">
            Everything you need for trustless lending
          </h2>
          <p className="section-subtitle">
            A complete DeFi lending protocol built on the Diamond Standard,
            supporting ERC-20 tokens and rentable NFTs across Ethereum, Polygon,
            and Arbitrum.
          </p>
        </div>

        <div className="features-grid">
          {FEATURES.map((f) => (
            <div key={f.title} className="feature-card">
              <div className="feature-icon">{f.icon}</div>
              <h3 className="feature-title">{f.title}</h3>
              <p className="feature-desc">{f.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
