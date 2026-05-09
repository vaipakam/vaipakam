import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme } from '../../src/context/ThemeContext';

function Probe() {
  const { theme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button onClick={toggleTheme}>toggle</button>
    </div>
  );
}

describe('ThemeContext', () => {
  it('uses stored theme when valid', () => {
    localStorage.setItem('vaipakam-theme', 'dark');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('falls back to system preference when no stored value', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    // jsdom matchMedia mocked to matches=false → light
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
  });

  it('ignores invalid stored values', () => {
    localStorage.setItem('vaipakam-theme', 'rainbow');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(['light', 'dark']).toContain(screen.getByTestId('theme').textContent);
  });

  it('toggles and persists', async () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    const before = screen.getByTestId('theme').textContent;
    await userEvent.click(screen.getByText('toggle'));
    const after = screen.getByTestId('theme').textContent;
    expect(after).not.toBe(before);
    expect(localStorage.getItem('vaipakam-theme')).toBe(after);
  });

  it('uses dark when system prefers dark and no stored value', () => {
    localStorage.removeItem('vaipakam-theme');
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: '(prefers-color-scheme: dark)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as any;
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    window.matchMedia = original;
  });

  it('throws when useTheme used without provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/ThemeProvider/);
    spy.mockRestore();
  });
});
