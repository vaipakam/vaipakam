import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useTheme } from "../context/ThemeContext";
import { useWallet } from "../context/WalletContext";
import { useMode } from "../context/ModeContext";
import {
  LayoutDashboard,
  BookOpen,
  PlusCircle,
  HandCoins,
  Gift,
  Coins,
  ShieldCheck,
  Activity,
  Sun,
  Moon,
  AlertTriangle,
  LogOut,
  Menu,
  X,
  ArrowLeft,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { useState } from "react";

const SIDEBAR_COLLAPSED_KEY = "vaipakam:sidebar-collapsed";

function readInitialCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}
import DiagnosticsDrawer from "../components/app/DiagnosticsDrawer";
import { EscrowUpgradeBanner } from "../components/app/EscrowUpgradeBanner";
import { UnsupportedChainBanner } from "../components/app/UnsupportedChainBanner";
import { LegalGate } from "../components/app/LegalGate";
import { AddressDisplay } from "../components/app/AddressDisplay";
import { ChainSwitcher } from "../components/app/ChainSwitcher";
import { ReportIssueLink } from "../components/app/ReportIssueLink";
import { ConnectWalletButton } from "../components/app/ConnectWalletButton";
import "./AppLayout.css";

const BASIC_NAV = [
  {
    to: "/app",
    icon: <LayoutDashboard size={20} />,
    label: "Dashboard",
    end: true,
  },
  {
    to: "/app/offers",
    icon: <BookOpen size={20} />,
    label: "Offer Book",
    end: false,
  },
  {
    to: "/app/create-offer",
    icon: <PlusCircle size={20} />,
    label: "Create Offer",
    end: false,
  },
  {
    to: "/app/buy-vpfi",
    icon: <Coins size={20} />,
    label: "Buy VPFI",
    end: false,
  },
  {
    to: "/app/rewards",
    icon: <Gift size={20} />,
    label: "Rewards",
    end: false,
  },
  {
    to: "/app/claims",
    icon: <HandCoins size={20} />,
    label: "Claim Center",
    end: false,
  },
  {
    to: "/app/activity",
    icon: <Activity size={20} />,
    label: "Activity",
    end: false,
  },
];

const ADVANCED_NAV = [
  {
    to: "/app/keepers",
    icon: <ShieldCheck size={20} />,
    label: "Keepers",
    end: false,
  },
];


export default function AppLayout() {
  const { theme, toggleTheme } = useTheme();
  const { mode, setMode } = useMode();
  const {
    address,
    isCorrectChain,
    disconnect,
    switchToDefaultChain,
    error,
    warning,
  } = useWallet();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readInitialCollapsed);
  // After clicking the collapse toggle, the pointer is still over the sidebar
  // — which would immediately trigger the `:hover` expand and make it look
  // like the click did nothing. Suppress hover-expand until the pointer
  // actually leaves the rail, so clicking to collapse feels instant.
  const [suppressHoverExpand, setSuppressHoverExpand] = useState(false);
  const isAdvanced = mode === "advanced";

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // ignore quota / privacy-mode errors; state is still correct in memory
      }
      return next;
    });
    setSuppressHoverExpand(true);
  };

  return (
    <div
      className={`app-layout ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
    >
      {/* Sidebar */}
      <aside
        className={`app-sidebar ${sidebarOpen ? "open" : ""} ${
          sidebarCollapsed ? "collapsed" : ""
        } ${suppressHoverExpand ? "suppress-hover-expand" : ""}`}
        onMouseLeave={(e) => {
          if (suppressHoverExpand) setSuppressHoverExpand(false);
          // After a click on a NavLink the element retains focus, and
          // `:focus-within` (see AppLayout.css) keeps the rail expanded
          // even though the pointer has left. Drop the focus on leave so
          // mouse users get the expected collapse-on-exit. Keyboard-only
          // users never fire mouseleave, so their focus is preserved.
          const active = document.activeElement;
          if (
            active instanceof HTMLElement &&
            e.currentTarget.contains(active) &&
            active !== document.body
          ) {
            active.blur();
          }
        }}
      >
        <div className="sidebar-header">
          <a
            href="/"
            className="sidebar-brand"
            onClick={(e) => {
              e.preventDefault();
              navigate("/");
            }}
          >
            <img
              src={theme === "dark" ? "/logo-dark.png" : "/logo-light.png"}
              alt="Vaipakam"
              className="sidebar-logo sidebar-logo--full"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
            <img
              src={theme === "dark" ? "/icon-dark.png" : "/icon-light.png"}
              alt="Vaipakam"
              className="sidebar-logo sidebar-logo--icon"
              aria-hidden="true"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          </a>
          <button
            type="button"
            className="sidebar-collapse-btn"
            onClick={toggleSidebarCollapsed}
            aria-label={
              sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
            }
            aria-pressed={sidebarCollapsed}
            data-tooltip={
              sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
            }
            data-tooltip-placement="right"
          >
            {sidebarCollapsed ? (
              <ChevronsRight size={18} />
            ) : (
              <ChevronsLeft size={18} />
            )}
          </button>
          <button
            className="sidebar-close"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={20} />
          </button>
        </div>

        <nav className="sidebar-nav">
          {BASIC_NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `sidebar-link ${isActive ? "active" : ""}`
              }
              onClick={() => setSidebarOpen(false)}
            >
              {item.icon}
              <span>{item.label}</span>
            </NavLink>
          ))}

          {isAdvanced && (
            <>
              <div className="sidebar-group-label">Advanced</div>
              {ADVANCED_NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `sidebar-link sidebar-link-nested ${isActive ? "active" : ""}`
                  }
                  onClick={() => setSidebarOpen(false)}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </>
          )}
        </nav>

        <div className="sidebar-footer">
          <button
            className="sidebar-link"
            onClick={() => {
              navigate("/");
            }}
          >
            <ArrowLeft size={20} />
            <span>Back to Home</span>
          </button>
        </div>
      </aside>

      {/* Overlay for mobile */}
      {sidebarOpen && (
        <div
          className="sidebar-overlay"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main content */}
      <div className="app-main">
        {/* Top bar */}
        <header className="app-topbar">
          <button
            className="topbar-menu-btn"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={22} />
          </button>

          <div className="topbar-right">
            <ChainSwitcher />

            <div
              className="mode-switch"
              role="group"
              aria-label="UI mode"
              data-tooltip={
                "Basic hides advanced pages and controls like keeper settings."
              }
              data-tooltip-placement="below"
            >
              <button
                type="button"
                className={`mode-switch-btn ${!isAdvanced ? "active" : ""}`}
                aria-pressed={!isAdvanced}
                onClick={() => setMode("basic")}
              >
                Basic
              </button>
              <button
                type="button"
                className={`mode-switch-btn ${isAdvanced ? "active" : ""}`}
                aria-pressed={isAdvanced}
                onClick={() => setMode("advanced")}
              >
                Advanced
              </button>
            </div>

            <button
              className="theme-toggle"
              onClick={toggleTheme}
              aria-label="Toggle theme"
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>

            {!address ? (
              <ConnectWalletButton className="btn-sm" />
            ) : !isCorrectChain ? (
              <button
                className="btn btn-warning btn-sm"
                onClick={switchToDefaultChain}
              >
                <AlertTriangle size={16} />
                Switch Network
              </button>
            ) : (
              <div className="topbar-wallet">
                <span className="wallet-address-badge">
                  <span className="wallet-dot" />
                  <AddressDisplay address={address} />
                </span>
                <button
                  className="wallet-disconnect-btn"
                  onClick={disconnect}
                  aria-label="Disconnect"
                >
                  <LogOut size={16} />
                </button>
              </div>
            )}
          </div>
        </header>

        {error && (
          <div className="app-wallet-error">
            <span>{error}</span>
            {/* Global top-level error surface — pair every wallet/RPC error
                with a one-click "report this" link so users don't have to
                dig into the Diagnostics drawer for the same workflow. The
                link body is auto-redacted per lib/journeyLog.ts rules. */}
            <ReportIssueLink />
          </div>
        )}

        {/* Warning surface — "no wallet detected" etc. User-environment
         *  nudges, not system failures, so no "report this" link and
         *  styled as a yellow warning (not red error). */}
        {warning && !error && (
          <div className="app-wallet-warning">
            <span>{warning}</span>
          </div>
        )}

        <UnsupportedChainBanner />
        <EscrowUpgradeBanner />

        {/* Page content — wrapped in LegalGate so the first-connect
            ToS acceptance check fires before any app page renders. The
            gate short-circuits when the user is not connected, when the
            on-chain gate is disabled (currentTosVersion == 0), or when
            the user has already accepted the current version. */}
        <div className="app-content">
          <LegalGate>
            <Outlet />
          </LegalGate>
        </div>
      </div>

      <DiagnosticsDrawer />
    </div>
  );
}
