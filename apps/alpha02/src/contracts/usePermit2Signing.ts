/**
 * Permit2 typed-data builder + signer (#1038 — the port of defi's
 * usePermit2Signing).
 *
 * Returns a `sign` function a write flow calls with `{ token, amount,
 * spender }`. It constructs the EIP-712 payload using Uniswap's
 * CANONICAL Permit2 domain + types (name/chainId/verifyingContract —
 * deliberately NO `version` field, unlike the AcceptTerms domain),
 * asks the wallet to sign, and returns `{ permit, signature }` ready
 * for the Diamond's `*WithPermit` entry points.
 *
 * The hook does not catch signing errors: a wallet that refuses
 * EIP-712 (old hardware wallets, method-not-found) throws out of
 * `sign`, and the CALLER falls back to the classic approve+action
 * path — Permit2 is an upgrade, never a gate.
 *
 * The fallback boundary is the SIGNATURE step only. Once the
 * *WithPermit transaction itself has been handed to the wallet, any
 * failure surfaces to the user — never a silent classic retry. An
 * ambiguous broadcast/receipt error could ride on top of a
 * transaction that still mines (double execution), and a definitive
 * revert is almost always protocol state (offer consumed, asset
 * paused) that would doom the classic retry too — after it mined a
 * fresh approval for nothing. A manual retry re-evaluates every gate.
 */
import { useCallback } from 'react';
import { useWalletClient } from 'wagmi';
import type { Address, Hex } from 'viem';
import { useActiveChain } from '../chain/useActiveChain';

const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;
const PERMIT_DEADLINE_SECONDS = 30 * 60;

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
  /** The on-chain `ISignatureTransfer.PermitTransferFrom` tuple —
   *  note NO spender field: the contract reconstructs the spender
   *  from `msg.sender`, which is why the signature can't be replayed
   *  by any other caller. */
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
  /** Spender — must equal the address that will call
   *  `permitTransferFrom`: the Diamond. Baked into the signature so
   *  no other caller can reuse it. */
  spender: Address;
}

export function usePermit2Signing() {
  const { address, walletChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();

  const sign = useCallback(
    async (input: Permit2SignInput): Promise<Permit2Payload> => {
      if (!address || !walletChain) throw new Error('Wallet not connected');
      if (!walletClient) throw new Error('Wallet client not available');

      const deadline =
        BigInt(Math.floor(Date.now() / 1000)) + BigInt(PERMIT_DEADLINE_SECONDS);
      // Random 256-bit nonce: Permit2's unordered-nonce model lets any
      // unused bit be picked, and a random large number can't collide
      // with other Permit2 consumers burning the same wallet's nonces.
      const nonce = randomNonce();

      const permit = {
        permitted: { token: input.token, amount: input.amount },
        nonce,
        deadline,
      };

      const signature = await walletClient.signTypedData({
        account: address,
        domain: {
          name: 'Permit2',
          chainId: walletChain.chainId,
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
      });

      return { permit, signature };
    },
    [address, walletChain, walletClient],
  );

  /** Capability probe — connected wallets generally support EIP-712
   *  v4; the real answer comes from `sign` throwing, which callers
   *  treat as "use the classic path". */
  const canSign = Boolean(walletClient) && Boolean(address) && Boolean(walletChain);

  return { sign, canSign, permit2Address: PERMIT2_ADDRESS };
}

function randomNonce(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

