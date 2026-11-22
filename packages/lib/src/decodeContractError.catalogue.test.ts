/**
 * The decoder reads the error catalogue (#3916). These replace the drift guard
 * over the hand-kept selector table (#68): the table is gone, and the
 * catalogue is generated from the compiled interfaces, so what is left to pin
 * is that the decoder reads it the way the catalogue says.
 */
import { describe, it, expect } from 'vitest';
import { encodeErrorResult, toFunctionSelector } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { ERROR_CATALOGUE } from '@vaipakam/contracts/error-catalogue';
import {
  KNOWN_ERROR_SELECTORS,
  INTERNAL_FAULT_KEY,
  contractErrorCatalog,
  decodeContractError,
  friendlyContractError,
  humanizeErrorName,
} from './decodeContractError';

const rows = Object.entries(ERROR_CATALOGUE);

describe('decoder reads the error catalogue', () => {
  it('every known selector hashes from its signature', () => {
    const bad = Object.entries(KNOWN_ERROR_SELECTORS).filter(
      ([sel, sig]) => toFunctionSelector(sig).toLowerCase() !== sel,
    );
    expect(bad).toEqual([]);
  });

  it('every error the Diamond can raise has a name the decoder knows', () => {
    // A tuple-typed error hashes from its expanded form, which the catalogue
    // computes; the plain ones are checked here.
    for (const e of DIAMOND_ABI_VIEM) {
      if (e.type !== 'error' || e.inputs.some((i) => i.type.startsWith('tuple'))) continue;
      const sel = toFunctionSelector(`${e.name}(${e.inputs.map((i) => i.type).join(',')})`).toLowerCase();
      expect(KNOWN_ERROR_SELECTORS[sel], e.name).toBeDefined();
    }
  });

  it('an error with a written message decodes to that message, by selector and by name', () => {
    const withMessage = rows.filter(([, r]) => r.message && !r.internal);
    expect(withMessage.length).toBeGreaterThan(100);
    for (const [sel, row] of withMessage) {
      expect(decodeContractError({ data: sel }), row.signature).toBe(row.message);
      const sameName = rows.filter(([, r]) => r.name === row.name);
      if (sameName.length === 1) expect(friendlyContractError({ name: row.name })).toBe(row.message);
    }
  });

  it('an internal error is shown as a fault of the platform, never with its own text', () => {
    const internal = rows.filter(([, r]) => r.internal);
    expect(internal.length).toBeGreaterThan(0);
    const fault = contractErrorCatalog()[INTERNAL_FAULT_KEY];
    for (const [sel, row] of internal) {
      expect(decodeContractError({ data: sel }), row.signature).toBe(fault);
      expect(decodeContractError({ data: sel })).not.toBe(row.message);
    }
    // Panic(uint256) is internal: an overflow is never the user's doing.
    expect(decodeContractError({ data: '0x4e487b710000000000000000000000000000000000000000000000000000000000000011' })).toBe(fault);
  });

  it('a text revert keeps its own reason', () => {
    const data = encodeErrorResult({
      abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }],
      errorName: 'Error',
      args: ['custom reason'],
    });
    expect(decodeContractError({ data, reason: 'custom reason' })).toBe('custom reason');
  });

  it('an error with no message shows its name in words', () => {
    const [sel, row] = rows.find(([, r]) => r.source === 'platform' && !r.message && !r.internal)!;
    expect(decodeContractError({ data: sel })).toBe(humanizeErrorName(row.name));
  });

  it('two errors that share a name but not a meaning never share a translation key', () => {
    const cat = contractErrorCatalog();
    const shared = rows.filter(([, r]) => rows.filter(([, o]) => o.name === r.name).length > 1 && r.message);
    for (const [, row] of shared) {
      expect(cat[row.signature]).toBe(row.message);
      expect(cat[row.name]).toBeUndefined();
    }
  });
});
