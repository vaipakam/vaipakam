import { Link } from 'react-router-dom';
import { LegalLinks } from '../components/LegalLinks';
import { useMode } from '../context/ModeContext';
import { DEFI_CLASSIC_LINKS } from '../lib/defiClassicLinks';

export function MorePage() {
  const { mode } = useMode();

  return (
    <div>
      <h1 className="page-title">More</h1>
      <div className="position-list">
        <Link to="/activity" className="intent-card">
          <h3>Activity</h3>
          <p>Your on-chain loan and offer history.</p>
        </Link>
        <Link to="/claims" className="intent-card">
          <h3>Claims</h3>
          <p>Collect funds after a loan settles.</p>
        </Link>
        <Link to="/settings" className="intent-card">
          <h3>Settings</h3>
          <p>Theme, mode, and preferences.</p>
        </Link>
        <a href="https://www.vaipakam.com/help" className="intent-card" target="_blank" rel="noreferrer">
          <h3>Help &amp; guides</h3>
          <p>Step-by-step walkthroughs and FAQs.</p>
        </a>
        <a href={DEFI_CLASSIC_LINKS.home} className="intent-card" target="_blank" rel="noreferrer">
          <h3>Classic app</h3>
          <p>Power features and advanced tooling.</p>
        </a>
        {mode === 'advanced' ? (
          <>
            <a href={DEFI_CLASSIC_LINKS.keepers} className="intent-card" target="_blank" rel="noreferrer">
              <h3>Keeper settings</h3>
              <p>Delegated liquidation and automation preferences.</p>
            </a>
            <a href={DEFI_CLASSIC_LINKS.riskAccess} className="intent-card" target="_blank" rel="noreferrer">
              <h3>Risk access</h3>
              <p>Tier-2 asset consent and risk-profile gates.</p>
            </a>
            <a href={DEFI_CLASSIC_LINKS.allowances} className="intent-card" target="_blank" rel="noreferrer">
              <h3>Token allowances</h3>
              <p>Review and revoke ERC-20 approvals to the Diamond.</p>
            </a>
            <a href={DEFI_CLASSIC_LINKS.analytics} className="intent-card" target="_blank" rel="noreferrer">
              <h3>Public analytics</h3>
              <p>Protocol volume and offer-book stats.</p>
            </a>
            <a href={DEFI_CLASSIC_LINKS.nftVerifier} className="intent-card" target="_blank" rel="noreferrer">
              <h3>NFT verifier</h3>
              <p>Check on-chain Vaipakam position NFT metadata.</p>
            </a>
          </>
        ) : null}
      </div>

      <LegalLinks className="legal-links--footer" />
    </div>
  );
}