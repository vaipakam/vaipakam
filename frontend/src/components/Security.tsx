import { Lock, Eye, Server, FileCheck, Users, AlertTriangle } from 'lucide-react';
import './Security.css';

const ITEMS = [
  {
    icon: <Lock size={22} />,
    title: 'Diamond Standard (EIP-2535)',
    description: 'Modular proxy architecture. Upgrade individual facets without disrupting the protocol. All calls route through a single diamond entry point.',
  },
  {
    icon: <Server size={22} />,
    title: 'Isolated Per-User Escrow',
    description: 'Each user gets a dedicated UUPS proxy escrow. No commingling of funds. Mandatory escrow upgrades block interactions until the user upgrades.',
  },
  {
    icon: <Eye size={22} />,
    title: 'On-Chain Transparency',
    description: 'Every offer, loan, and status change is recorded on-chain. Vaipakam NFTs serve as verifiable proof of position ownership.',
  },
  {
    icon: <AlertTriangle size={22} />,
    title: 'Slippage & Liquidation Safety',
    description: 'DEX liquidation aborts if slippage exceeds 6%. Falls back to full collateral transfer via NFT claim model. No forced bad swaps.',
  },
  {
    icon: <FileCheck size={22} />,
    title: 'Audited & Battle-Tested',
    description: 'Built on OpenZeppelin contracts. ReentrancyGuard and Pausable on all facets. Mandatory third-party audits before mainnet deployment.',
  },
  {
    icon: <Users size={22} />,
    title: 'Non-Custodial & No KYC',
    description: 'Phase 1 launches with KYC checks in pass-through mode. Vaipakam is non-custodial; users are responsible for their own regulatory compliance. Sanctions-country and tiered-KYC logic remains in the codebase for future governance activation.',
  },
];

export default function Security() {
  return (
    <section className="section security" id="security">
      <div className="container">
        <div className="security-header">
          <span className="section-label">Security & Trust</span>
          <h2 className="section-title">Built for safety at every layer</h2>
          <p className="section-subtitle">
            From smart contract architecture to liquidation mechanics,
            every design decision prioritizes the safety of your assets.
          </p>
        </div>

        <div className="security-grid">
          {ITEMS.map((item) => (
            <div key={item.title} className="security-card">
              <div className="security-icon">{item.icon}</div>
              <h3 className="security-card-title">{item.title}</h3>
              <p className="security-card-desc">{item.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
