import type { ChecklistItem } from '../components/EligibilityChecklist';

export function baseEligibilityItems(opts: {
  address: string | null;
  connect: () => void;
  chainName: string;
  isCorrectChain: boolean;
  switchChain: () => void;
  consent: boolean;
  isSanctioned: boolean;
  sanctionsLoading: boolean;
}): ChecklistItem[] {
  const items: ChecklistItem[] = [
    {
      id: 'wallet',
      label: 'Wallet connected',
      ok: Boolean(opts.address),
      fixLabel: 'Connect wallet',
      onFix: opts.connect,
    },
    {
      id: 'chain',
      label: `On ${opts.chainName}`,
      ok: opts.isCorrectChain,
      fixLabel: 'Switch network',
      onFix: opts.switchChain,
    },
  ];

  // Fail-closed only — naive users never see a passing sanctions row.
  if (opts.sanctionsLoading) {
    items.push({
      id: 'sanctions',
      label: 'Checking wallet eligibility…',
      ok: false,
    });
  } else if (opts.isSanctioned) {
    items.push({
      id: 'sanctions',
      label: 'This wallet cannot open new positions',
      ok: false,
      fixLabel: 'Use a different wallet',
    });
  }

  items.push({
    id: 'terms',
    label: 'Risk & terms acknowledged',
    ok: opts.consent,
    fixLabel: 'Acknowledge below',
  });

  return items;
}

/** Gate tx CTAs while sanctions screening is in flight or flagged. */
export function sanctionsAllowsProceed(opts: {
  isSanctioned: boolean;
  sanctionsLoading: boolean;
}): boolean {
  return !opts.sanctionsLoading && !opts.isSanctioned;
}