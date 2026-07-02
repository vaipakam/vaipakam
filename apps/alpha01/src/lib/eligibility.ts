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
  return [
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
    {
      id: 'sanctions',
      label: 'Wallet passes sanctions screening',
      ok: !opts.sanctionsLoading && !opts.isSanctioned,
      fixLabel: opts.isSanctioned ? 'Use a different wallet' : undefined,
    },
    {
      id: 'terms',
      label: 'Risk & terms acknowledged',
      ok: opts.consent,
      fixLabel: 'Acknowledge below',
    },
  ];
}