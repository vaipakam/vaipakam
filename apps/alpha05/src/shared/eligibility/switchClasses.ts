import type { SwitchClass } from './types';

/**
 * RB-SWITCH — what a switch class leaves open. A surface names the switch
 * and what stays open, and states the posture in every case (on, off,
 * paused, not currently known), never by silence.
 */
export interface SwitchEffect {
  blocksNewPositions: boolean;
  blocksFeatureOnOpenLoans: boolean;
  blocksClaimsAndWithdrawals: boolean;
  blocksUserActions: boolean;
  /** Tier-B sentence of what remains open. */
  staysOpen: string;
}

export const SWITCH_EFFECTS: Readonly<Record<SwitchClass, SwitchEffect>> = {
  '1a': {
    blocksNewPositions: true,
    blocksFeatureOnOpenLoans: false,
    blocksClaimsAndWithdrawals: false,
    blocksUserActions: false,
    staysOpen: 'Everything on your open positions stays available, including repayments, claims and withdrawals.',
  },
  '1b': {
    blocksNewPositions: true,
    blocksFeatureOnOpenLoans: true,
    blocksClaimsAndWithdrawals: false,
    blocksUserActions: false,
    staysOpen: 'Repaying, adding collateral, claiming and the direct exits stay open; you can always withdraw your consent.',
  },
  '2': {
    blocksNewPositions: true,
    blocksFeatureOnOpenLoans: true,
    blocksClaimsAndWithdrawals: true,
    blocksUserActions: false,
    staysOpen: 'Full and partial repayment and adding collateral stay open; paused time is credited to every due date.',
  },
  '3': {
    blocksNewPositions: true,
    blocksFeatureOnOpenLoans: false,
    blocksClaimsAndWithdrawals: false,
    blocksUserActions: false,
    staysOpen: 'Other assets and every action that does not need this asset or its price stay open.',
  },
  '4': {
    blocksNewPositions: false,
    blocksFeatureOnOpenLoans: false,
    blocksClaimsAndWithdrawals: false,
    blocksUserActions: false,
    staysOpen: 'You can still run every step on your own position directly; only the keeper service is paused.',
  },
};
