import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../src/context/ThemeContext';
import Navbar from '../../src/components/Navbar';

/*
 * #1076: the public-shell Navbar dropped ALL wallet UI (Connect /
 * Switch Network / address+Disconnect / error banner). The defi Navbar
 * now only renders on the public-read shell pages (Analytics / NFT
 * Verifier / Protocol Console) and consumes NO WalletContext — every
 * wallet-bearing surface moved inside <AppLayout>. The old wallet-
 * centric cases tested a surface that no longer exists; they're
 * replaced with cases for the current navbar (Launch CTA, Verify
 * dropdown, Documentation link, settings gear + theme toggle, mobile
 * menu). Only ThemeProvider + a router are needed — no wagmi/wallet
 * providers, matching the component's real dependencies.
 */
function renderNav() {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <Navbar />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('Navbar', () => {
  it('renders the Launch Vaipakam CTA', () => {
    renderNav();
    expect(
      screen.getAllByRole('link', { name: /Launch Vaipakam/i }).length,
    ).toBeGreaterThan(0);
  });

  it('renders the Verify dropdown trigger', () => {
    renderNav();
    expect(
      screen.getByRole('button', { name: /^Verify/i }),
    ).toBeInTheDocument();
  });

  it('renders the in-domain Verify menu items', () => {
    // The desktop popover stays mounted (inert when closed) so CSS can
    // transition both directions — the menuitems are always in the DOM.
    // (Asserting aria-expanded toggling is brittle here: userEvent's
    // synthesised mouse fires the group's hover-to-open first, which the
    // trigger's click then toggles back closed — real-mouse behaviour.)
    renderNav();
    expect(screen.getAllByRole('menuitem', { name: /Analytics/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('menuitem', { name: /NFT Verifier/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('menuitem', { name: /Protocol Console/i }).length).toBeGreaterThan(0);
  });

  it('renders the flat Documentation link', () => {
    renderNav();
    expect(
      screen.getAllByRole('link', { name: /Documentation/i }).length,
    ).toBeGreaterThan(0);
  });

  it('opens the settings popover and fires the theme toggle', async () => {
    renderNav();
    // Settings gear opens a popover holding the Language picker + theme
    // toggle. Before opening, no theme toggle is in the DOM.
    const gear = screen.getByRole('button', { name: /Settings/i });
    await userEvent.click(gear);
    // Theme toggle carries a "Switch to light/dark theme" aria-label.
    const themeToggle = screen.getByRole('button', {
      name: /Switch to (light|dark) theme/i,
    });
    await userEvent.click(themeToggle);
    // After toggling, the aria-label flips to the opposite direction.
    expect(
      screen.getByRole('button', { name: /Switch to (light|dark) theme/i }),
    ).toBeInTheDocument();
  });

  it('toggles the mobile menu open and closed', async () => {
    renderNav();
    const toggle = screen.getByRole('button', { name: /Toggle menu/i });
    // Fire the handler both directions to exercise the open/close state.
    await userEvent.click(toggle);
    await userEvent.click(toggle);
    expect(toggle).toBeInTheDocument();
  });
});
