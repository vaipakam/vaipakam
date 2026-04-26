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

interface SecurityCardSpec {
  icon: React.ReactNode;
  title: string;
  description: string;
  /** Receives the active chain + the connected user's escrow proxy
   *  (null when disconnected / not yet deployed) and returns a
   *  verify-link descriptor — or null to render a static card. */
  verify: (
    chain: ChainConfig,
    userEscrow: string | null,
  ) => VerifyTarget | null;
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

const ITEMS: SecurityCardSpec[] = [
  {
    icon: <Lock size={22} />,
    title: "Diamond Standard (EIP-2535)",
    description:
      "Modular proxy architecture. Upgrade individual facets without disrupting the protocol. All calls route through a single diamond entry point.",
    verify: (chain) => {
      if (!chain.diamondAddress) return null;
      return {
        label: `View Diamond on ${chain.shortName}`,
        href: `${chain.blockExplorer}/address/${chain.diamondAddress}#code`,
      };
    },
  },
  {
    icon: <Server size={22} />,
    title: "Isolated Per-User Escrow",
    description:
      "Each user gets a dedicated UUPS proxy escrow. No commingling of funds. Mandatory escrow upgrades block interactions until the user upgrades.",
    verify: (chain, userEscrow) => {
      const { href } = explorer(chain, chain.escrowImplAddress);
      const result: VerifyTarget = {
        label: "View escrow implementation",
        href,
      };
      if (userEscrow) {
        result.secondary = {
          label: "View your own escrow",
          href: `${chain.blockExplorer}/address/${userEscrow}`,
        };
      }
      return result;
    },
  },
  {
    icon: <Eye size={22} />,
    title: "On-Chain Transparency",
    description:
      "Every offer, loan, and status change is recorded on-chain. Vaipakam NFTs serve as verifiable proof of position ownership.",
    verify: (chain) => {
      if (!chain.diamondAddress) return null;
      return {
        label: "Inspect on-chain event log",
        href: `${chain.blockExplorer}/address/${chain.diamondAddress}#events`,
      };
    },
  },
  {
    icon: <AlertTriangle size={22} />,
    title: "Slippage & Liquidation Safety",
    description:
      "DEX liquidation aborts if slippage exceeds 6%. Falls back to full collateral transfer via NFT claim model. No forced bad swaps.",
    verify: (chain) => {
      const { href, isFacet } = explorer(chain, chain.riskFacetAddress);
      return {
        label: isFacet
          ? "View RiskFacet source"
          : "View liquidation logic on Diamond",
        href,
      };
    },
  },
  {
    icon: <FileCheck size={22} />,
    title: "Audited & Battle-Tested",
    description:
      "Built on OpenZeppelin contracts. ReentrancyGuard and Pausable on all facets. Mandatory third-party audits before mainnet deployment.",
    verify: () => ({
      label: "View source on GitHub",
      href: GITHUB_URL,
    }),
  },
  {
    icon: <Users size={22} />,
    title: "Non-Custodial & No KYC",
    description:
      "Phase 1 launches with KYC checks in pass-through mode. Vaipakam is non-custodial; users are responsible for their own regulatory compliance. Sanctions-country and tiered-KYC logic remains in the codebase for future governance activation.",
    verify: (chain) => {
      const { href, isFacet } = explorer(chain, chain.profileFacetAddress);
      return {
        label: isFacet
          ? "View ProfileFacet source"
          : "View profile logic on Diamond",
        href,
      };
    },
  },
];

export default function Security() {
  const chain = useVerifyChain();
  const { address } = useWallet();
  // Read the connected user's per-user escrow proxy. Null until they
  // deploy one (which happens on first offer creation / deposit). The
  // hook returns null when disconnected too, so the secondary "View
  // your own escrow" link only appears for a connected user with a
  // live escrow on the active chain.
  const userEscrow = useUserEscrowAddress(address);

  return (
    <section className="section security" id="security">
      <div className="container">
        <div className="security-header">
          <span className="section-label">Security & Trust</span>
          <h2 className="section-title">Built for safety at every layer</h2>
          <p className="section-subtitle">
            From smart contract architecture to liquidation mechanics, every
            design decision prioritizes the safety of your assets. Each card
            below links to the on-chain artifact backing the claim — verify the
            standard yourself.
          </p>
        </div>

        <div className="security-grid">
          {ITEMS.map((item) => {
            const target = item.verify(chain, userEscrow);
            return (
              <div key={item.title} className="security-card">
                <div className="security-icon">{item.icon}</div>
                <h3 className="security-card-title">{item.title}</h3>
                <p className="security-card-desc">{item.description}</p>
                {target && (
                  <div className="security-card-verify">
                    <a
                      href={target.href}
                      className="security-verify-link"
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {target.label}
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                    {target.secondary && (
                      <a
                        href={target.secondary.href}
                        className="security-verify-link security-verify-link--secondary"
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {target.secondary.label}
                        <ExternalLink size={12} aria-hidden="true" />
                      </a>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
