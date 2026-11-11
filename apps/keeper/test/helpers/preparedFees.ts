// apps/keeper/test/helpers/preparedFees.ts
//
// What a real `prepareTransactionRequest` adds to a send on Base Sepolia: the
// chain id and the fee fields, at ordinary figures inside the chain's
// built-in signing ceilings (`src/signingGuard.ts`, #3543). A wallet mock
// that returns only its arguments would be refused before the signature.

/** The fields the signing guard reads, for a send on chain 84532. */
export const PREPARED_FEES_84532 = {
  chainId: 84532,
  gas: 300_000n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 1_000_000n,
} as const;
