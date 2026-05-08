import {
  Lock,
  Eye,
  Server,
  FileCheck,
  Users,
  AlertTriangle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import "./Security.css";

/* The marketing surface (labs.vaipakam.com) is wallet-free and
 * chain-agnostic by design. Each Security card describes a property
 * of the protocol; the per-chain Diamond / facet addresses + live
 * event feed live on the connected-app surface
 * (defi.vaipakam.com/analytics#transparency), reachable via the
 * Footer "Smart Contracts" link. The cards therefore intentionally
 * carry NO inline verify links — the marketing page is the high-
 * level claim, the connected app is where the artifacts are.
 */

interface SecurityCard {
  icon: React.ReactNode;
  title: string;
  description: string;
}

function buildItems(t: TFunction): SecurityCard[] {
  return [
    {
      icon: <Lock size={22} />,
      title: t('security.diamondTitle'),
      description: t('security.diamondDesc'),
    },
    {
      icon: <Server size={22} />,
      title: t('security.escrowTitle'),
      description: t('security.escrowDesc'),
    },
    {
      icon: <Eye size={22} />,
      title: t('security.transparencyTitle'),
      description: t('security.transparencyDesc'),
    },
    {
      icon: <AlertTriangle size={22} />,
      title: t('security.slippageTitle'),
      description: t('security.slippageDesc'),
    },
    {
      icon: <FileCheck size={22} />,
      title: t('security.auditTitle'),
      description: t('security.auditDesc'),
    },
    {
      icon: <Users size={22} />,
      title: t('security.kycTitle'),
      description: t('security.kycDesc'),
    },
  ];
}

export default function Security() {
  const { t } = useTranslation();
  const items = buildItems(t);

  return (
    <section className="section security" id="security">
      <div className="container">
        <div className="security-header">
          <span className="section-label">{t('security.sectionLabel')}</span>
          <h2 className="section-title">{t('security.title')}</h2>
          <p className="section-subtitle">{t('security.subtitle')}</p>
        </div>

        <div className="security-grid">
          {items.map((item) => (
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
