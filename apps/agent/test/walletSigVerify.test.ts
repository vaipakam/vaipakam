/**
 * The shared chain-aware signature verifier (#2009).
 *
 * What the family's endpoints delegate here: plain ECDSA stays an
 * RPC-free fast path, a smart account verifies through the injected
 * chain checker (ERC-1271/6492 in production via viem's
 * `verifyMessage`), and the three verdicts — yes, definitive no,
 * cannot-check — never bleed into each other: a Worker that cannot
 * reach a chain must not call a signature INVALID.
 */
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Env } from '../src/env';
import {
  MAX_SIGNATURE_BYTES,
  isValidSignatureShape,
  verifyWalletSignature,
  type ChainSigChecker,
} from '../src/walletSigVerify';

const ACCOUNT_A = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const ACCOUNT_B = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

const MESSAGE = 'Vaipakam test message\n\nWallet: 0xabc';

/** An env with one configured chain (Base Sepolia — present in the
 *  consolidated deployments, so getChainConfigs keeps it). */
const ENV_ONE_CHAIN = { RPC_BASE_SEPOLIA: 'http://rpc.test' } as Env;
/** No chains at all — the natural pre-deploy state. */
const ENV_NO_CHAINS = {} as Env;

const YES: ChainSigChecker = async () => true;
const NO: ChainSigChecker = async () => false;
const DOWN: ChainSigChecker = async () => {
  throw new Error('rpc down');
};
/** Fails the test loudly if the fast path ever consults a chain. */
const NEVER: ChainSigChecker = async () => {
  throw new Error('unexpected chain consult');
};

describe('isValidSignatureShape', () => {
  it('accepts a 65-byte ECDSA signature and a long 6492-style blob', () => {
    expect(isValidSignatureShape(`0x${'ab'.repeat(65)}`)).toBe(true);
    // A realistic ERC-6492 wrapper is hundreds of bytes.
    expect(isValidSignatureShape(`0x${'cd'.repeat(900)}`)).toBe(true);
  });

  it('rejects odd length, non-hex, missing prefix and the oversize cap', () => {
    expect(isValidSignatureShape(`0x${'ab'.repeat(65)}f`)).toBe(false);
    expect(isValidSignatureShape('0xnot-hex')).toBe(false);
    expect(isValidSignatureShape('ab'.repeat(65))).toBe(false);
    expect(
      isValidSignatureShape(`0x${'ab'.repeat(MAX_SIGNATURE_BYTES + 1)}`),
    ).toBe(false);
  });
});

describe('verifyWalletSignature', () => {
  it('plain ECDSA verifies on the fast path — no chain is consulted', async () => {
    const signature = await ACCOUNT_A.signMessage({ message: MESSAGE });
    const v = await verifyWalletSignature(
      ENV_NO_CHAINS, // even with zero chains configured
      ACCOUNT_A.address,
      MESSAGE,
      signature,
      undefined,
      NEVER,
    );
    expect(v).toEqual({ ok: true });
  });

  it('a 65-byte signature by the WRONG key falls to the chain path — a 1271 owner-key signature is not a mismatch until a chain says so', async () => {
    const signature = await ACCOUNT_B.signMessage({ message: MESSAGE });
    // The chain confirms (a smart account at A whose owner is B).
    expect(
      await verifyWalletSignature(
        ENV_ONE_CHAIN,
        ACCOUNT_A.address,
        MESSAGE,
        signature,
        84532,
        YES,
      ),
    ).toEqual({ ok: true });
    // The chain denies: NOW it is a mismatch.
    expect(
      await verifyWalletSignature(
        ENV_ONE_CHAIN,
        ACCOUNT_A.address,
        MESSAGE,
        signature,
        84532,
        NO,
      ),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('a long non-ECDSA signature (6492 shape) verifies via the chain', async () => {
    const blob = `0x${'ab'.repeat(700)}`;
    expect(
      await verifyWalletSignature(
        ENV_ONE_CHAIN,
        ACCOUNT_A.address,
        MESSAGE,
        blob,
        84532,
        YES,
      ),
    ).toEqual({ ok: true });
  });

  it('an RPC failure is UNAVAILABLE, never a mismatch', async () => {
    const blob = `0x${'ab'.repeat(700)}`;
    expect(
      await verifyWalletSignature(
        ENV_ONE_CHAIN,
        ACCOUNT_A.address,
        MESSAGE,
        blob,
        84532,
        DOWN,
      ),
    ).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('a named chain this Worker has no RPC for is UNAVAILABLE', async () => {
    const blob = `0x${'ab'.repeat(700)}`;
    expect(
      await verifyWalletSignature(
        ENV_ONE_CHAIN,
        ACCOUNT_A.address,
        MESSAGE,
        blob,
        1, // Ethereum — not configured in ENV_ONE_CHAIN
        YES,
      ),
    ).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('with no chains configured at all, a non-fast-path signature is UNAVAILABLE', async () => {
    const blob = `0x${'ab'.repeat(700)}`;
    expect(
      await verifyWalletSignature(
        ENV_NO_CHAINS,
        ACCOUNT_A.address,
        MESSAGE,
        blob,
        undefined,
        YES,
      ),
    ).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('omitted chainId tries every configured chain and takes the first yes', async () => {
    const blob = `0x${'ab'.repeat(700)}`;
    // Both chains must exist in the consolidated deployments for
    // getChainConfigs to keep them — Base Sepolia + Arbitrum Sepolia.
    const env = {
      RPC_BASE_SEPOLIA: 'http://a.test',
      RPC_ARB_SEPOLIA: 'http://b.test',
    } as Env;
    const consulted: string[] = [];
    const secondYes: ChainSigChecker = async (rpcUrl) => {
      consulted.push(rpcUrl);
      return rpcUrl === 'http://b.test';
    };
    expect(
      await verifyWalletSignature(
        env,
        ACCOUNT_A.address,
        MESSAGE,
        blob,
        undefined,
        secondYes,
      ),
    ).toEqual({ ok: true });
    expect(consulted).toContain('http://b.test');
  });

  it('one chain erroring while another definitively denies is a MISMATCH', async () => {
    const blob = `0x${'ab'.repeat(700)}`;
    const env = {
      RPC_BASE_SEPOLIA: 'http://a.test',
      RPC_ARB_SEPOLIA: 'http://b.test',
    } as Env;
    const oneDownOneNo: ChainSigChecker = async (rpcUrl) => {
      if (rpcUrl === 'http://a.test') throw new Error('down');
      return false;
    };
    expect(
      await verifyWalletSignature(
        env,
        ACCOUNT_A.address,
        MESSAGE,
        blob,
        undefined,
        oneDownOneNo,
      ),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });
});
