import Navbar from '../components/Navbar';
import Hero from '../components/Hero';
import Features from '../components/Features';
import HowItWorks from '../components/HowItWorks';
import Security from '../components/Security';
import FAQ from '../components/FAQ';
import CTA from '../components/CTA';
import Footer from '../components/Footer';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { usePageMeta } from '../lib/usePageMeta';
import { useJsonLd } from '../lib/useJsonLd';

export default function LandingPage() {
  usePageMeta({
    titleKey: 'pageMeta.landing.title',
    descriptionKey: 'pageMeta.landing.description',
  });

  // Organization + WebSite structured data — sitewide facts, emitted
  // once on the landing page (Google associates them with the origin;
  // repeating them on every route adds nothing). Feeds the knowledge
  // panel and gives AI crawlers unambiguous identity facts.
  const { t } = useTranslation();
  const jsonLd = useMemo(
    () => ({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Organization',
          '@id': 'https://vaipakam.com/#organization',
          name: 'Vaipakam',
          url: 'https://vaipakam.com/',
          logo: 'https://vaipakam.com/icon-light.png',
          description: t('pageMeta.landing.description'),
          sameAs: ['https://github.com/vaipakam/vaipakam'],
        },
        {
          '@type': 'WebSite',
          '@id': 'https://vaipakam.com/#website',
          name: 'Vaipakam',
          url: 'https://vaipakam.com/',
          publisher: { '@id': 'https://vaipakam.com/#organization' },
          inLanguage: ['en', 'es', 'fr', 'de', 'ja', 'zh', 'hi', 'ar', 'ta', 'ko'],
        },
      ],
    }),
    [t],
  );
  useJsonLd('org-website', jsonLd);

  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <Features />
        <HowItWorks />
        <Security />
        <FAQ />
        <CTA />
      </main>
      <Footer />
    </>
  );
}
