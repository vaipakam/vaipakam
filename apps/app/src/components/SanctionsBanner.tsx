/**
 * Sanctions-screening banner — renders ONLY when the connected wallet
 * is flagged by the configured on-chain oracle (fail-open otherwise).
 * Per the retail-deploy policy this is the one place the full
 * three-line message appears; marketing surfaces never mention it.
 *
 * #2439 — the third line names the recourse, and that depends on WHICH list
 * flagged the wallet: on a test network the oracle may be a test list that
 * extends Chainalysis's, and a wallet only the test list flagged must not be
 * sent to Chainalysis. The line is withheld until attribution settles rather
 * than shown with a guess.
 */
import { OctagonAlert } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { copy } from '../content/copy';
import { useSanctionsCheck } from '../data/sanctions';
import { readSanctionsSource, type SanctionsSource } from '../data/sanctionsSource';
import { useActiveChain } from '../chain/useActiveChain';

function useSanctionsSource(flagged: boolean): SanctionsSource | undefined {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const { data } = useQuery({
    queryKey: ['sanctionsSource', readChain.chainId, address?.toLowerCase()],
    enabled: flagged && Boolean(address) && Boolean(publicClient),
    staleTime: 5 * 60_000,
    queryFn: () => readSanctionsSource(publicClient!, readChain.diamondAddress, address!),
  });
  return data;
}

/** The recourse line for a settled attribution. */
export function recourseLine(source: SanctionsSource): string {
  switch (source) {
    case 'provider':
      return copy.sanctions.line3;
    case 'testList':
      return copy.sanctions.line3TestList;
    case 'both':
      return copy.sanctions.line3Both;
    case 'testListProviderUnread':
      return copy.sanctions.line3TestListProviderUnread;
    case 'unknown':
      return copy.sanctions.line3Unknown;
  }
}

export function SanctionsBanner() {
  const { flagged } = useSanctionsCheck();
  const source = useSanctionsSource(flagged);
  if (!flagged) return null;
  return (
    <div className="banner banner-danger" role="alert">
      <OctagonAlert aria-hidden />
      <div className="banner-body">
        <div className="banner-title">{copy.sanctions.title}</div>
        <p style={{ margin: '6px 0 0' }}>{copy.sanctions.line1}</p>
        <p style={{ margin: '6px 0 0' }}>{copy.sanctions.line2}</p>
        {source !== undefined && (
          <p style={{ margin: '6px 0 0' }}>{recourseLine(source)}</p>
        )}
      </div>
    </div>
  );
}
