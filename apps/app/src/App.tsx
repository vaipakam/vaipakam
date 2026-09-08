/**
 * Route table. Two rules keep dead-end URLs impossible (audit
 * F-20260702-005):
 *   - likely aliases redirect to the canonical route;
 *   - everything else lands on the in-shell NotFound page, never a
 *     blank screen.
 */
import { lazy } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { SUPPORTED_LOCALES } from '@vaipakam/i18n/glossary';
import { AppShell } from './components/AppShell';
// The landing route (Home) stays in the boot chunk so the first paint
// after mount is instant; everything else is a lazy chunk (UX-005) —
// advanced surfaces (desk/charts, offers, activity, vpfi, verifier) and
// the once-per-session pages (faucet, settings, help) don't belong in
// the code every first-time visitor downloads.
//
// UX2-008 — Borrow and Lend were kept eager too, but each imports
// `OfferFlow` → the contracts layer → the combined Diamond ABI
// (~761 kB), so their eager presence dragged that whole chunk onto the
// FIRST-paint critical path of every route, including the marketing
// landing (Home) and Help. Lazy-loading them (like every other route)
// keeps the ABI chunk off a disconnected first paint entirely; the
// trade is a brief in-shell "Loading…" the first time the user opens
// /borrow or /lend — the same treatment the other action routes already
// have, painted inside the already-live shell.
import { Home } from './pages/Home';

/**
 * Hard navigation to a URL outside this SPA (#1959).
 *
 * A react-router <Navigate> cannot leave the origin, and an <a> would
 * need the user to click. This is for paths the app deliberately does
 * NOT own but must keep working — currently only
 * `/protocol-console/docs`, whose prose lives on the marketing apex so
 * it indexes beside the other public explainers.
 *
 * `replace` rather than `assign`: the redirect should not sit in the
 * back-stack, or Back from the docs bounces the reader straight out
 * again instead of returning them here.
 */
/**
 * Leaves this origin for `url`, CARRYING THE FRAGMENT.
 *
 * The destination reference supports stable `#<knob-id>` deep links, so
 * a bookmark or an old connected-app link to one parameter's section
 * has to survive the hop. Dropping the hash lands every one of them at
 * the top of a long document — the reader is on the right page and has
 * to hunt for the row they asked for, which is the quiet half of a
 * broken link (review round 2 P2). Search is carried for the same
 * reason; a redirect that discards what the URL said is not a redirect
 * to the same place.
 *
 * An incoming hash wins only when the target does not name one itself.
 */
function ExternalRedirect({ url }: { url: string }) {
  if (typeof window !== 'undefined') {
    const target = new URL(url);
    if (!target.hash && window.location.hash) target.hash = window.location.hash;
    if (!target.search && window.location.search) target.search = window.location.search;
    window.location.replace(target.toString());
  }
  return null;
}
const Borrow = lazy(() =>
  import('./pages/Borrow').then((m) => ({ default: m.Borrow })),
);
const Lend = lazy(() => import('./pages/Lend').then((m) => ({ default: m.Lend })));

const Rent = lazy(() => import('./pages/Rent').then((m) => ({ default: m.Rent })));
const Positions = lazy(() =>
  import('./pages/Positions').then((m) => ({ default: m.Positions })),
);
const PositionDetails = lazy(() =>
  import('./pages/PositionDetails').then((m) => ({ default: m.PositionDetails })),
);
const Claims = lazy(() =>
  import('./pages/Claims').then((m) => ({ default: m.Claims })),
);
const Offers = lazy(() =>
  import('./pages/Offers').then((m) => ({ default: m.Offers })),
);
const Desk = lazy(() => import('./pages/Desk').then((m) => ({ default: m.Desk })));
const Vault = lazy(() => import('./pages/Vault').then((m) => ({ default: m.Vault })));
const Activity = lazy(() =>
  import('./pages/Activity').then((m) => ({ default: m.Activity })),
);
const Vpfi = lazy(() => import('./pages/Vpfi').then((m) => ({ default: m.Vpfi })));
const Settings = lazy(() =>
  import('./pages/Settings').then((m) => ({ default: m.Settings })),
);
const NftVerifier = lazy(() =>
  import('./pages/NftVerifier').then((m) => ({ default: m.NftVerifier })),
);
const Faucet = lazy(() =>
  import('./pages/Faucet').then((m) => ({ default: m.Faucet })),
);
const DataRights = lazy(() =>
  import('./pages/DataRights').then((m) => ({ default: m.DataRights })),
);
const RiskAccess = lazy(() =>
  import('./pages/RiskAccess').then((m) => ({ default: m.RiskAccess })),
);
const Recover = lazy(() =>
  import('./pages/Recover').then((m) => ({ default: m.Recover })),
);
const Help = lazy(() => import('./pages/Help').then((m) => ({ default: m.Help })));
// #1959 — the two surfaces the #1854 cutover did not port. Until these
// existed, `defi.vaipakam.com` could not be retired: the marketing site
// links to both, and pointing those links here would have landed
// visitors on the in-shell NotFound below.
const Analytics = lazy(() =>
  import('./pages/Analytics').then((m) => ({ default: m.Analytics })),
);
const ProtocolConsole = lazy(() =>
  import('./pages/ProtocolConsole').then((m) => ({ default: m.ProtocolConsole })),
);
const NotFound = lazy(() =>
  import('./pages/NotFound').then((m) => ({ default: m.NotFound })),
);

/** `/vpfi-vault` → `/vpfi`, carrying the fragment across.
 *
 *  A bare `<Navigate to="/vpfi">` drops the hash, so the legacy deep
 *  link `/vpfi-vault#step-2` landed at the top of the page — silently
 *  losing the very anchor the bookmark existed for. And the old
 *  fragment name does not survive the rename: the deposit section is
 *  `#deposit` here, so `#step-2` has to be TRANSLATED, not merely
 *  preserved. Unknown fragments pass through unchanged rather than
 *  being dropped; a hash this map has not heard of is more likely a
 *  section that still exists than one that does not.
 */
function LegacyVpfiVaultRedirect() {
  const { hash } = useLocation();
  const mapped = hash === '#step-2' ? '#deposit' : hash;
  return <Navigate to={`/vpfi${mapped}`} replace />;
}

/** Legacy `/<locale>/...` bookmarks from the retired deployment.
 *
 *  The old app mounted its whole `pageRoutes()` tree TWICE — once
 *  unprefixed and once under `:locale` — so `/es/analytics`,
 *  `/de/protocol-console` and `/ja/vpfi-vault#step-2` are all real
 *  bookmarks somebody holds. This app has no locale segment (language
 *  is a user setting, not a URL), so a path-preserving redirect from
 *  the old host would land every one of them on NotFound.
 *
 *  It strips the locale and RE-ENTERS the router at the unprefixed
 *  path, deliberately rather than mapping the renames itself. The
 *  alias routes above already know that `/nft-verifier` is `/nft` and
 *  that `#step-2` is `#deposit`; duplicating that table here would
 *  give the two copies somewhere to drift apart, and the localized
 *  half would be the copy nobody notices is wrong. Two client-side
 *  `replace` hops, no history entry either time.
 *
 *  An unknown first segment falls through to NotFound — the same
 *  answer the catch-all would have given, so this cannot swallow a
 *  genuine 404 and report it as a redirect.
 */
function LegacyLocaleRedirect() {
  const params = useParams();
  const { search, hash } = useLocation();
  const locale = (params.locale ?? '').toLowerCase();
  const known = (SUPPORTED_LOCALES as readonly string[]).includes(locale);
  if (!known) return <NotFound />;
  const rest = params['*'] ?? '';
  return <Navigate to={`/${rest}${search}${hash}`} replace />;
}

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Home />} />
        <Route path="/borrow" element={<Borrow />} />
        <Route path="/lend" element={<Lend />} />
        <Route path="/rent" element={<Rent />} />
        <Route path="/positions" element={<Positions />} />
        <Route path="/positions/:loanId" element={<PositionDetails />} />
        <Route path="/claims" element={<Claims />} />
        <Route path="/offers" element={<Offers />} />
        <Route path="/desk" element={<Desk />} />
        <Route path="/vault" element={<Vault />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/vpfi" element={<Vpfi />} />
        <Route path="/nft" element={<NftVerifier />} />
        <Route path="/nft/:tokenId" element={<NftVerifier />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/risk-access" element={<RiskAccess />} />
        {/* T-054 — deliberately UNLISTED (Help explainer deep link
            only); see the page header for why discoverability is
            gated. */}
        <Route path="/recover" element={<Recover />} />
        <Route path="/faucet" element={<Faucet />} />
        <Route path="/help" element={<Help />} />
        {/* #1960 — the connected app's own data-rights controls. The
            marketing site's page cannot reach this origin's storage,
            so this is a separate page, not a link to that one. */}
        <Route path="/data-rights" element={<DataRights />} />

        {/* #1959 — both are PUBLIC and wallet-free by design. They are
            the marketing site's deep-link targets, so a visitor arriving
            cold must get the real page, not a connect wall. */}
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/protocol-console" element={<ProtocolConsole />} />
        {/* The prose reference lives on the marketing apex so it indexes
            with the other public explainers; this app owns only the live
            values. Sending `/protocol-console/docs` there keeps the old
            defi URL working instead of 404ing. */}
        <Route
          path="/protocol-console/docs"
          element={<ExternalRedirect url="https://vaipakam.com/protocol-console/docs" />}
        />

        {/* Aliases people will guess or carry over from apps/defi. */}
        <Route path="/earn" element={<Navigate to="/lend" replace />} />
        <Route path="/loans" element={<Navigate to="/positions" replace />} />
        <Route path="/loans/:loanId" element={<AliasLoanRedirect />} />
        {/* The agent Worker's alert deep links use the /loans/N shape
            (the alias above); older alert messages carried the
            pre-flattening /app/loans/N shape — accept that too so a
            stale alert link still lands on the loan, not NotFound. */}
        <Route path="/app/loans/:loanId" element={<AliasLoanRedirect />} />
        <Route path="/dashboard" element={<Navigate to="/positions" replace />} />
        <Route path="/manage" element={<Navigate to="/positions" replace />} />
        <Route path="/claim" element={<Navigate to="/claims" replace />} />
        <Route path="/claim-center" element={<Navigate to="/claims" replace />} />
        <Route path="/offer-book" element={<Navigate to="/offers" replace />} />
        <Route path="/trade" element={<Navigate to="/desk" replace />} />
        <Route path="/terminal" element={<Navigate to="/desk" replace />} />
        <Route path="/vpfi-vault" element={<LegacyVpfiVaultRedirect />} />
        <Route path="/nft-rental" element={<Navigate to="/rent" replace />} />
        {/* The verifier's legacy path. Its absence would have sent every
            existing `/nft-verifier` bookmark to NotFound the moment the
            old host started redirecting here — which is the one thing
            the deployment runbook promises retiring the host will not
            do. */}
        <Route path="/nft-verifier" element={<Navigate to="/nft" replace />} />
        <Route path="/vault-assets" element={<Navigate to="/vault" replace />} />
        <Route path="/history" element={<Navigate to="/activity" replace />} />

        {/* Locale-prefixed bookmarks from the retired deployment. Must
            sit immediately before the catch-all: a first segment that
            is not a known locale is a genuine 404 and falls through to
            it. */}
        <Route path=":locale/*" element={<LegacyLocaleRedirect />} />

        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

function AliasLoanRedirect() {
  const { loanId } = useParams();
  return <Navigate to={`/positions/${loanId}`} replace />;
}
