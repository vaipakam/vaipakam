/**
 * #3858 — the routes a Closed network replaces with the closed view.
 *
 * Every screen whose purpose is to open a position: the guided start, the
 * borrow, lend and rent journeys, the offer book, the marketplace and the
 * faucet (whose test tokens only feed new positions). Everything else stays
 * reachable: the vault, claims, positions and their close-outs, activity,
 * settings, help, recovery, the desk (it hosts the only cancel for a signed
 * order) and the rest, because each is either a way out or a record.
 *
 * Matching follows `tosExitRoutes.ts`: case-insensitive, trailing slashes
 * ignored, a shipped locale prefix stripped.
 */
import { SUPPORTED_LOCALES } from '@vaipakam/i18n/glossary';

const OPENING_PREFIXES = ['/borrow', '/lend', '/rent', '/offers', '/marketplace', '/faucet'];

function normalise(pathname: string): string {
  const path = pathname.toLowerCase().replace(/\/+$/, '') || '/';
  const [, first, ...rest] = path.split('/');
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(first)) return path;
  return `/${rest.join('/')}`.replace(/\/+$/, '') || '/';
}

/** Whether `pathname` is a screen that opens positions. */
export function isOpeningRoute(pathname: string): boolean {
  const path = normalise(pathname);
  if (path === '/') return true;
  return OPENING_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}
