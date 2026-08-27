import { L as Link } from './L';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { appUrl } from '../lib/appUrl';
import './CTA.css';

export default function CTA() {
  const { t } = useTranslation();
  return (
    <section className="section cta" id="get-started">
      <div className="container">
        <div className="cta-card">
          <div className="cta-glow" />
          <span className="section-label">{t('cta.sectionLabel')}</span>
          <h2 className="cta-title">{t('cta.title')}</h2>
          <p className="cta-subtitle">{t('cta.subtitle')}</p>
          <div className="cta-actions">
            {/* Cross-domain link to the connected app. The host comes from
                `appUrl`'s APP_TARGET, which is deliberately still the
                legacy surface while app.vaipakam.com is unbound (#1854).
                Do not hard-code either host here.
                A react-router <Link> can't do cross-domain, and "/app" no
                longer exists on this domain after the Stage-4 split — use
                a plain <a> via appUrl(), opening in a new tab to match
                the Navbar + Hero "Launch App" CTAs. */}
            <a
              href={appUrl('home')}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary btn-lg"
            >
              {t('cta.launchApp')} <ArrowRight size={18} />
            </a>
            <Link to="/help/overview" className="btn btn-secondary btn-lg">
              {t('cta.readDocs')}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
