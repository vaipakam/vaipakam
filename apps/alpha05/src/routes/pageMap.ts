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
  /** Whether the page is a primary destination (in the main navigation).
   *  Which MODE shows it is not stored here: it is derived from `tier`
   *  below (RB-MODE, rulebook §4). Pages reached from a control instead
   *  (Alerts and Settings from the account menu, Help and the Verifier from
   *  the footer, a Position from its list, Activity from the account menu)
   *  are not primary. */
  nav: boolean;
  /** Where the SAME job is done in the current app today (apps/app's
   *  router), so the placeholder's fallback link lands on the feature and
   *  not on a path the current app does not serve. `null` where the current
   *  app has no page for it (the placeholder then offers no link). A `:id`
   *  segment is filled from this route's params. */
  currentApp: string | null;
}

export const PAGES: readonly PageEntry[] = [
  { path: '/', name: 'Home', tier: 'basic', rows: 'positions with next action, deadlines, first-run cards', order: 1, built: true, nav: true, currentApp: '/' },
  { path: '/borrow', name: 'Borrow', tier: 'basic', rows: 'OFF (borrow side), LN origination', order: 2, built: true, nav: true, currentApp: '/borrow' },
  { path: '/lend', name: 'Lend', tier: 'basic', rows: 'OFF (lend side), auto-lend intents', order: 3, built: true, nav: true, currentApp: '/lend' },
  { path: '/positions', name: 'Positions', tier: 'basic', rows: 'LN list, quick actions', order: 4, built: true, nav: true, currentApp: '/positions' },
  { path: '/positions/:id', name: 'Position', tier: 'basic', rows: 'LN, EX (113 rows, action-first)', order: 5, built: false, nav: false, currentApp: '/positions/:id' },
  { path: '/claims', name: 'Claims', tier: 'basic', rows: 'RW claims, EX settlements, extension reserve', order: 6, built: false, nav: true, currentApp: '/claims' },
  { path: '/vault', name: 'Vault', tier: 'basic', rows: 'ACC depository, holdings, untracked assets', order: 7, built: false, nav: true, currentApp: '/vault' },
  { path: '/offers', name: 'Offers', tier: 'basic', rows: 'OFF my offers and the book', order: 8, built: false, nav: true, currentApp: '/offers' },
  { path: '/alerts', name: 'Alerts', tier: 'basic', rows: 'ACC alerts, Telegram, push', order: 9, built: false, nav: false, currentApp: '/settings' },
  { path: '/settings', name: 'Settings', tier: 'basic', rows: 'ACC settings, consents, data rights', order: 10, built: false, nav: false, currentApp: '/settings' },
  { path: '/rent', name: 'Rent', tier: 'basic', rows: 'NFT rentals', order: 11, built: false, nav: true, currentApp: '/rent' },
  { path: '/rewards', name: 'Rewards', tier: 'basic', rows: 'RW VPFI, tiers, recycling', order: 12, built: false, nav: true, currentApp: '/vpfi' },
  { path: '/protection', name: 'Protection', tier: 'advanced', rows: 'ACC protected account mode', order: 13, built: false, nav: true, currentApp: '/vault/protection' },
  { path: '/desk', name: 'Desk', tier: 'advanced', rows: 'OFF signed orders', order: 14, built: false, nav: true, currentApp: '/desk' },
  { path: '/console', name: 'Console', tier: 'advanced', rows: 'ACC switches, keeper posture, pause', order: 15, built: false, nav: true, currentApp: '/protocol-console' },
  { path: '/recover', name: 'Recover', tier: 'advanced', rows: 'ACC/NFT adoption and disown', order: 16, built: false, nav: true, currentApp: '/recover' },
  { path: '/analytics', name: 'Analytics', tier: 'public', rows: 'metrics, transparency', order: 17, built: false, nav: true, currentApp: '/analytics' },
  { path: '/nft', name: 'Verifier', tier: 'public', rows: 'NFT position verifier', order: 18, built: false, nav: false, currentApp: '/nft' },
  { path: '/activity', name: 'Activity', tier: 'basic', rows: 'ACC activity feed', order: 19, built: false, nav: false, currentApp: '/activity' },
  { path: '/help', name: 'Help', tier: 'public', rows: 'help, guides, build provenance', order: 20, built: false, nav: false, currentApp: '/help' },
];

/** The current app's address for the same job, with this route's params
 *  filled in; null when the current app has no page for it. Alerts live on the
 *  current app's Settings page, Rewards on its VPFI page, Protection under its
 *  Vault, the Console at its protocol-console address. */
export function currentAppHref(page: PageEntry, params: Readonly<Record<string, string | undefined>>): string | null {
  if (page.currentApp === null) return null;
  const path = page.currentApp.replace(/:(\w+)/g, (_, key: string) => params[key] ?? '');
  if (path.includes('//') || (path.endsWith('/') && path !== '/')) return null;
  return `https://app.vaipakam.com${path}`;
}

/** Where a job lives today: this app's own page when it is built, otherwise
 *  the current app's page for the same job (or nowhere, when it has none).
 *  Flows that hand the reader on to another page (a finish card's next step,
 *  a review's "where to manage this") ask here, so the link switches to this
 *  app by itself the day the page is built, and never points at a
 *  placeholder after money has moved. */
export type PageHandoff = { kind: 'here'; to: string } | { kind: 'currentApp'; href: string } | { kind: 'none' };

export function pageHandoff(path: string): PageHandoff {
  const page = PAGES.find((p) => p.path === path);
  if (!page) return { kind: 'none' };
  if (page.built) return { kind: 'here', to: path };
  const href = currentAppHref(page, {});
  return href === null ? { kind: 'none' } : { kind: 'currentApp', href };
}

/** The primary navigation, DERIVED from the page map (RB-MODE): Basic shows
 *  every primary page that holds a Basic capability; Advanced shows every
 *  primary page, the public Analytics view included (rulebook §4 table).
 *  Nothing lists paths by hand, so a page's tier and its navigation cannot
 *  disagree (Codex on #3179 found Offers marked Basic yet absent here). */
export const NAV_BASIC: readonly PageEntry[] = PAGES.filter((p) => p.nav && p.tier === 'basic');
export const NAV_ADVANCED: readonly PageEntry[] = PAGES.filter((p) => p.nav);
