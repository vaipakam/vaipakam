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
import { useTranslation } from 'react-i18next';
import './Features.css';

interface FeatureSpec {
  icon: React.ReactNode;
  titleKey: string;
  descKey: string;
}

const FEATURES: FeatureSpec[] = [
  { icon: <Repeat size={24} />, titleKey: 'features.p2pTitle', descKey: 'features.p2pDesc' },
  { icon: <Image size={24} />, titleKey: 'features.nftTitle', descKey: 'features.nftDesc' },
  { icon: <Wallet size={24} />, titleKey: 'features.escrowTitle', descKey: 'features.escrowDesc' },
  { icon: <Award size={24} />, titleKey: 'features.nftPositionTitle', descKey: 'features.nftPositionDesc' },
  { icon: <BarChart3 size={24} />, titleKey: 'features.liquidityTitle', descKey: 'features.liquidityDesc' },
  { icon: <Shield size={24} />, titleKey: 'features.liquidationTitle', descKey: 'features.liquidationDesc' },
  { icon: <ArrowLeftRight size={24} />, titleKey: 'features.precloseTitle', descKey: 'features.precloseDesc' },
  { icon: <Bell size={24} />, titleKey: 'features.alertsTitle', descKey: 'features.alertsDesc' },
];

export default function Features() {
  const { t } = useTranslation();
  return (
    <section className="section features" id="features">
      <div className="container">
        <div className="features-header">
          <span className="section-label">{t('features.sectionLabel')}</span>
          <h2 className="section-title">{t('features.title')}</h2>
          <p className="section-subtitle">{t('features.subtitle')}</p>
        </div>

        <div className="features-grid">
          {FEATURES.map((f) => (
            <div key={f.titleKey} className="feature-card">
              <div className="feature-icon">{f.icon}</div>
              <h3 className="feature-title">{t(f.titleKey)}</h3>
              <p className="feature-desc">{t(f.descKey)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
