import { defineConfig } from 'vitest/config';

/** @vaipakam/lend-kit unit tests: pure link building and parsing. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
