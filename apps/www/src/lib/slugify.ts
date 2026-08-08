/**
 * GitHub-style heading slug, split out of `markdownToc.tsx` so it can be
 * imported without pulling in React. `guideToc.ts` needs it, and
 * `guideToc.ts` is imported by a plain Node guard script as well as by
 * the page — dragging a JSX module into that path buys nothing.
 *
 * Re-exported from `markdownToc` so every existing import keeps working.
 */
/**
 * GitHub-style heading slug. Lowercase, non-alphanumeric becomes
 * hyphens, multiple hyphens collapse, leading/trailing hyphens
 * stripped. Matches the algorithm used by GitHub's renderer so
 * external links to `…#section-name` keep working when the markdown
 * is viewed on GitHub vs. in-app.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}
