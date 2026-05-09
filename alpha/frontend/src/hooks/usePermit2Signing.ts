import { useCallback } from 'react';
import { useWallet } from '../context/WalletContext';
import { useWalletClient } from 'wagmi';
import type { Address, Hex } from 'viem';

/**
 * Phase 8b.1 — client-side Permit2 typed-data builder + signer.
 *
 * Returns a `sign` function the consuming page calls with `{ token,
 * amount, spender }`. The hook constructs the EIP-712 payload using
 * Uniswap's canonical Permit2 domain + types, asks the connected
 * wallet to sign, and returns `{ permit, signature }` ready to
 * forward to the corresponding `*WithPermit` entry point on the
 * Diamond.
 *
 * Falls back gracefully: if the wallet errors on `signTypedData` (old
 * hardware wallets, EIP-712 v4 unsupported, etc.), the hook surfaces
 * the error so the caller can route the user back to the classic
 * `approve` + action path.
 */

const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;
const PERMIT_DEADLINE_SECONDS = 30 * 60; // 30 minutes per Phase 8b Q4.

// EIP-712 types for `PermitTransferFrom`. Must match Uniswap's
// canonical definition so the signature verifies inside Permit2.
const PERMIT2_TYPES = {
  PermitTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
} as const;

export interface Permit2Payload {
  permit: {
    permitted: { token: Address; amount: bigint };
    nonce: bigint;
    deadline: bigint;
  };
  signature: Hex;
}

export interface Permit2SignInput {
  /** ERC-20 token the user is permitting. */
  token: Address;
  /** Max amount the user is authorising the spender to pull. */
  amount: bigint;
  /** Spender — must equal the address that will call `permitTransferFrom`.
   *  For Vaipakam, this is the Diamond. Baked into the signature so
   *  other callers can't reuse it. */
  spender: Address;
}

export function usePermit2Signing() {
  const { address, chainId } = useWallet();
  const { data: walletClient } = useWalletClient();

  const sign = useCallback(
    async (input: Permit2SignInput): Promise<Permit2Payload> => {
      if (!address || !chainId) throw new Error('Wallet not connected');
      if (!walletClient) throw new Error('Wallet client not available');

      const deadline =
        BigInt(Math.floor(Date.now() / 1000)) + BigInt(PERMIT_DEADLINE_SECONDS);
      // Random 256-bit nonce so we don't collide with any other
      // Permit2 consumer burning the same wallet's nonces. Permit2's
      // unordered-nonces model lets us pick any unused bit — a
      // random large number is overwhelmingly unlikely to clash.
      const nonce = randomNonce();

      const permit = {
        permitted: { token: input.token, amount: input.amount },
        nonce,
        deadline,
      };

      // viem's `signTypedData` wraps the wallet's EIP-712 method.
      // Returns a 65-byte ECDSA signature encoded as 0x-hex.
      const signature = (await walletClient.signTypedData({
        account: address as Address,
        domain: {
          name: 'Permit2',
          chainId,
          verifyingContract: PERMIT2_ADDRESS,
        },
        types: PERMIT2_TYPES,
        primaryType: 'PermitTransferFrom',
        message: {
          permitted: permit.permitted,
          spender: input.spender,
          nonce: permit.nonce,
          deadline: permit.deadline,
        },
      })) as Hex;

      return { permit, signature };
    },
    [address, chainId, walletClient],
  );

  /** Best-effort capability probe — most modern wallets support EIP-712
   *  v4. Hardware wallets sometimes don't; if `sign` throws with
   *  `code -32601` (method not found) or a similar signal, callers
   *  should fall back to the classic approve+action flow. */
  const canSign = Boolean(walletClient) && Boolean(address);

  return { sign, canSign, permit2Address: PERMIT2_ADDRESS };
}

function randomNonce(): bigint {
  // 32 random bytes → uint256. Browser crypto is required; if absent
  // we'd be in a wallet that won't sign EIP-712 anyway.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}
