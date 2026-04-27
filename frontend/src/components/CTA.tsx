import { L as Link } from './L';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
            <Link to="/app" className="btn btn-primary btn-lg">
              {t('cta.launchApp')} <ArrowRight size={18} />
            </Link>
            <a
              href="https://github.com/vaipakam"
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary btn-lg"
            >
              {t('cta.readDocs')}
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
