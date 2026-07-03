/** Production indexer — same default as apps/defi `.env.example`. */
const DEFAULT_INDEXER_ORIGIN = 'https://indexer.vaipakam.com';

/**
 * Resolve the indexer read-API origin. In local dev, fall back to the
 * public staging indexer when `VITE_INDEXER_ORIGIN` is unset so positions
 * and offer matching work out of the box.
 */
export function resolveIndexerOrigin(envValue: string | undefined): string | null {
  const trimmed = envValue?.trim();
  if (trimmed) return trimmed.replace(/\/$/, '');
  if (import.meta.env.DEV) return DEFAULT_INDEXER_ORIGIN;
  return null;
}