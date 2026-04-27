import { BrowserRouter, Routes, Route } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import PublicDashboard from './pages/PublicDashboard';
import AppLayout from './pages/AppLayout';
import Dashboard from './pages/Dashboard';
import OfferBook from './pages/OfferBook';
import CreateOffer from './pages/CreateOffer';
import LoanDetails from './pages/LoanDetails';
import LenderEarlyWithdrawal from './pages/LenderEarlyWithdrawal';
import BorrowerPreclose from './pages/BorrowerPreclose';
import Refinance from './pages/Refinance';
import ClaimCenter from './pages/ClaimCenter';
import NftVerifier from './pages/NftVerifier';
import KeeperSettings from './pages/KeeperSettings';
import Alerts from './pages/Alerts';
import Allowances from './pages/Allowances';
import BuyVPFI from './pages/BuyVPFI';
import Rewards from './pages/Rewards';
import Activity from './pages/Activity';
import DiscordPage from './pages/Discord';
import TermsPage from './pages/TermsPage';
import PrivacyPage from './pages/PrivacyPage';
import UserGuide from './pages/UserGuide';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import ConsentBanner from './components/ConsentBanner';
import { ScrollToHash } from './components/app/ScrollToHash';
import DiagnosticsDrawer from './components/app/DiagnosticsDrawer';
import { LocaleResolver } from './components/LocaleResolver';
import { HreflangAlternates } from './components/HreflangAlternates';
import type { ReactElement } from 'react';

// Public NFT Verifier shell — verification is a pre-purchase due-diligence
// tool aimed at strangers evaluating a Vaipakam position NFT offered on a
// secondary marketplace. No wallet required (reads hit a per-chain RPC
// picked by matching the pasted contract address), and no Advanced-mode
// gate — anyone should be able to confirm authenticity. Mounted inside
// the same Navbar + Footer chrome used by the landing / analytics pages.
function PublicNftVerifier() {
  return (
    <>
      <Navbar />
      <main className="container" style={{ paddingTop: 32, paddingBottom: 32 }}>
        <NftVerifier />
      </main>
      <Footer />
      <DiagnosticsDrawer />
    </>
  );
}

/**
 * Renders the full route subtree using v6 *relative* nested-route
 * paths so the same JSX block can mount under either the unprefixed
 * root (English default) or the `:locale` prefix without
 * duplication. v6 nested `<Route>` resolves child paths relative to
 * the parent — which is the property we lean on here.
 */
function pageRoutes(): ReactElement {
  return (
    <>
      <Route index element={<LandingPage />} />
      <Route path="analytics" element={<PublicDashboard />} />
      <Route path="nft-verifier" element={<PublicNftVerifier />} />
      <Route path="discord" element={<DiscordPage />} />
      <Route path="terms" element={<TermsPage />} />
      <Route path="privacy" element={<PrivacyPage />} />
      <Route path="help/basic" element={<UserGuide variant="basic" />} />
      <Route path="help/advanced" element={<UserGuide variant="advanced" />} />
      <Route path="app" element={<AppLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="offers" element={<OfferBook />} />
        <Route path="create-offer" element={<CreateOffer />} />
        <Route path="loans/:loanId" element={<LoanDetails />} />
        <Route path="loans/:loanId/early-withdrawal" element={<LenderEarlyWithdrawal />} />
        <Route path="loans/:loanId/preclose" element={<BorrowerPreclose />} />
        <Route path="loans/:loanId/refinance" element={<Refinance />} />
        <Route path="claims" element={<ClaimCenter />} />
        <Route path="activity" element={<Activity />} />
        <Route path="rewards" element={<Rewards />} />
        <Route path="buy-vpfi" element={<BuyVPFI />} />
        <Route path="keepers" element={<KeeperSettings />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="allowances" element={<Allowances />} />
      </Route>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ScrollToHash />
      <ConsentBanner />
      <HreflangAlternates />
      <Routes>
        {/* Default English tree at the unprefixed root. */}
        <Route element={<LocaleResolver locale="en" />}>
          {pageRoutes()}
        </Route>

        {/* Locale-prefixed tree. The `:locale` segment is captured by
         *  LocaleResolver via useParams(); if the segment isn't one of
         *  the supported locales, LocaleResolver falls back to English
         *  silently — the route still matches, so a stray `/foo`-shaped
         *  URL where `foo` happens to look like a locale code doesn't
         *  404. (The default-tree above also mounts at `/foo`, so React
         *  Router picks whichever is more specific. Real locales hit
         *  the prefixed tree; fakes hit the default tree.) */}
        <Route path=":locale" element={<LocaleResolver />}>
          {pageRoutes()}
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
