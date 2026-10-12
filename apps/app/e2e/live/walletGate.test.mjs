/**
 * #2422 r4 — the signing gate at the wallet boundary. driver.mjs runs every
 * injected-wallet request through `walletGateDecision` when a drive passes
 * `signingGate`; these pin the refusals a live run would never show.
 */
import { describe, expect, it, vi } from 'vitest';

import { CHAIN_METHODS, GATED_METHODS, walletGateDecision } from './walletGate.mjs';

const PINNED = 84532;
const okGate = () => vi.fn(async () => ({ ok: true, tag: 'allowed' }));
const decide = (o) => walletGateDecision({ activeChainId: PINNED, pinnedChainId: PINNED, role: 'lender', gate: okGate(), ...o });

describe('walletGateDecision — the chain is pinned', () => {
  it('refuses a switch to another configured chain', async () => {
    const r = await decide({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x66eee' }] }); // 421614
    expect(r).toMatchObject({ ok: false, code: 4001 });
    expect(r.why).toMatch(/pinned to chain 84532/);
  });

  it('refuses wallet_addEthereumChain for another chain, and a malformed switch', async () => {
    expect((await decide({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x1' }] })).ok).toBe(false);
    expect((await decide({ method: 'wallet_switchEthereumChain', params: [] })).ok).toBe(false);
  });

  it('allows a switch to the pinned chain itself (a no-op)', async () => {
    expect(await decide({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x14a34' }] })).toEqual({ ok: true, verdict: null });
  });

  it('refuses every signing method while the active chain is not the pinned one, without consulting the gate', async () => {
    const gate = okGate();
    for (const method of GATED_METHODS) {
      const r = await walletGateDecision({ method, params: [], activeChainId: 421614, pinnedChainId: PINNED, gate });
      expect(r.ok, method).toBe(false);
    }
    expect(gate).not.toHaveBeenCalled();
  });
});

describe('walletGateDecision — every signing method goes to the gate', () => {
  it('passes the gate verdict through when it allows', async () => {
    const gate = okGate();
    const r = await walletGateDecision({ method: 'eth_sendTransaction', params: [{}], activeChainId: PINNED, pinnedChainId: PINNED, role: 'borrower', gate });
    expect(r).toEqual({ ok: true, verdict: { ok: true, tag: 'allowed' } });
    expect(gate).toHaveBeenCalledWith('eth_sendTransaction', [{}], { role: 'borrower', chainId: PINNED });
  });

  it('refuses with 4001 when the gate refuses, returns nothing, or throws', async () => {
    for (const gate of [
      async () => ({ ok: false, why: 'not in the plan' }),
      async () => undefined,
      async () => ({ ok: 'yes' }),
      async () => {
        throw new Error('boom');
      },
    ]) {
      const r = await walletGateDecision({ method: 'personal_sign', params: [], activeChainId: PINNED, pinnedChainId: PINNED, gate });
      expect(r).toMatchObject({ ok: false, code: 4001 });
    }
  });

  it('gates every signing method, including the ones the wallet does not implement', () => {
    for (const m of ['eth_sendTransaction', 'eth_signTypedData_v4', 'personal_sign', 'eth_sign', 'wallet_sendCalls', 'eth_sendUserOperation']) {
      expect(GATED_METHODS.has(m), m).toBe(true);
    }
    expect(CHAIN_METHODS.has('wallet_switchEthereumChain')).toBe(true);
  });

  it('lets reads through without consulting the gate', async () => {
    const gate = okGate();
    const r = await walletGateDecision({ method: 'eth_call', params: [], activeChainId: 421614, pinnedChainId: PINNED, gate });
    expect(r).toEqual({ ok: true, verdict: null });
    expect(gate).not.toHaveBeenCalled();
  });
});
