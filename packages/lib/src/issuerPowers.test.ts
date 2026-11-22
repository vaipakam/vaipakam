import { describe, expect, it } from 'vitest';
import {
  ISSUER_POWER_CHECKS,
  issuerCheckApplies,
  issuerChecksNotRunFor,
  issuerChecksRunFor,
  issuerRunComplete,
} from './issuerPowers';

describe('issuer-power checks (#3433)', () => {
  it('NFT-only checks never apply to a fungible token or an unknown kind', () => {
    for (const id of ['transfer_validator', 'soulbound', 'conduit_transfer'] as const) {
      expect(issuerCheckApplies(id, 'erc20')).toBe(false);
      expect(issuerCheckApplies(id, 'unknown')).toBe(false);
      expect(issuerCheckApplies(id, 'erc721')).toBe(true);
      expect(issuerCheckApplies(id, 'erc1155')).toBe(true);
    }
    expect(issuerCheckApplies('vault_transfer', 'unknown')).toBe(true);
  });

  it('the conduit move is named but not run by this list', () => {
    expect(ISSUER_POWER_CHECKS.conduit_transfer.run).toBe(false);
    expect(issuerChecksRunFor('erc721')).not.toContain('conduit_transfer');
    expect(issuerChecksNotRunFor('erc721')).toEqual(['conduit_transfer']);
    expect(issuerChecksNotRunFor('erc20')).toEqual([]);
  });

  it('simulated moves state that a refused move is found', () => {
    for (const id of ['vault_transfer', 'conduit_transfer'] as const) {
      expect(ISSUER_POWER_CHECKS[id].description).toMatch(/Found: the move was refused/);
      expect(ISSUER_POWER_CHECKS[id].description).toMatch(/Not found: the move went through/);
    }
  });

  it('a run is complete over the run checks for its kind, and unknown counts against it', () => {
    const all = new Map(issuerChecksRunFor('erc20').map((id) => [id, 'not_found']));
    expect(issuerRunComplete('erc20', all)).toBe(true);
    all.set('freeze', 'unknown');
    expect(issuerRunComplete('erc20', all)).toBe(false);
    expect(issuerRunComplete('erc721', new Map(issuerChecksRunFor('erc20').map((id) => [id, 'found'])))).toBe(false);
  });
});
