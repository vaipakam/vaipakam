import Navbar from '../components/Navbar';
import Hero from '../components/Hero';
import Features from '../components/Features';
import HowItWorks from '../components/HowItWorks';
import Security from '../components/Security';
import FAQ from '../components/FAQ';
import CTA from '../components/CTA';
import Footer from '../components/Footer';
import { usePageMeta } from '../lib/usePageMeta';

export default function LandingPage() {
  usePageMeta({
    titleKey: 'pageMeta.landing.title',
    descriptionKey: 'pageMeta.landing.description',
  });
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
