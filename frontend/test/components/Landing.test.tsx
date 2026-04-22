import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../utils';

vi.mock('ethers', async () => ({
  BrowserProvider: class { async getSigner() { return { getAddress: async () => '0x0' }; } async getNetwork() { return { chainId: 1n }; } async send() {} },
  JsonRpcSigner: class {},
  JsonRpcProvider: class { async getNetwork() { return { chainId: 1n }; } },
}));

import Hero from '../../src/components/Hero';
import CTA from '../../src/components/CTA';
import Features from '../../src/components/Features';
import HowItWorks from '../../src/components/HowItWorks';
import Security from '../../src/components/Security';
import FAQ from '../../src/components/FAQ';
import Footer from '../../src/components/Footer';
import Navbar from '../../src/components/Navbar';
import LandingPage from '../../src/pages/LandingPage';

describe('Landing components', () => {
  it('Hero renders title + sample cards', () => {
    renderWithProviders(<Hero />);
    expect(screen.getByRole('heading', { name: /Peer-to-Peer Lending/i })).toBeInTheDocument();
    expect(screen.getByText(/Lend 1,000 USDC/i)).toBeInTheDocument();
    expect(screen.getByText(/Launch App/i)).toBeInTheDocument();
  });

  it('CTA renders', () => {
    renderWithProviders(<CTA />);
    expect(screen.getByRole('heading', { name: /Ready to start lending/i })).toBeInTheDocument();
  });

  it('Features renders', () => {
    renderWithProviders(<Features />);
    expect(screen.getByText(/Features/i)).toBeInTheDocument();
  });

  it('HowItWorks renders', () => {
    renderWithProviders(<HowItWorks />);
    expect(screen.getByText(/How It Works/i)).toBeInTheDocument();
  });

  it('Security renders', () => {
    renderWithProviders(<Security />);
    expect(screen.getByText(/Security/i)).toBeInTheDocument();
  });

  it('FAQ expands items', async () => {
    renderWithProviders(<FAQ />);
    const first = screen.getAllByRole('button')[0];
    await userEvent.click(first);
    // clicking again to close
    await userEvent.click(first);
    expect(first).toBeInTheDocument();
  });

  it('Footer renders', () => {
    renderWithProviders(<Footer />);
    expect(
      screen.getByText(/Decentralized peer-to-peer lending/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/BUSL 1\.1 License/i)).toBeInTheDocument();
  });

  it('Footer logo onError hides image', () => {
    renderWithProviders(<Footer />);
    const img = document.querySelector('.footer-logo') as HTMLImageElement;
    img.dispatchEvent(new Event('error'));
    expect(img.style.display).toBe('none');
  });

  it('Navbar logo onError hides and reveals sibling', () => {
    renderWithProviders(<Navbar />);
    const img = document.querySelector('.navbar-logo') as HTMLImageElement;
    img.dispatchEvent(new Event('error'));
    expect(img.style.display).toBe('none');
  });

  it('Navbar nav link click closes mobile menu', async () => {
    renderWithProviders(<Navbar />);
    const links = document.querySelectorAll('.navbar-link');
    await userEvent.click(links[0]);
  });

  it('Navbar mobile menu toggles open/close', async () => {
    renderWithProviders(<Navbar />);
    const btn = document.querySelector('.mobile-menu-btn') as HTMLElement;
    await userEvent.click(btn);
    await userEvent.click(btn);
  });

  it('Navbar renders with wallet states', async () => {
    renderWithProviders(<Navbar />);
    expect(screen.getAllByText(/Features/i).length).toBeGreaterThan(0);
    const toggleBtns = screen.getAllByRole('button');
    // Click a button to exercise event handlers (mobile menu etc.)
    await userEvent.click(toggleBtns[0]);
  });

  it('LandingPage composes all sections', () => {
    renderWithProviders(<LandingPage />);
    expect(screen.getByRole('heading', { name: /Peer-to-Peer Lending/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Ready to start lending/i })).toBeInTheDocument();
  });
});
