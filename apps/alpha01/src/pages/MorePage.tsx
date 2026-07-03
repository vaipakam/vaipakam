import { Link } from 'react-router-dom';
import { LegalLinks } from '../components/LegalLinks';

export function MorePage() {
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
        <a href="https://defi.vaipakam.com" className="intent-card" target="_blank" rel="noreferrer">
          <h3>Classic app</h3>
          <p>Power features and advanced tooling.</p>
        </a>
      </div>

      <LegalLinks className="legal-links--footer" />
    </div>
  );
}