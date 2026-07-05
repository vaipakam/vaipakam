/**
 * Route table. Two rules keep dead-end URLs impossible (audit
 * F-20260702-005):
 *   - likely aliases redirect to the canonical route;
 *   - everything else lands on the in-shell NotFound page, never a
 *     blank screen.
 */
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { Home } from './pages/Home';
import { Borrow } from './pages/Borrow';
import { Lend } from './pages/Lend';
import { Rent } from './pages/Rent';
import { Positions } from './pages/Positions';
import { PositionDetails } from './pages/PositionDetails';
import { Claims } from './pages/Claims';
import { Offers } from './pages/Offers';
import { Vault } from './pages/Vault';
import { Activity } from './pages/Activity';
import { Vpfi } from './pages/Vpfi';
import { Settings } from './pages/Settings';
import { NftVerifier } from './pages/NftVerifier';
import { Faucet } from './pages/Faucet';
import { Help } from './pages/Help';
import { NotFound } from './pages/NotFound';

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
        {/* The agent Worker's alert deep links use the pro app's
            /app/loans/N shape — accept it here too so an alert link
            pointed at this app lands on the loan, not NotFound. */}
        <Route path="/app/loans/:loanId" element={<AliasLoanRedirect />} />
        <Route path="/dashboard" element={<Navigate to="/positions" replace />} />
        <Route path="/manage" element={<Navigate to="/positions" replace />} />
        <Route path="/claim" element={<Navigate to="/claims" replace />} />
        <Route path="/claim-center" element={<Navigate to="/claims" replace />} />
        <Route path="/offer-book" element={<Navigate to="/offers" replace />} />
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
