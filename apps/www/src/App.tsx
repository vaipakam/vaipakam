import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Suspense, lazy } from 'react';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import ConsentBanner from './components/ConsentBanner';
import { ScrollToHash } from './components/ScrollToHash';
import { LocaleResolver } from './components/LocaleResolver';
import { HreflangAlternates } from './components/HreflangAlternates';
import { DefaultLocaleRedirect } from './components/DefaultLocaleRedirect';
import type { ReactElement } from 'react';

/**
 * Route-based code splitting. Every page is `React.lazy()`-loaded
 * so the initial bundle ships only the entry route's JS plus the
 * chrome (Navbar / Footer / ConsentBanner / locale routing) that
 * every page reuses.
 *
 * Why route-level rather than component-level: the heaviest chunks
 * are the markdown rendering chain (`react-markdown`, `remark-gfm`)
 * and the per-locale doc content imported via `import.meta.glob` in
 * `Overview` / `UserGuide` / `Whitepaper`. Splitting at the page
 * boundary keeps those out of the Landing entry — most visitors
 * never navigate to /help/* and shouldn't pay the parse cost of
 * the markdown machinery on first paint.
 *
 * Pre-split: 3.3 MB JS / 1 MB-gzip on every page load. Post-split:
 * Landing entry ships only Hero + Features + HowItWorks + Security
 * + FAQ + CTA + chrome; markdown pages download as separate chunks
 * on navigation.
 */
const LandingPage = lazy(() => import('./pages/LandingPage'));
const BuyVPFIMarketing = lazy(() => import('./pages/BuyVPFIMarketing'));
const DiscordPage = lazy(() => import('./pages/Discord'));
const TermsPage = lazy(() => import('./pages/TermsPage'));
const PrivacyPage = lazy(() => import('./pages/PrivacyPage'));
const DataRights = lazy(() => import('./pages/DataRights'));
const Overview = lazy(() => import('./pages/Overview'));
const UserGuide = lazy(() => import('./pages/UserGuide'));
const Whitepaper = lazy(() => import('./pages/Whitepaper'));
const HelpSearch = lazy(() => import('./pages/HelpSearch'));
// `/protocol-console/docs` — canonical home for the Admin
// Configurable Knobs & Switches reference. The interactive
// `/protocol-console` dashboard itself lives on the connected-app
// surface (apps/defi); only the public-read prose docs live here.
const AdminKnobsDocs = lazy(() => import('./pages/AdminKnobsDocs'));

/**
 * Public VPFI shell — wraps the VPFI-benefits marketing page in the
 * standard Navbar + Footer chrome. The actual deposit / withdraw flow
 * lives at `<defi>/buy-vpfi` (wallet-gated); CTAs inside
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
 * `/analytics`, `/nft-verifier`, `/protocol-console`, the entire
 * connected-app surface — are public-read or wallet-bearing
 * surfaces hosted on the connected-app domain. The Navbar /
 * Footer link out to them via `defiUrl(...)`. Cross-domain
 * visitors hitting a marketing-only path on the connected app
 * (or vice versa) get the SPA's natural 404 — matching the
 * dominant industry posture (Morpho, etc.) of
 * "each surface owns its own URL space."
 */
function pageRoutes(): ReactElement {
  return (
    <>
      <Route index element={<LandingPage />} />
      <Route path="vpfi" element={<PublicBuyVPFI />} />
      {/* #712: the page moved from /buy-vpfi → /vpfi when the fixed-rate
          sale was removed; keep a redirect so old inbound links / cached
          sitemap entries don't 404. */}
      <Route path="buy-vpfi" element={<Navigate to="/vpfi" replace />} />
      <Route path="discord" element={<DiscordPage />} />
      <Route path="terms" element={<TermsPage />} />
      <Route path="privacy" element={<PrivacyPage />} />
      <Route path="data-rights" element={<PublicDataRights />} />
      <Route path="help/overview" element={<Overview />} />
      <Route path="help/basic" element={<UserGuide variant="basic" />} />
      <Route path="help/advanced" element={<UserGuide variant="advanced" />} />
      <Route path="help/technical" element={<Whitepaper />} />
      <Route path="help/search" element={<HelpSearch />} />
      {/* Admin Configurable Knobs & Switches reference. The
       *  defi-side `/protocol-console` dashboard's info-icons
       *  deep-link to anchors here via `marketingUrl()`. */}
      <Route path="protocol-console/docs" element={<AdminKnobsDocs />} />
    </>
  );
}

/**
 * Suspense fallback while a route chunk downloads.
 *
 * Intentionally quiet — no spinner, no "Loading…" copy. Most page
 * chunks land in well under a frame budget on broadband; rendering
 * a visible loader would just flash awkwardly on every navigation.
 * The breathing-room padding holds the layout so the chrome
 * (Navbar / Footer above) doesn't visibly reflow when the chunk
 * resolves.
 */
function RouteLoading() {
  return (
    <main
      className="container public-page-glow"
      style={{ paddingTop: 104, paddingBottom: 32, minHeight: '50vh' }}
      aria-busy="true"
    />
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ScrollToHash />
      <ConsentBanner />
      <HreflangAlternates />
      <DefaultLocaleRedirect />
      <Suspense fallback={<RouteLoading />}>
        <Routes>
          {/* Default English tree at the unprefixed root. */}
          <Route element={<LocaleResolver locale="en" />}>
            {pageRoutes()}
          </Route>

          {/* Locale-prefixed tree — same shape as defi for SEO consistency. */}
          <Route path=":locale" element={<LocaleResolver />}>
            {pageRoutes()}
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
