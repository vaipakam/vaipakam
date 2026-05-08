import { BrowserRouter, Routes, Route } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import BuyVPFIMarketing from './pages/BuyVPFIMarketing';
import DiscordPage from './pages/Discord';
import TermsPage from './pages/TermsPage';
import PrivacyPage from './pages/PrivacyPage';
import DataRights from './pages/DataRights';
import Overview from './pages/Overview';
import UserGuide from './pages/UserGuide';
import Whitepaper from './pages/Whitepaper';
import HelpSearch from './pages/HelpSearch';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import ConsentBanner from './components/ConsentBanner';
import { ScrollToHash } from './components/ScrollToHash';
import { LocaleResolver } from './components/LocaleResolver';
import { HreflangAlternates } from './components/HreflangAlternates';
import { DefaultLocaleRedirect } from './components/DefaultLocaleRedirect';
import type { ReactElement } from 'react';

/**
 * Public Buy-VPFI shell — wraps the marketing page in the standard
 * Navbar + Footer chrome. The actual buy / stake / unstake flow
 * lives at `<defi>/apps/buy-vpfi` (wallet-gated); CTAs inside
 * `BuyVPFIMarketing` open that URL in a new tab via the
 * `defiUrl(...)` helper.
 */
function PublicBuyVPFI() {
  return (
    <>
      <Navbar />
      <main
        className="container public-page-glow"
        style={{ paddingTop: 104, paddingBottom: 32 }}
      >
        <BuyVPFIMarketing />
      </main>
      <Footer />
    </>
  );
}

/**
 * Public Data Rights shell — `/data-rights` is GDPR / CCPA-style
 * disclosure copy that any visitor can read without a wallet, so
 * it lives on the marketing site rather than inside the connected
 * app shell.
 */
function PublicDataRights() {
  return (
    <>
      <Navbar />
      <main
        className="container public-page-glow"
        style={{ paddingTop: 104, paddingBottom: 32 }}
      >
        <DataRights />
      </main>
      <Footer />
    </>
  );
}

/**
 * Renders the marketing route subtree using v6 *relative* nested-
 * route paths so the same JSX block can mount under either the
 * unprefixed root (English default) or the `:locale` prefix
 * without duplication.
 *
 * Routes that intentionally DO NOT exist on the marketing site —
 * `/analytics`, `/nft-verifier`, `/protocol-console`, `/apps/*` —
 * are public-read or wallet-bearing surfaces hosted on the
 * connected-app domain. The Navbar / Footer link out to them via
 * `defiUrl(...)`. Cross-domain visitors hitting a marketing-only
 * path on the connected app (or vice versa) get the SPA's natural
 * 404 — matching the dominant industry posture (Aave, Morpho,
 * Pendle, etc.) of "each surface owns its own URL space."
 */
function pageRoutes(): ReactElement {
  return (
    <>
      <Route index element={<LandingPage />} />
      <Route path="buy-vpfi" element={<PublicBuyVPFI />} />
      <Route path="discord" element={<DiscordPage />} />
      <Route path="terms" element={<TermsPage />} />
      <Route path="privacy" element={<PrivacyPage />} />
      <Route path="data-rights" element={<PublicDataRights />} />
      <Route path="help/overview" element={<Overview />} />
      <Route path="help/basic" element={<UserGuide variant="basic" />} />
      <Route path="help/advanced" element={<UserGuide variant="advanced" />} />
      <Route path="help/technical" element={<Whitepaper />} />
      <Route path="help/search" element={<HelpSearch />} />
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ScrollToHash />
      <ConsentBanner />
      <HreflangAlternates />
      <DefaultLocaleRedirect />
      <Routes>
        {/* Default English tree at the unprefixed root. */}
        <Route element={<LocaleResolver locale="en" />}>
          {pageRoutes()}
        </Route>

        {/* Locale-prefixed tree. */}
        <Route path=":locale" element={<LocaleResolver />}>
          {pageRoutes()}
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
