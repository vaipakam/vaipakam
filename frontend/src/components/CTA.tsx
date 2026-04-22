import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import './CTA.css';

export default function CTA() {
  return (
    <section className="section cta" id="get-started">
      <div className="container">
        <div className="cta-card">
          <div className="cta-glow" />
          <span className="section-label">Get Started</span>
          <h2 className="cta-title">Ready to start lending?</h2>
          <p className="cta-subtitle">
            Connect your wallet, create an offer, and start earning.
            Set your own terms — no pool, no middleman.
          </p>
          <div className="cta-actions">
            <Link to="/app" className="btn btn-primary btn-lg">
              Launch App <ArrowRight size={18} />
            </Link>
            <a
              href="https://github.com/vaipakam"
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary btn-lg"
            >
              Read Documentation
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
