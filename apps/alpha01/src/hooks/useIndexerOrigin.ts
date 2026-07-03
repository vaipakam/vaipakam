import { resolveIndexerOrigin } from '../lib/indexerOrigin';

export function useIndexerOrigin(): string | null {
  return resolveIndexerOrigin(import.meta.env.VITE_INDEXER_ORIGIN);
}