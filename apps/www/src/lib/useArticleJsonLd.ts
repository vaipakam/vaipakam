/**
 * TechArticle + BreadcrumbList structured data for the long-form doc
 * pages (Overview, User Guide, Whitepaper). Reuses the SAME i18n keys
 * the page already feeds `usePageMeta`, so the structured data can
 * never say something different from the visible <title>/description.
 */

import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useJsonLd } from './useJsonLd';

const ORIGIN = 'https://vaipakam.com';

export function useArticleJsonLd({
  titleKey,
  descriptionKey,
  contentLanguage,
}: {
  titleKey: string;
  descriptionKey: string;
  /** Language of the ARTICLE BODY actually rendered — pass this
   *  whenever it can differ from the active UI language (Codex #1309
   *  r1 P2): an English-only doc (Whitepaper) or a locale that fell
   *  back to the English markdown must advertise `inLanguage: en`,
   *  not the locale of the surrounding chrome. Structured data that
   *  claims a Spanish article over an English body is a mismatch
   *  crawlers penalise. Defaults to the active UI language for pages
   *  whose body genuinely follows it. */
  contentLanguage?: string;
}) {
  const { t, i18n } = useTranslation();
  const { pathname } = useLocation();

  const data = useMemo(() => {
    const path = pathname.replace(/\/+$/, '') || '/';
    const url = `${ORIGIN}${path}`;
    return {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'TechArticle',
          headline: t(titleKey),
          description: t(descriptionKey),
          url,
          inLanguage: contentLanguage ?? i18n.language,
          author: { '@type': 'Organization', name: 'Vaipakam' },
          publisher: { '@id': `${ORIGIN}/#organization` },
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            {
              '@type': 'ListItem',
              position: 1,
              name: 'Vaipakam',
              item: `${ORIGIN}/`,
            },
            {
              '@type': 'ListItem',
              position: 2,
              name: t(titleKey),
              item: url,
            },
          ],
        },
      ],
    };
  }, [t, titleKey, descriptionKey, contentLanguage, pathname, i18n.language]);

  useJsonLd('article', data);
}
