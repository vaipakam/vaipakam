import './HowItWorks.css';

const STEPS = [
  {
    number: '01',
    title: 'Create an Offer',
    description:
      'As a lender, specify your asset, interest rate, collateral requirements, and duration. As a borrower, state what you need and the collateral you can provide. Your assets are locked in your personal escrow.',
    details: ['ERC-20 lending or NFT rental', 'Set your own terms', 'Vaipakam NFT minted for your position'],
  },
  {
    number: '02',
    title: 'Match & Initiate',
    description:
      'Browse the offer book, filter by asset type or rate, and accept a compatible offer. The accepting party pays gas. Collateral is locked, funds transfer, and both parties receive position NFTs.',
    details: ['Auto-matching suggestions', 'On-chain liquidity verification', 'LTV & Health Factor validation'],
  },
  {
    number: '03',
    title: 'Manage Your Loan',
    description:
      'Monitor your position via the dashboard. Add collateral if LTV rises. Withdraw excess if your Health Factor is strong. Get notified before critical thresholds are breached.',
    details: ['Real-time LTV tracking', 'Collateral management', 'SMS & email alerts'],
  },
  {
    number: '04',
    title: 'Settle or Claim',
    description:
      'Repay on time and reclaim your collateral. Lenders claim principal + interest using their NFT. If default occurs, liquidation or full collateral transfer follows the protocol rules.',
    details: [
      'Present NFT to claim funds',
      'Late fees capped at 5%',
      '0.1% Loan Initiation Fee + 1% Yield Fee on interest',
      'Tiered VPFI discount: 10% / 15% / 20% / 24% off both fees by escrow balance',
    ],
  },
];

export default function HowItWorks() {
  return (
    <section className="section how-it-works" id="how-it-works">
      <div className="container">
        <div className="how-header">
          <span className="section-label">How It Works</span>
          <h2 className="section-title">From offer to settlement in four steps</h2>
          <p className="section-subtitle">
            Every action is recorded on-chain. Position NFTs provide proof of ownership
            and are required to claim your funds.
          </p>
        </div>

        <div className="steps-grid">
          {STEPS.map((step, i) => (
            <div key={step.number} className="step-card">
              <div className="step-number">{step.number}</div>
              <h3 className="step-title">{step.title}</h3>
              <p className="step-desc">{step.description}</p>
              <ul className="step-details">
                {step.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
              {i < STEPS.length - 1 && <div className="step-connector" />}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
