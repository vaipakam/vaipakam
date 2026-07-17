/**
 * JSON-LD structured-data hook — injects a
 * `<script type="application/ld+json">` into `document.head` for the
 * duration of the mount.
 *
 * Same zero-dependency direct-DOM pattern as `usePageMeta` /
 * `HreflangAlternates` (keeping the SEO machinery one-shape). Each
 * call site passes a stable `id` so remounts and language changes
 * replace their own script instead of stacking duplicates.
 *
 * Structured data is what feeds Google rich results (FAQ dropdowns,
 * article metadata, org knowledge panel) and gives AI crawlers
 * unambiguous machine-readable facts — worth maintaining even though
 * it renders nothing.
 *
 * NOTE for authors: emit schema.org types Google documents support
 * (Organization, WebSite, FAQPage, TechArticle, BreadcrumbList).
 * Content must mirror what the page visibly renders — structured
 * data that diverges from visible content is a spam signal.
 */

import { useEffect } from 'react';

export function useJsonLd(id: string, data: object | null) {
  useEffect(() => {
    if (typeof document === 'undefined' || data === null) return;

    const attr = 'data-jsonld';
    let tag = document.querySelector(
      `script[${attr}="${id}"]`,
    ) as HTMLScriptElement | null;
    if (!tag) {
      tag = document.createElement('script');
      tag.type = 'application/ld+json';
      tag.setAttribute(attr, id);
      document.head.appendChild(tag);
    }
    tag.textContent = JSON.stringify(data);

    return () => {
      if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
    };
  }, [id, data]);
}
