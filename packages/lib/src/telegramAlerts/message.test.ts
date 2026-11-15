/**
 * #1722 — the keeper's Telegram alerts travel as data, so whoever holds the
 * keeper's route token can make the agent send only the protocol's own
 * wording. These tests pin the parser's refusals (no free text that could
 * carry a link) and the rendering from the shared catalogues.
 */
import { describe, expect, it } from 'vitest';
import { LOCK_OUTCOMES, parseAddressedAlert, plainField, renderTelegramAlert, type AddressedAlert } from './message';

const WALLET = '0xAbC0000000000000000000000000000000000001';
const OTHER = '0x00000000000000000000000000000000000000Ff';
const ctx = { locale: 'en', chainName: 'Base Sepolia', appOrigin: 'https://app.example' };

const payout = (over: Record<string, unknown> = {}) => ({
  chainId: 84532,
  wallet: WALLET,
  alert: { kind: 'payout', what: '1.5 USDC', recipient: OTHER, releaseAt: 1_800_000_000, code: 'AB-12', lockHint: true, ...over },
});

describe('parseAddressedAlert', () => {
  it('accepts every shape and lower-cases the addresses', () => {
    const shapes = [
      { kind: 'hf', band: 'critical', loanId: 3, hf: 1.02 },
      { kind: 'preGrace', loanId: 3, hoursToEnd: 12 },
      ...LOCK_OUTCOMES.map((outcome) => (outcome === 'refused' ? { kind: 'lock', outcome, reason: 'NotOwner' } : { kind: 'lock', outcome })),
      { kind: 'locked', by: null },
      { kind: 'locked', by: OTHER },
      { kind: 'replacement', nominee: OTHER, by: OTHER },
      payout().alert,
    ];
    for (const alert of shapes) {
      const m = parseAddressedAlert({ chainId: 84532, wallet: WALLET, to: OTHER, alert });
      expect(m, JSON.stringify(alert)).not.toBeNull();
      expect(m!.wallet).toBe(WALLET.toLowerCase());
      expect(m!.to).toBe(OTHER.toLowerCase());
    }
  });

  it('refuses free text that could carry a link or markup', () => {
    for (const what of ['see https://evil.example', 'evil.example/claim', 'a:b', '<b>x</b>', '', 'x'.repeat(97)]) {
      expect(parseAddressedAlert(payout({ what })), what).toBeNull();
    }
    expect(parseAddressedAlert({ chainId: 84532, wallet: WALLET, alert: { kind: 'lock', outcome: 'refused', reason: 'go to x.io' } })).toBeNull();
    expect(parseAddressedAlert(payout({ code: 'ab-12' }))).toBeNull();
  });

  it('shows a dot before a letter as a one-dot leader, so a bare domain never links', () => {
    const what = (raw: unknown) => (parseAddressedAlert(raw)!.alert as { what: string }).what;
    expect(what(payout({ what: 'claim at evil.example' }))).toBe('claim at evil\u2024example');
    expect(what(payout({ what: '2.5 USDC.e' }))).toBe('2.5 USDC\u2024e');
  });

  it('refuses a malformed address, number, chain or kind', () => {
    expect(parseAddressedAlert({ ...payout(), wallet: '0x123' })).toBeNull();
    expect(parseAddressedAlert({ ...payout(), to: 'alice' })).toBeNull();
    expect(parseAddressedAlert({ ...payout(), chainId: 0 })).toBeNull();
    expect(parseAddressedAlert(payout({ recipient: '0xnot' }))).toBeNull();
    expect(parseAddressedAlert(payout({ releaseAt: 1.5 }))).toBeNull();
    expect(parseAddressedAlert(payout({ lockHint: 'yes' }))).toBeNull();
    expect(parseAddressedAlert({ chainId: 84532, wallet: WALLET, alert: { kind: 'hf', band: 'panic', loanId: 1, hf: 1 } })).toBeNull();
    expect(parseAddressedAlert({ chainId: 84532, wallet: WALLET, alert: { kind: 'hf', band: 'warn', loanId: 1, hf: Number.NaN } })).toBeNull();
    expect(parseAddressedAlert({ chainId: 84532, wallet: WALLET, alert: { kind: 'text', text: 'hello' } })).toBeNull();
    expect(parseAddressedAlert(null)).toBeNull();
  });
});

describe('renderTelegramAlert', () => {
  const render = (raw: unknown, locale = 'en') => renderTelegramAlert(parseAddressedAlert(raw) as AddressedAlert, { ...ctx, locale });

  it('fills only checked values, and the link is the agent origin', () => {
    const { text } = render({ chainId: 84532, wallet: WALLET, alert: { kind: 'preGrace', loanId: 9, hoursToEnd: 6 } });
    expect(text).toContain('https://app.example/loans/9');
    expect(text).toContain('Base Sepolia');
  });

  it('states the release time in UTC and the request code', () => {
    const { text } = render(payout());
    expect(text).toContain(new Date(1_800_000_000 * 1000).toISOString().slice(0, 16).replace('T', ' '));
    expect(text).toContain('AB-12');
    expect(text).toContain('send LOCK');
    expect(render(payout({ lockHint: false })).text).not.toContain('send LOCK');
  });

  it('reads a lock by the account itself, or by the wallet receiving the alert, as the owner', () => {
    const own = render({ chainId: 84532, wallet: WALLET, alert: { kind: 'locked', by: WALLET } }).text;
    expect(own).toContain('by its owner');
    const byTo = render({ chainId: 84532, wallet: WALLET, to: OTHER, alert: { kind: 'locked', by: OTHER } }).text;
    expect(byTo).toContain('by its owner');
    const byOther = render({ chainId: 84532, wallet: WALLET, alert: { kind: 'locked', by: OTHER } }).text;
    expect(byOther).toContain(OTHER.toLowerCase());
  });

  it('names the refusal and falls back to English for an unknown locale', () => {
    const raw = { chainId: 84532, wallet: WALLET, alert: { kind: 'lock', outcome: 'refused', reason: 'NotOwner' } };
    expect(render(raw, 'xx').text).toContain('the protocol refused the call (NotOwner)');
    expect(render(raw, 'de').text).not.toBe(render(raw, 'en').text);
  });
});

describe('plainField', () => {
  it('reduces a free field to what the parser accepts, so a token symbol cannot get a payout alert refused', () => {
    expect(plainField('2.5 USDC (0xA0b869…eB48)')).toBe('2.5 USDC (0xA0b869…eB48)');
    // A link-forming symbol loses its `/`, `:` and `@`; what is left parses.
    const reduced = plainField('1 https://evil.example/claim @x');
    expect(reduced).toBe('1 httpsevil.exampleclaim x');
    expect(parseAddressedAlert(payout({ what: reduced }))).not.toBeNull();
    expect(plainField('a'.repeat(200))).toHaveLength(96);
    expect(plainField('  many   spaces\n here ')).toBe('many spaces here');
    expect(plainField('///')).toBeNull();
    expect(plainField('')).toBeNull();
  });
});
