import { describe, expect, it } from 'vitest';
import { LEGAL_URLS } from '../src/lib/legalUrls';

describe('LEGAL_URLS', () => {
  it('links risk disclosure to the Basic guide anchor', () => {
    expect(LEGAL_URLS.riskDisclosure).toContain('create-offer.risk-disclosures');
  });
});