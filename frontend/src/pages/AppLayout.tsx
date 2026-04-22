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
  Wallet,
  AlertTriangle,
  LogOut,
  Menu,
  X,
  ArrowLeft,
} from "lucide-react";
import { useState } from "react";
import DiagnosticsDrawer from "../components/app/DiagnosticsDrawer";
import { EscrowUpgradeBanner } from "../components/app/EscrowUpgradeBanner";
import { UnsupportedChainBanner } from "../components/app/UnsupportedChainBanner";
import { ChainSwitcher } from "../components/app/ChainSwitcher";
import { ReportIssueLink } from "../components/app/ReportIssueLink";
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

function shortenAddress(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export default function AppLayout() {
  const { theme, toggleTheme } = useTheme();
  const { mode, setMode } = useMode();
  const {
    address,
    isConnecting,
    isCorrectChain,
    connect,
    disconnect,
    switchToDefaultChain,
    error,
  } = useWallet();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isAdvanced = mode === "advanced";

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <aside className={`app-sidebar ${sidebarOpen ? "open" : ""}`}>
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
              className="sidebar-logo"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          </a>
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
              <button
                className="btn btn-primary btn-sm"
                onClick={connect}
                disabled={isConnecting}
              >
                <Wallet size={16} />
                {isConnecting ? "Connecting..." : "Connect Wallet"}
              </button>
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
                  {shortenAddress(address)}
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

        <UnsupportedChainBanner />
        <EscrowUpgradeBanner />

        {/* Page content */}
        <div className="app-content">
          <Outlet />
        </div>
      </div>

      <DiagnosticsDrawer />
    </div>
  );
}
