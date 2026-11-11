import { useConfig } from 'wagmi';
import { sendWrite } from '../tx/send';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { inFlight, useStoredValue } from '../tx/txStore';
import { useTrackedTx, type TrackedTx } from '../tx/useTrackedTx';
import { reviewIdentity } from '../ui/ActionFlow';
import { LEGAL_ABI, readAcceptance, readTerms, type TermsState } from './terms';

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
 * ACC-15 — the Terms acceptance for one asking action (`key`). Its session
 * and tracker are held in the app's transaction store, not in the prompt or
 * the page: a navigation, disconnect or network switch that unmounts them
 * cannot drop a pending acceptance's hash or offer a second one, and the
 * prompt reopens where it was when its page mounts again. The prompt is
 * only a view of this.
 */
export function useTermsGate(key: string, chain: SupportedChain | null, own: OwnStateClient | null): TermsGate {
  const { text, format } = useCopy();
  const config = useConfig();
  const [session, setSession] = useStoredValue<TermsSession>(`${key}:session`);
  const diamond = (chain?.diamondAddress ?? '0x') as `0x${string}`;
  const account = (own?.account ?? '0x') as `0x${string}`;

  const tx = useTrackedTx({
    key,
    chainId: chain?.chainId ?? 0,
    account,
    sources: own?.sources ?? [],
    send: () => {
      if (!session || !chain) throw new Error('no Terms under review');
      return sendWrite(config, {
        address: diamond,
        abi: LEGAL_ABI,
        functionName: 'acceptTerms',
        args: [session.terms.version, session.terms.hash],
        chainId: chain.chainId,
        account,
      });
    },
    measure: async (_receipt, at) => {
      if (!session) return [];
      const reviewed = session.terms;
      const label = format('terms.legAccepted', { version: String(reviewed.version) });
      // What was sent is measured against the wallet's RECORDED acceptance,
      // not against which version is in force now: a version installed
      // after this one mined does not undo it, and is stated as its own leg.
      const [record, now] = await Promise.all([at.read((c, b) => readAcceptance(c, diamond, account, b)), at.read((c, b) => readTerms(c, diamond, account, b))]);
      if (!record || record.version !== reviewed.version || record.hash !== reviewed.hash) return [{ status: 'not-done', label, reason: text('terms.legMissing') }];
      if (now.kind !== 'needed') return [{ status: 'done', label }];
      return [
        { status: 'done', label },
        { status: 'not-done', label: format('terms.legAccepted', { version: String(now.version) }), reason: format('terms.legNewer', { version: String(now.version) }) },
      ];
    },
  });

  const out = inFlight(tx.phase);
  const start = (terms: NeededTerms) => {
    if (!own || out) return;
    if (tx.phase.kind !== 'idle') tx.reset();
    setSession({ terms, identity: reviewIdentity(own), settled: false, readAt: Date.now() });
    tx.review();
  };
  const update = (patch: Partial<Omit<TermsSession, 'identity'>>) => setSession((s) => (s ? { ...s, ...patch } : s));
  const end = () => {
    if (out) return;
    if (tx.phase.kind !== 'idle') tx.reset();
    setSession(null);
  };

  return { session, tx, start, update, end };
}
