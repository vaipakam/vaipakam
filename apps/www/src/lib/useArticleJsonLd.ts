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
}: {
  titleKey: string;
  descriptionKey: string;
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
          inLanguage: i18n.language,
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
  }, [t, titleKey, descriptionKey, pathname, i18n.language]);

  useJsonLd('article', data);
}
