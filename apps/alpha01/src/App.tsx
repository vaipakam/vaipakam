import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { MobileShell } from './layouts/MobileShell';
import { HomePage } from './pages/HomePage';
import { BorrowWizard } from './pages/BorrowWizard';
import { LendWizard } from './pages/LendWizard';
import { RentPage } from './pages/RentPage';
import { PositionsPage } from './pages/PositionsPage';
import { PositionDetailPage } from './pages/PositionDetailPage';
import { ClaimsPage } from './pages/ClaimsPage';
import { ActivityPage } from './pages/ActivityPage';
import { MorePage } from './pages/MorePage';
import { SettingsPage } from './pages/SettingsPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<MobileShell />}>
          <Route index element={<HomePage />} />
          <Route path="borrow" element={<BorrowWizard />} />
          <Route path="lend" element={<LendWizard />} />
          <Route path="rent" element={<RentPage />} />
          <Route path="positions" element={<PositionsPage />} />
          <Route path="positions/:loanId" element={<PositionDetailPage />} />
          <Route path="claims" element={<ClaimsPage />} />
          <Route path="more" element={<MorePage />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}