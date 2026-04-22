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
import BuyVPFI from './pages/BuyVPFI';
import Rewards from './pages/Rewards';
import Activity from './pages/Activity';
import DiscordPage from './pages/Discord';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import { ScrollToHash } from './components/app/ScrollToHash';
import DiagnosticsDrawer from './components/app/DiagnosticsDrawer';

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

export default function App() {
  return (
    <BrowserRouter>
      <ScrollToHash />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/analytics" element={<PublicDashboard />} />
        <Route path="/nft-verifier" element={<PublicNftVerifier />} />
        <Route path="/discord" element={<DiscordPage />} />
        <Route path="/app" element={<AppLayout />}>
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
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
