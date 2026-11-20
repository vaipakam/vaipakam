/**
 * #3761 — how this deployment's Lend form asks for the choice between
 * lending continuously and lending once (`DefaultPathsDesign.md` §3.3):
 * `preselected` (as shipped) opens on Auto-lend with its switches on;
 * `choose` shows the two options with neither selected until the lender taps
 * one. Both end in the same review and the same signed batch.
 */
export type LendConsentForm = 'preselected' | 'choose';

export function lendConsentForm(raw: string | undefined = import.meta.env.VITE_LEND_CONSENT_FORM): LendConsentForm {
  return raw?.trim() === 'choose' ? 'choose' : 'preselected';
}
