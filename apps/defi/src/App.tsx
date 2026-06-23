import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './components/app/ErrorBoundary';
import PublicDashboard from './pages/PublicDashboard';
import AppLayout from './pages/AppLayout';
import Dashboard from './pages/Dashboard';
import OfferBook from './pages/OfferBook';
import CreateOffer from './pages/CreateOffer';
import LoanDetails from './pages/LoanDetails';
import OfferDetails from './pages/OfferDetails';
import LenderEarlyWithdrawal from './pages/LenderEarlyWithdrawal';
import BorrowerPreclose from './pages/BorrowerPreclose';
import Refinance from './pages/Refinance';
import ClaimCenter from './pages/ClaimCenter';
import NftVerifier from './pages/NftVerifier';
import KeeperSettings from './pages/KeeperSettings';
import Alerts from './pages/Alerts';
import Allowances from './pages/Allowances';
import VaultAssets from './pages/VaultAssets';
import VaultRecover from './pages/VaultRecover';
import DataRights from './pages/DataRights';
import VPFIVaultAndDiscounts from './pages/BuyVPFI';
import Activity from './pages/Activity';
import AdminDashboard from './pages/AdminDashboard';
import { marketingUrl } from './lib/marketingUrl';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import ConsentBanner from './components/ConsentBanner';
import { ScrollToHash } from './components/app/ScrollToHash';
import DiagnosticsDrawer from './components/app/DiagnosticsDrawer';
import { LocaleResolver } from './components/LocaleResolver';
import { HreflangAlternates } from './components/HreflangAlternates';
import { DefaultLocaleRedirect } from './components/DefaultLocaleRedirect';
import type { ReactElement } from 'react';

/**
 * Public NFT Verifier shell — NftVerifier is a wallet-free
 * pre-purchase due-diligence tool aimed at strangers evaluating a
 * Vaipakam position NFT offered on a secondary marketplace. It
 * lives on the connected-app domain alongside the wallet-bearing
 * write flows (industry pattern used by major DeFi platforms,
 * Morpho /markets — public-read tools sit on the app subdomain).
 * Wrapped in the public Navbar + Footer chrome.
 */
function PublicNftVerifier() {
  return (
    <>
      <Navbar />
      {/* Navbar is `position: fixed` at 72 px — paddingTop = 72 + 32
          breathing room so the heading isn't hidden under the bar. */}
      <main className="container public-page-glow" style={{ paddingTop: 104, paddingBottom: 32 }}>
        <NftVerifier />
      </main>
      <Footer />
      <DiagnosticsDrawer />
    </>
  );
}

/**
 * Cross-domain back-compat redirect — same behaviour as react-router's
 * `<Navigate to=... replace />` but works across origins (e.g. when
 * the canonical home of a path has moved from the connected-app
 * subdomain to the marketing apex). Uses `window.location.replace`
 * so the redirect doesn't pollute the user's back-button history.
 *
 * Used here for the Protocol Console docs, which moved from
 * `defi.vaipakam.com/protocol-console/docs` to the marketing apex
 * `vaipakam.com/protocol-console/docs` — the connected app no longer
 * hosts the prose reference, only the interactive
 * `/protocol-console` dashboard.
 */
function ExternalRedirect({ url }: { url: string }) {
  useEffect(() => {
    window.location.replace(url);
  }, [url]);
  // Render a minimal placeholder while the browser navigates — the
  // replace fires synchronously on mount, so users almost never see
  // it, but a blank `null` here would leave a visible flash of
  // empty page on slow networks.
  return (
    <main style={{ padding: 32 }}>
      <p>Redirecting…</p>
    </main>
  );
}

/**
 * Renders the route subtree using v6 *relative* nested-route paths
 * so the same JSX block can mount under either the unprefixed root
 * (English default) or the `:locale` prefix without duplication.
 *
 * Public marketing routes (LandingPage, BuyVPFIMarketing,
 * Whitepaper, Overview, UserGuide-{Basic,Advanced}, Terms, Privacy,
 * Discord, HelpSearch) have moved to apps/labs and are NOT served
 * here any more. Visitors hitting those paths on the connected-app
 * domain get the SPA's natural 404 (industry pattern: cross-surface
 * paths 404, no path-preserving redirect). Navbar/Footer link out
 * to the marketing site via `marketingUrl(...)` so the user-facing
 * navigation continues to work.
 *
 * Connected-app routes mount at the root with NO `/app` or `/apps`
 * prefix — matches every major DeFi platform (e.g. Uniswap /
 * Morpho / dYdX all root-mount). The user only ever sees
 * `defi.vaipakam.com/<route>`, never `defi.vaipakam.com/app/...`.
 */
function pageRoutes(): ReactElement {
  return (
    <>
      {/* Public-read tools — wallet-free reads of on-chain state.
          Wrapped in their own public chrome (Navbar + Footer)
          rather than the connected-app shell, so a stranger can
          land here from the marketing site without seeing the
          in-app sidebar / topbar. */}
      <Route path="analytics" element={<PublicDashboard />} />
      <Route path="nft-verifier" element={<PublicNftVerifier />} />
      <Route path="protocol-console" element={<AdminDashboard />} />
      {/* `/protocol-console/docs` moved to the marketing apex
       *  `vaipakam.com/protocol-console/docs` so the public-read
       *  prose reference lives alongside the rest of the indexable
       *  explainer pages (Whitepaper / Overview / User Guide).
       *  The connected app keeps only the interactive
       *  `/protocol-console` dashboard above. */}
      <Route
        path="protocol-console/docs"
        element={<ExternalRedirect url={marketingUrl('/protocol-console/docs')} />}
      />
      {/* Backward-compat redirects from the pre-rename /admin paths.
          Kept so existing external bookmarks / footer links on
          stale-cached deploys keep working. `/admin` still resolves
          locally to the dashboard route; `/admin/docs` now bounces
          to the marketing-apex copy. */}
      <Route path="admin" element={<Navigate to="/protocol-console" replace />} />
      <Route
        path="admin/docs"
        element={<ExternalRedirect url={marketingUrl('/protocol-console/docs')} />}
      />

      {/* Connected-app shell mounted at root — `/` is Dashboard,
          `/offers` is OfferBook, etc. AppLayout provides the
          connected-app chrome (sidebar + topbar). Wallet-bearing.
          Pre-PR3 these routes were nested under `<Route path="app">`;
          flattening to root matches the industry standard URL shape. */}
      <Route element={<AppLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="offers" element={<OfferBook />} />
        <Route path="offers/:offerId" element={<OfferDetails />} />
        <Route path="create-offer" element={<CreateOffer />} />
        <Route path="loans/:loanId" element={<LoanDetails />} />
        <Route path="loans/:loanId/early-withdrawal" element={<LenderEarlyWithdrawal />} />
        <Route path="loans/:loanId/preclose" element={<BorrowerPreclose />} />
        <Route path="loans/:loanId/refinance" element={<Refinance />} />
        <Route path="claims" element={<ClaimCenter />} />
        <Route path="activity" element={<Activity />} />
        <Route path="keepers" element={<KeeperSettings />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="allowances" element={<Allowances />} />
        <Route path="vault" element={<VaultAssets />} />
        {/* T-054 PR-4 — stuck-token recovery. INTENTIONALLY HIDDEN
            from main nav. Reachable only via the deep link in the
            Advanced User Guide. The page itself injects
            `<meta name="robots" content="noindex,nofollow">` so the
            URL doesn't get indexed by search engines. */}
        <Route path="recover" element={<VaultRecover />} />
        <Route path="data-rights" element={<DataRights />} />
        <Route path="vpfi-vault" element={<VPFIVaultAndDiscounts />} />
        {/* Back-compat redirect: the page was renamed from the
            fixed-rate "Buy VPFI" surface to the VPFI vault + discount
            surface (#687-A removed the on-chain fixed-rate sale).
            Deep links to /buy-vpfi still land on the new page —
            carrying the hash so anchors like #staking-rewards survive. */}
        <Route path="buy-vpfi" element={<BuyVpfiRedirect />} />
      </Route>
    </>
  );
}

/**
 * Back-compat redirect for the renamed `/buy-vpfi` → `/vpfi-vault` route.
 * `relative="path"` targets the sibling segment, so the redirect preserves
 * BOTH the active locale prefix (e.g. `/es/buy-vpfi` → `/es/vpfi-vault`,
 * since this route mounts under the unprefixed root AND the `:locale` tree)
 * and the hash + query, so localized deep links like
 * `/es/buy-vpfi#staking-rewards` keep working (#687-A).
 */
function BuyVpfiRedirect() {
  const location = useLocation();
  return (
    <Navigate
      to={`../vpfi-vault${location.search}${location.hash}`}
      relative="path"
      replace
    />
  );
}

/**
 * The routed surface, wrapped in the app-wide render-error boundary.
 * The boundary resets on `location.pathname` change so navigating away
 * from a crashed route recovers without a full reload. Kept as its own
 * component so `useLocation()` runs inside `<BrowserRouter>`.
 */
function RoutedSurface() {
  const location = useLocation();
  return (
    <ErrorBoundary resetKey={location.pathname}>
      <Routes>
        {/* Default English tree at the unprefixed root. */}
        <Route element={<LocaleResolver locale="en" />}>
          {pageRoutes()}
        </Route>

        {/* Locale-prefixed tree — same shape as labs for SEO consistency. */}
        <Route path=":locale" element={<LocaleResolver />}>
          {pageRoutes()}
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ScrollToHash />
      <ConsentBanner />
      <HreflangAlternates />
      <DefaultLocaleRedirect />
      <RoutedSurface />
    </BrowserRouter>
  );
}
