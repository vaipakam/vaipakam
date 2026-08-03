/**
 * Off-app documentation links (Codex #1547 r5).
 *
 * These live in their own module because the surfaces that need them
 * are in SEPARATE lazy chunks (`pages/Recover`, `pages/Help`) — a
 * constant exported from either page would drag that whole page's
 * bundle into the other's chunk, and duplicating the URL string in
 * both invites the two copies to drift apart.
 */

/**
 * The Advanced User Guide's stuck-token-recovery section on the
 * marketing site.
 *
 * The recovery declaration the user signs (RECOVERY_ACK_TEXT in
 * `pages/Recover`) asserts they have "read and understood the Advanced
 * User Guide section on stuck-token recovery" — so the app has to
 * actually SHOW them where that is. The route is `apps/www`'s
 * `/help/advanced` (its App.tsx) and the anchor is the
 * `<a id="stuck-recovery.what">` marker that opens the Stuck-Token
 * Recovery section of `content/userguide/Advanced.*.md`.
 *
 * Deliberately NOT locale-prefixed: apps/www's `DefaultLocaleRedirect`
 * moves an unprefixed path to the reader's locale and CARRIES the hash
 * across, and every localized Advanced guide ships the same
 * `stuck-recovery.*` anchors — so an unprefixed link lands a
 * non-English reader on the translated section. (The defi
 * risk-disclosure link pins `/en` only because its
 * `liquidation-mechanics.*` anchors are English-only.)
 */
export const ADVANCED_USER_GUIDE_STUCK_TOKENS_URL =
  'https://vaipakam.com/help/advanced#stuck-recovery.what';
