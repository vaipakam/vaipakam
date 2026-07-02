import { Link } from 'react-router-dom';

export function MorePage() {
  return (
    <div>
      <h1 className="page-title">More</h1>
      <div className="position-list">
        <Link to="/claims" className="intent-card">Claims</Link>
        <Link to="/settings" className="intent-card">Settings</Link>
        <a href="https://www.vaipakam.com/help" className="intent-card" target="_blank" rel="noreferrer">
          Help &amp; guides
        </a>
        <a href="https://defi.vaipakam.com" className="intent-card" target="_blank" rel="noreferrer">
          Classic app (power features)
        </a>
      </div>
    </div>
  );
}