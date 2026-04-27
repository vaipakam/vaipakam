import type { TocSection } from '../lib/markdownToc';

/**
 * Shared TOC sidebar used by Overview, Whitepaper, and User Guide
 * help pages. Renders a two-level list — H2-derived section groups
 * containing H3-derived jump links — using the existing
 * `.user-guide-toc-*` styles.
 *
 * Each link is a plain `<a href="${basePath}#${item.id}">`. Same-
 * page hash navigation is handled by the browser; cross-page links
 * (when the basePath differs from the current path) are full
 * navigations. The optional `onItemClick` is fired before the
 * navigation so the User Guide's mobile accordion can collapse
 * itself; Overview / Whitepaper don't need this and can omit it.
 */
interface HelpTocProps {
  toc: TocSection[];
  /** Path the page is mounted at (e.g. `/ta/help/overview`). Used to
   *  build absolute hrefs that swap only the fragment. */
  basePath: string;
  /** Optional click handler for accordion-collapse semantics on the
   *  User Guide's mobile TOC. */
  onItemClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}

export function HelpToc({ toc, basePath, onItemClick }: HelpTocProps) {
  return (
    <nav className="user-guide-toc" aria-label="Table of contents">
      {toc.map((section, sIdx) => (
        <div key={sIdx} className="user-guide-toc-group">
          {section.title && (
            <div className="user-guide-toc-group-title">{section.title}</div>
          )}
          <ul className="user-guide-toc-list">
            {section.items.map((item) => (
              <li key={item.id} className="user-guide-toc-item">
                <a
                  href={`${basePath}#${item.id}`}
                  onClick={onItemClick}
                >
                  {item.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
