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
  Menu,
  X,
  ArrowLeft,
  ChevronsLeft,
  ChevronsRight,
  Bell,
  ShieldOff,
  Settings,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
import { ChainSwitcher } from "../components/app/ChainSwitcher";
import { ReportIssueLink } from "../components/app/ReportIssueLink";
import { ConnectWalletButton } from "../components/app/ConnectWalletButton";
import { WalletMenu } from "../components/app/WalletMenu";
import { InfoTip } from "../components/InfoTip";
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
  {
    to: "/app/alerts",
    icon: <Bell size={20} />,
    label: "Alerts",
    end: false,
  },
  {
    to: "/app/allowances",
    icon: <ShieldOff size={20} />,
    label: "Allowances",
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
  // Settings popover (gear icon) — consolidates the Basic/Advanced mode
  // switch and theme toggle into one menu accessible from the topbar.
  // The inline mode-switch was previously hidden below 640px (see
  // `.topbar-right .mode-switch { display: none }` in AppLayout.css),
  // making "Advanced" mode entirely unreachable from mobile. Rolling
  // both controls into a single popover restores access on every
  // viewport and keeps the topbar uncluttered on desktop.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const isAdvanced = mode === "advanced";

  useEffect(() => {
    if (!settingsOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (!settingsRef.current) return;
      if (!settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setSettingsOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [settingsOpen]);

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
            {/* Standalone chain switcher — only when no wallet is
             *  connected (read-only mode) or the wallet is on an
             *  unsupported chain. When the wallet is connected and on
             *  a supported chain, network-switching lives inside
             *  `<WalletMenu>` (under the address pill) so the
             *  topbar has a single discoverable session-state
             *  control. */}
            {(!address || !isCorrectChain) && <ChainSwitcher />}

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
              <WalletMenu />
            )}

            {/* Settings popover anchored to the topbar's right edge —
             *  rendered last so the gear is the trailing control on
             *  every viewport. The panel opens below-left of the gear
             *  via `right: 0` on `.topbar-settings-panel`, so it
             *  stays inside the viewport even when the trigger sits
             *  flush against the topbar's right border. */}
            <div className="topbar-settings" ref={settingsRef}>
              <button
                type="button"
                className="topbar-settings-btn"
                onClick={() => setSettingsOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={settingsOpen}
                aria-label="Settings"
                data-tooltip="Settings"
                data-tooltip-placement="below"
              >
                <Settings size={18} />
              </button>

              {settingsOpen && (
                <div
                  className="topbar-settings-panel"
                  role="menu"
                  aria-label="Settings"
                >
                  <div className="topbar-settings-row">
                    <span className="topbar-settings-label">
                      Mode
                      <InfoTip ariaLabel="About Basic and Advanced mode">
                        Basic hides advanced pages and controls like keeper
                        settings. Switch to Advanced once you're comfortable
                        with the core lending flow.
                      </InfoTip>
                    </span>
                    <div
                      className="mode-switch"
                      role="group"
                      aria-label="UI mode"
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
                  </div>

                  <div className="topbar-settings-row">
                    <span className="topbar-settings-label">Theme</span>
                    <button
                      type="button"
                      className="theme-toggle"
                      onClick={toggleTheme}
                      aria-label={
                        theme === "dark"
                          ? "Switch to light theme"
                          : "Switch to dark theme"
                      }
                    >
                      {theme === "dark" ? (
                        <Sun size={18} />
                      ) : (
                        <Moon size={18} />
                      )}
                      <span className="topbar-settings-theme-label">
                        {theme === "dark" ? "Light" : "Dark"}
                      </span>
                    </button>
                  </div>
                </div>
              )}
            </div>
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
