/**
 * T-042 Phase 3 — manual theme toggle.
 *
 * A single button that flips the dashboard between the public
 * (site-themed) and terminal (Bloomberg/mission-control) views.
 * The choice persists in localStorage so it sticks across reloads.
 *
 * Auto-engagement on admin-wallet connect happens upstream in
 * `AdminDashboard` via `useIsProtocolAdmin()`; this component only
 * surfaces the manual override. Showing the toggle even on the
 * public site is intentional — anyone can peek at the cockpit if
 * they're curious. The toggle is decorative only; no on-chain
 * effect.
 */

import { Activity, Eye } from 'lucide-react';
import type { ProtocolConsoleThemeMode } from '../../lib/protocolConsoleTheme';

interface Props {
  mode: ProtocolConsoleThemeMode;
  onToggle: () => void;
}

export function AdminThemeToggle({ mode, onToggle }: Props) {
  const goingTo: ProtocolConsoleThemeMode = mode === 'public' ? 'terminal' : 'public';
  const Icon = goingTo === 'terminal' ? Activity : Eye;
  const label = goingTo === 'terminal' ? 'mission control view' : 'public view';
  return (
    <button
      type="button"
      className="admin-theme-toggle"
      onClick={onToggle}
      aria-label={`Switch to ${label}`}
    >
      <Icon size={13} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
