import { L as Link } from "./L";
import { ArrowRight, Coins } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./Hero.css";

export default function Hero() {
  const { t } = useTranslation();
  return (
    <section className="hero" id="hero">
      <div className="hero-bg-glow" />
      <div className="container hero-container">
        <div className="hero-content">
          <div className="hero-brand">{t('hero.brand')}</div>

          <h1 className="hero-title">
            {t('hero.titleLine1')}
            <br />
            <span className="hero-gradient">{t('hero.titleLine2')}</span>
          </h1>

          <p className="hero-subtitle">
            <strong>{t('hero.subtitlePrefix')}</strong> {t('hero.subtitleBody')}
          </p>

          <div className="hero-actions">
            <Link to="/app" className="btn btn-primary btn-lg">
              {t('hero.launchApp')} <ArrowRight size={18} />
            </Link>
            <Link to="/app/buy-vpfi" className="btn btn-secondary btn-lg">
              <Coins size={18} /> {t('hero.buyVpfi')}
            </Link>
            <a href="#how-it-works" className="btn btn-ghost btn-lg">
              {t('hero.howItWorks')}
            </a>
          </div>

          <div className="hero-stats">
            <div className="hero-stat">
              <span className="hero-stat-value">{t('hero.statP2pValue')}</span>
              <span className="hero-stat-label">{t('hero.statP2pLabel')}</span>
            </div>
            <div className="hero-stat-divider" />
            <div className="hero-stat">
              <span className="hero-stat-value">{t('hero.statNftValue')}</span>
              <span className="hero-stat-label">{t('hero.statNftLabel')}</span>
            </div>
            <div className="hero-stat-divider" />
            <div className="hero-stat">
              <span className="hero-stat-value">{t('hero.statEscrowValue')}</span>
              <span className="hero-stat-label">{t('hero.statEscrowLabel')}</span>
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
              <div className="hero-card-title">{t('hero.demoLendTitle')}</div>
              <div className="hero-card-meta">{t('hero.demoLendMeta')}</div>
            </div>
            <span className="hero-card-status active">{t('hero.demoLendStatus')}</span>
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
              <div className="hero-card-title">{t('hero.demoRentTitle')}</div>
              <div className="hero-card-meta">{t('hero.demoRentMeta')}</div>
            </div>
            <span className="hero-card-status pending">{t('hero.demoRentStatus')}</span>
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
              <div className="hero-card-title">{t('hero.demoRepayTitle')}</div>
              <div className="hero-card-meta">{t('hero.demoRepayMeta')}</div>
            </div>
            <span className="hero-card-status settled">{t('hero.demoRepayStatus')}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
