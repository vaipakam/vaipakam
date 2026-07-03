import { LEGAL_URLS } from '../lib/legalUrls';
import './LegalLinks.css';

interface Props {
  className?: string;
}

export function LegalLinks({ className }: Props) {
  return (
    <nav className={`legal-links ${className ?? ''}`} aria-label="Legal">
      <a href={LEGAL_URLS.terms} target="_blank" rel="noopener noreferrer">
        Terms
      </a>
      <a href={LEGAL_URLS.privacy} target="_blank" rel="noopener noreferrer">
        Privacy
      </a>
      <a href={LEGAL_URLS.riskDisclosure} target="_blank" rel="noopener noreferrer">
        Risk disclosure
      </a>
    </nav>
  );
}