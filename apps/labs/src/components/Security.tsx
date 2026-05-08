import {
  Lock,
  Eye,
  Server,
  FileCheck,
  Users,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { defiUrl } from "../lib/defiUrl";
import "./Security.css";

const GITHUB_URL = "https://github.com/vaipakam/vaipakam";

/* The marketing surface (labs.vaipakam.com) is wallet-free and
 * chain-agnostic by design — analytics, the protocol console, and
 * the NFT verifier all live on the connected-app surface
 * (defi.vaipakam.com). The "verify on chain" affordance on each
 * Security card therefore deep-links to
 * `/analytics#transparency` on the connected app, where the per-
 * chain Diamond + facet addresses + live event feed are surfaced
 * for whichever chain the user has active.
 *
 * The audit card is the one exception — its "verify" target is the
 * source repo on GitHub, which is itself chain-agnostic.
 */
const VERIFY_HREF = defiUrl('/analytics#transparency');

/** Per-card verify-link descriptor. */
interface VerifyTarget {
  label: string;
  href: string;
}

interface SecurityCard {
  icon: React.ReactNode;
  title: string;
  description: string;
  target: VerifyTarget;
}

function buildItems(t: TFunction): SecurityCard[] {
  return [
    {
      icon: <Lock size={22} />,
      title: t('security.diamondTitle'),
      description: t('security.diamondDesc'),
      target: {
        label: t('security.diamondVerify', {
          chain: 'all chains',
          defaultValue: 'View deployed Diamonds',
        }),
        href: VERIFY_HREF,
      },
    },
    {
      icon: <Server size={22} />,
      title: t('security.escrowTitle'),
      description: t('security.escrowDesc'),
      target: { label: t('security.escrowVerify'), href: VERIFY_HREF },
    },
    {
      icon: <Eye size={22} />,
      title: t('security.transparencyTitle'),
      description: t('security.transparencyDesc'),
      target: { label: t('security.transparencyVerify'), href: VERIFY_HREF },
    },
    {
      icon: <AlertTriangle size={22} />,
      title: t('security.slippageTitle'),
      description: t('security.slippageDesc'),
      target: { label: t('security.slippageVerifyDiamond'), href: VERIFY_HREF },
    },
    {
      icon: <FileCheck size={22} />,
      title: t('security.auditTitle'),
      description: t('security.auditDesc'),
      target: { label: t('security.auditVerify'), href: GITHUB_URL },
    },
    {
      icon: <Users size={22} />,
      title: t('security.kycTitle'),
      description: t('security.kycDesc'),
      target: { label: t('security.kycVerifyDiamond'), href: VERIFY_HREF },
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
              <div className="security-card-verify">
                <a
                  href={item.target.href}
                  className="security-verify-link"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {item.target.label}
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
