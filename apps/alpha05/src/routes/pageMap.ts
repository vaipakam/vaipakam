/**
 * The page map (rulebook §4) and the build order (§5). Every route exists
 * from the first deploy so a bookmark never 404s, and a page that is not
 * built yet SAYS so, naming the matrix rows it will carry, instead of
 * showing an empty frame a user could read as "you have nothing here".
 */
export type RouteTier = 'basic' | 'advanced' | 'public';

export interface PageEntry {
  path: string;
  name: string;
  tier: RouteTier;
  /** Matrix row prefixes this page carries (docs/internal/alpha05/feature-matrix.md). */
  rows: string;
  /** The epic's build order, 1 = first. */
  order: number;
  built: boolean;
}

export const PAGES: readonly PageEntry[] = [
  { path: '/', name: 'Home', tier: 'basic', rows: 'positions with next action, deadlines, first-run cards', order: 1, built: false },
  { path: '/borrow', name: 'Borrow', tier: 'basic', rows: 'OFF (borrow side), LN origination', order: 2, built: false },
  { path: '/lend', name: 'Lend', tier: 'basic', rows: 'OFF (lend side), auto-lend intents', order: 3, built: false },
  { path: '/positions', name: 'Positions', tier: 'basic', rows: 'LN list, quick actions', order: 4, built: false },
  { path: '/positions/:id', name: 'Position', tier: 'basic', rows: 'LN, EX (113 rows, action-first)', order: 5, built: false },
  { path: '/claims', name: 'Claims', tier: 'basic', rows: 'RW claims, EX settlements, extension reserve', order: 6, built: false },
  { path: '/vault', name: 'Vault', tier: 'basic', rows: 'ACC depository, holdings, untracked assets', order: 7, built: false },
  { path: '/offers', name: 'Offers', tier: 'basic', rows: 'OFF my offers and the book', order: 8, built: false },
  { path: '/alerts', name: 'Alerts', tier: 'basic', rows: 'ACC alerts, Telegram, push', order: 9, built: false },
  { path: '/settings', name: 'Settings', tier: 'basic', rows: 'ACC settings, consents, data rights', order: 10, built: false },
  { path: '/rent', name: 'Rent', tier: 'basic', rows: 'NFT rentals', order: 11, built: false },
  { path: '/rewards', name: 'Rewards', tier: 'basic', rows: 'RW VPFI, tiers, recycling', order: 12, built: false },
  { path: '/protection', name: 'Protection', tier: 'advanced', rows: 'ACC protected account mode', order: 13, built: false },
  { path: '/desk', name: 'Desk', tier: 'advanced', rows: 'OFF signed orders', order: 14, built: false },
  { path: '/console', name: 'Console', tier: 'advanced', rows: 'ACC switches, keeper posture, pause', order: 15, built: false },
  { path: '/recover', name: 'Recover', tier: 'advanced', rows: 'ACC/NFT adoption and disown', order: 16, built: false },
  { path: '/analytics', name: 'Analytics', tier: 'public', rows: 'metrics, transparency', order: 17, built: false },
  { path: '/nft', name: 'Verifier', tier: 'public', rows: 'NFT position verifier', order: 18, built: false },
  { path: '/activity', name: 'Activity', tier: 'basic', rows: 'ACC activity feed', order: 19, built: false },
  { path: '/help', name: 'Help', tier: 'public', rows: 'help, guides, build provenance', order: 20, built: false },
];

/** Pages in the primary navigation, by mode. */
export const NAV_BASIC = ['/', '/borrow', '/lend', '/positions', '/claims', '/vault'] as const;
export const NAV_ADVANCED = [...NAV_BASIC, '/offers', '/rewards', '/protection', '/desk', '/console'] as const;
