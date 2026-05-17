import { describe, it, expect } from 'vitest';
import { normalize } from '../src/scanProxy';
import type { GoPlusDecodeResult } from '../src/goPlusClient';

/**
 * ET-001 — `normalize()` turns a GoPlus `abi/input_decode` result
 * into the worker → frontend `TxScanResponse`. The verdict
 * derivation and the per-parameter address enrichment are the logic
 * most exposed to GoPlus's response shape, so they are pinned here.
 */

const ADDR_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('normalize — verdict derivation', () => {
  it('a clean decode is "safe"', () => {
    const r = normalize({ method: 'acceptOffer', params: [] });
    expect(r.verdict).toBe('safe');
    expect(r.warnings).toEqual([]);
  });

  it('a malicious target contract is "danger"', () => {
    const r = normalize({ method: 'x', malicious_contract: 1, params: [] });
    expect(r.verdict).toBe('danger');
    expect(r.maliciousContract).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/malicious/i);
  });

  it('a malicious address parameter is "danger"', () => {
    const decode: GoPlusDecodeResult = {
      method: 'transfer',
      params: [
        {
          name: 'to',
          type: 'address',
          input: ADDR_A,
          address_info: { malicious_address: 1, is_contract: 0 },
        },
      ],
    };
    const r = normalize(decode);
    expect(r.verdict).toBe('danger');
    expect(r.params[0].address?.malicious).toBe(true);
    expect(r.warnings.some((w) => w.includes('"to"'))).toBe(true);
  });

  it('a risky signature with no malice is "warning"', () => {
    const r = normalize({
      method: 'x',
      risky_signature: 1,
      signature_detail: 'unverified selector',
      params: [],
    });
    expect(r.verdict).toBe('warning');
    expect(r.warnings).toContain('unverified selector');
  });

  it('a non-empty GoPlus risk note alone is "warning"', () => {
    const r = normalize({ method: 'x', risk: 'approval to EOA', params: [] });
    expect(r.verdict).toBe('warning');
    expect(r.risk).toBe('approval to EOA');
    expect(r.warnings).toContain('approval to EOA');
  });

  it('danger outranks warning when both fire', () => {
    const r = normalize({
      method: 'x',
      malicious_contract: 1,
      risky_signature: 1,
      params: [],
    });
    expect(r.verdict).toBe('danger');
  });
});

describe('normalize — parameter mapping', () => {
  it('enriches an address parameter from address_info', () => {
    const r = normalize({
      method: 'acceptOffer',
      params: [
        {
          name: 'token',
          type: 'address',
          input: ADDR_B,
          address_info: {
            is_contract: 1,
            malicious_address: 0,
            standard: 'erc20',
            symbol: 'USDC',
            contract_name: 'FiatTokenV2',
          },
        },
      ],
    });
    const p = r.params[0];
    expect(p.value).toBe(ADDR_B);
    expect(p.address).toEqual({
      address: ADDR_B,
      isContract: true,
      malicious: false,
      contractName: 'FiatTokenV2',
      standard: 'erc20',
      symbol: 'USDC',
    });
  });

  it('leaves a non-address parameter without address enrichment', () => {
    const r = normalize({
      method: 'acceptOffer',
      params: [{ name: 'offerId', type: 'uint256', input: 42 }],
    });
    expect(r.params[0].address).toBeNull();
    expect(r.params[0].value).toBe('42');
  });

  it('tolerates a missing params array', () => {
    const r = normalize({ method: 'x' });
    expect(r.params).toEqual([]);
    expect(r.verdict).toBe('safe');
  });
});
