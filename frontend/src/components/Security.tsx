import { useMemo } from "react";
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
import { useWallet } from "../context/WalletContext";
import { DEFAULT_CHAIN } from "../contracts/config";
import type { ChainConfig } from "../contracts/config";
import { useUserEscrowAddress } from "../hooks/useUserEscrowAddress";
import "./Security.css";

const GITHUB_URL = "https://github.com/vaipakam/vaipakam";

/** Per-card verify-link descriptor — each Security card derives one of
 *  these from the active chain so the "View on explorer" target points
 *  at a meaningful artifact for the topic the card describes. */
interface VerifyTarget {
  label: string;
  href: string;
  /** When set, an additional secondary link below the description.
   *  Used by the Isolated Per-User Escrow card to surface the
   *  connected user's own deployed escrow proxy alongside the
   *  shared UUPS impl. */
  secondary?: { label: string; href: string };
}

/** Resolve the chain the verify links should point at:
 *
 *   1. If the wallet is connected to a chain we have a deployed
 *      Diamond on, use that.
 *   2. Otherwise fall back to the public DEFAULT_CHAIN (the canonical
 *      VPFI testnet for Phase 1).
 *
 * Re-runs on every wallet/active-chain change so the entire Security
 * grid re-points when the user switches networks. */
function useVerifyChain(): ChainConfig {
  const { activeChain } = useWallet();
  return useMemo(() => {
    if (activeChain && activeChain.diamondAddress) return activeChain;
    return DEFAULT_CHAIN;
  }, [activeChain]);
}

/** Helper — explorer URL with optional anchor. Falls back to the
 *  Diamond proxy when the per-facet address isn't surfaced for this
 *  chain (e.g. testnets with partial env). */
function explorer(
  chain: ChainConfig,
  address: string | null | undefined,
  hash = "#code",
): { href: string; isFacet: boolean } {
  if (address && address.length > 0) {
    return {
      href: `${chain.blockExplorer}/address/${address}${hash}`,
      isFacet: true,
    };
  }
  // Fallback to the Diamond proxy. Basescan's "Read as Proxy" tab
  // still shows every facet selector, so the verify experience is
  // intact — just one extra click to reach the specific facet.
  return {
    href: chain.diamondAddress
      ? `${chain.blockExplorer}/address/${chain.diamondAddress}${hash}`
      : chain.blockExplorer,
    isFacet: false,
  };
}

interface ResolvedSecurityCard {
  icon: React.ReactNode;
  title: string;
  description: string;
  target: VerifyTarget | null;
}

function buildItems(
  chain: ChainConfig,
  userEscrow: string | null,
  t: TFunction,
): ResolvedSecurityCard[] {
  return [
    {
      icon: <Lock size={22} />,
      title: t('security.diamondTitle'),
      description: t('security.diamondDesc'),
      target: chain.diamondAddress
        ? {
            label: t('security.diamondVerify', { chain: chain.shortName }),
            href: `${chain.blockExplorer}/address/${chain.diamondAddress}#code`,
          }
        : null,
    },
    (() => {
      const { href } = explorer(chain, chain.escrowImplAddress);
      const target: VerifyTarget = {
        label: t('security.escrowVerify'),
        href,
      };
      if (userEscrow) {
        target.secondary = {
          label: t('security.escrowVerifySecondary'),
          href: `${chain.blockExplorer}/address/${userEscrow}`,
        };
      }
      return {
        icon: <Server size={22} />,
        title: t('security.escrowTitle'),
        description: t('security.escrowDesc'),
        target,
      };
    })(),
    {
      icon: <Eye size={22} />,
      title: t('security.transparencyTitle'),
      description: t('security.transparencyDesc'),
      target: chain.diamondAddress
        ? {
            label: t('security.transparencyVerify'),
            href: `${chain.blockExplorer}/address/${chain.diamondAddress}#events`,
          }
        : null,
    },
    (() => {
      const { href, isFacet } = explorer(chain, chain.riskFacetAddress);
      return {
        icon: <AlertTriangle size={22} />,
        title: t('security.slippageTitle'),
        description: t('security.slippageDesc'),
        target: {
          label: isFacet
            ? t('security.slippageVerifyFacet')
            : t('security.slippageVerifyDiamond'),
          href,
        },
      };
    })(),
    {
      icon: <FileCheck size={22} />,
      title: t('security.auditTitle'),
      description: t('security.auditDesc'),
      target: { label: t('security.auditVerify'), href: GITHUB_URL },
    },
    (() => {
      const { href, isFacet } = explorer(chain, chain.profileFacetAddress);
      return {
        icon: <Users size={22} />,
        title: t('security.kycTitle'),
        description: t('security.kycDesc'),
        target: {
          label: isFacet
            ? t('security.kycVerifyFacet')
            : t('security.kycVerifyDiamond'),
          href,
        },
      };
    })(),
  ];
}

export default function Security() {
  const { t } = useTranslation();
  const chain = useVerifyChain();
  const { address } = useWallet();
  // Read the connected user's per-user escrow proxy. Null until they
  // deploy one (which happens on first offer creation / deposit). The
  // hook returns null when disconnected too, so the secondary "View
  // your own escrow" link only appears for a connected user with a
  // live escrow on the active chain.
  const userEscrow = useUserEscrowAddress(address);
  const items = buildItems(chain, userEscrow, t);

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
              {item.target && (
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
                  {item.target.secondary && (
                    <a
                      href={item.target.secondary.href}
                      className="security-verify-link security-verify-link--secondary"
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {item.target.secondary.label}
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
