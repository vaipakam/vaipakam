import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Banner shown at the top of long-prose pages (Terms, Privacy) and on
 * top of the user-guide modes when no translated copy exists for the
 * active locale yet. The page itself stays in English.
 *
 * Hidden when the active locale is English — there's nothing to flag.
 */
interface EnglishOnlyNoticeProps {
  /** Pick the variant: legal-doc style ("English only") or guide style
   *  ("translation pending"). Default is the legal variant. */
  variant?: 'legal' | 'guide';
}

export function EnglishOnlyNotice({ variant = 'legal' }: EnglishOnlyNoticeProps) {
  const { t, i18n } = useTranslation();
  if (i18n.resolvedLanguage === 'en') return null;
  const titleKey =
    variant === 'guide'
      ? 'pageNotice.translationPendingTitle'
      : 'pageNotice.englishOnlyTitle';
  const bodyKey =
    variant === 'guide'
      ? 'pageNotice.translationPendingBody'
      : 'pageNotice.englishOnlyBody';
  return (
    <div
      className="alert alert-info"
      role="note"
      style={{ marginBottom: 16, display: 'flex', gap: 10, alignItems: 'flex-start' }}
    >
      <Info size={18} style={{ flex: '0 0 auto', marginTop: 2 }} />
      <div style={{ fontSize: '0.86rem', lineHeight: 1.5 }}>
        <strong>{t(titleKey)}</strong>
        <div style={{ marginTop: 2 }}>{t(bodyKey)}</div>
      </div>
    </div>
  );
}
