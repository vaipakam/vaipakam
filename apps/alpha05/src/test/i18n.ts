/**
 * A bare i18next instance for component tests: English only, no detector,
 * no lazy bundles. The app's own bootstrap (`src/i18n`) reads the browser;
 * a node test needs none of that, only `useTranslation` answering with the
 * catalog's default values.
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: {} } }, interpolation: { escapeValue: false } });
}

export default i18next;
