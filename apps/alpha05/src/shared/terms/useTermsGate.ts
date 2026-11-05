import { useState } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { useTrackedTx, type TrackedTx } from '../tx/useTrackedTx';
import { reviewIdentity } from '../ui/ActionFlow';
import { LEGAL_ABI, readTerms, type TermsState } from './terms';

/** Phases a transaction is still out in: never reset, never re-opened. */
export const IN_FLIGHT: ReadonlySet<string> = new Set(['signing', 'submitted', 'mined']);

export type NeededTerms = Extract<TermsState, { kind: 'needed' }>;

/** One opening of the Terms prompt: what it shows, under which identity. */
export interface TermsSession {
  /** The version and fingerprint under review; a re-check that finds a
   *  newer one replaces it before the wallet opens. */
  terms: NeededTerms;
  /** The wallet and network the prompt was opened under (RB-REVIEW). */
  identity: string;
  /** An acceptance was found already recorded (another tab): the action
   *  may continue without a second one. */
  settled: boolean;
  /** When the Terms shown were read: at opening, then at each re-check. */
  readAt: number;
}

export interface TermsGate {
  session: TermsSession | null;
  tx: TrackedTx;
  /** Open the prompt for these Terms, in review. */
  start: (terms: NeededTerms) => void;
  update: (patch: Partial<Omit<TermsSession, 'identity'>>) => void;
  /** Forget the session and return the tracker to idle; refused (a no-op)
   *  while a transaction is in flight, whose hash is never dropped. */
  end: () => void;
}

/**
 * ACC-15 — the Terms acceptance as state OWNED BY THE ASKING SECTION, held
 * above the prompt and above the section's own "no wallet" return. The
 * prompt is a view of it: a wallet or network switch that unmounts the
 * prompt cannot drop a pending acceptance's hash or offer a second one,
 * because the tracker (which keeps the chain, account and read-back each
 * transaction was submitted with) and the session survive the remount.
 */
export function useTermsGate(chain: SupportedChain | null, own: OwnStateClient | null): TermsGate {
  const { text, format } = useCopy();
  const config = useConfig();
  const [session, setSession] = useState<TermsSession | null>(null);
  const diamond = (chain?.diamondAddress ?? '0x') as `0x${string}`;
  const account = (own?.account ?? '0x') as `0x${string}`;

  const tx = useTrackedTx({
    chainId: chain?.chainId ?? 0,
    account,
    send: () => {
      if (!session || !chain) throw new Error('no Terms under review');
      return writeContract(config, {
        address: diamond,
        abi: LEGAL_ABI,
        functionName: 'acceptTerms',
        args: [session.terms.version, session.terms.hash],
        chainId: chain.chainId,
        account,
      });
    },
    measure: async () => {
      if (!session || !own) return [];
      const reviewed = session.terms;
      const label = format('terms.legAccepted', { version: String(reviewed.version) });
      const after = (await own.read((c) => readTerms(c, diamond, account))).value;
      if (after.kind === 'accepted' && after.version === reviewed.version && after.hash === reviewed.hash) return [{ status: 'done', label }];
      return [{ status: 'not-done', label, reason: text('terms.legMissing') }];
    },
  });

  const inFlight = IN_FLIGHT.has(tx.phase.kind);
  const start = (terms: NeededTerms) => {
    if (!own || inFlight) return;
    if (tx.phase.kind !== 'idle') tx.reset();
    setSession({ terms, identity: reviewIdentity(own), settled: false, readAt: Date.now() });
    tx.review();
  };
  const update = (patch: Partial<Omit<TermsSession, 'identity'>>) => setSession((s) => (s ? { ...s, ...patch } : s));
  const end = () => {
    if (inFlight) return;
    if (tx.phase.kind !== 'idle') tx.reset();
    setSession(null);
  };

  return { session, tx, start, update, end };
}
