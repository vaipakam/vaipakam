/**
 * Route table. Two rules keep dead-end URLs impossible (audit
 * F-20260702-005):
 *   - likely aliases redirect to the canonical route;
 *   - everything else lands on the in-shell NotFound page, never a
 *     blank screen.
 */
import { lazy } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { AppShell } from './components/AppShell';
// The two highest-frequency entry routes stay in the boot chunk so the
// first paint after mount is instant; everything else is a lazy chunk
// (UX-005) — advanced surfaces (desk/charts, offers, activity, vpfi,
// verifier) and the once-per-session pages (faucet, settings, help)
// don't belong in the code every first-time visitor downloads.
import { Home } from './pages/Home';
import { Borrow } from './pages/Borrow';
import { Lend } from './pages/Lend';

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
const Help = lazy(() => import('./pages/Help').then((m) => ({ default: m.Help })));
const NotFound = lazy(() =>
  import('./pages/NotFound').then((m) => ({ default: m.NotFound })),
);

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
        <Route path="/faucet" element={<Faucet />} />
        <Route path="/help" element={<Help />} />

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
        <Route path="/vpfi-vault" element={<Navigate to="/vpfi" replace />} />
        <Route path="/nft-rental" element={<Navigate to="/rent" replace />} />
        <Route path="/vault-assets" element={<Navigate to="/vault" replace />} />
        <Route path="/history" element={<Navigate to="/activity" replace />} />

        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

function AliasLoanRedirect() {
  const { loanId } = useParams();
  return <Navigate to={`/positions/${loanId}`} replace />;
}
