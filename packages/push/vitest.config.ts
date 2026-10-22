import { defineConfig } from 'vitest/config';

/**
 * @vaipakam/push unit tests. The Push SDK is mocked in every suite, so no
 * request leaves the process; the signer is a real ethers `Wallet` built from
 * a throwaway key generated per run.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
