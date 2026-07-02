import { describe, expect, it } from 'vitest';
import { HELP_ANCHOR_ALIASES, resolveHelpAnchor } from '../src/components/HelpLink';

describe('resolveHelpAnchor', () => {
  it('maps legacy alpha01 anchors to Basic guide section ids', () => {
    for (const [legacy, guide] of Object.entries(HELP_ANCHOR_ALIASES)) {
      expect(resolveHelpAnchor(legacy)).toBe(guide);
    }
  });

  it('passes through unknown anchors unchanged', () => {
    expect(resolveHelpAnchor('create-offer.risk-disclosures')).toBe('create-offer.risk-disclosures');
  });
});