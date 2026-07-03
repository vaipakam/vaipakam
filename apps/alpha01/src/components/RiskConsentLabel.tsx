import { LEGAL_URLS } from '../lib/legalUrls';

export function RiskConsentLabel() {
  return (
    <span>
      I understand the{' '}
      <a href={LEGAL_URLS.riskDisclosure} target="_blank" rel="noopener noreferrer">
        risks
      </a>{' '}
      and agree to the{' '}
      <a href={LEGAL_URLS.terms} target="_blank" rel="noopener noreferrer">
        Terms of Service
      </a>{' '}
      and{' '}
      <a href={LEGAL_URLS.privacy} target="_blank" rel="noopener noreferrer">
        Privacy Policy
      </a>
      .
    </span>
  );
}