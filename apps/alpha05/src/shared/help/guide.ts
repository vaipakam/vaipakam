/**
 * Where a "Why?" panel's deep link lands (RB-HELP): the user guide on the
 * marketing site has one page per mode (`/help/basic`, `/help/advanced`),
 * each with hand-authored anchors, and the panel links the page of the
 * mode the reader is in. The route PRs add the guide sections the anchors
 * name, so an anchor is a contract between this app and apps/www.
 */
import type { AppMode } from '../../app/ModeContext';

export const GUIDE_ORIGIN = 'https://vaipakam.com';

export function guideUrl(mode: AppMode, anchor: string | undefined): string {
  const page = `${GUIDE_ORIGIN}/help/${mode === 'advanced' ? 'advanced' : 'basic'}`;
  if (!anchor) return page;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(anchor)) throw new Error(`guide anchor "${anchor}" is not a kebab-case id`);
  return `${page}#${anchor}`;
}
