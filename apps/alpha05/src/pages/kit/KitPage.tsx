import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { getSupportedChain } from '../../chain/chains';
import { useCopy } from '../../shared/copy/useCopy';
import { KIT_HANDOFF_KEY, kitRoute, readKitLink, type KitHandoff } from '../../shared/kit/kit';
import { entryLine, kitWhat, kitWho, ruleLine, useIntegratorEntry, useKitMeta } from '../../shared/kit/kitStatements';
import { assetName } from '../../shared/reads/tokens';
import { useStoredValue } from '../../shared/tx/txStore';
import { Notice } from '../../shared/ui/Notice';

type Hex = `0x${string}`;

const CONTINUE_KEY = { borrow: 'kit.continueBorrow', lend: 'kit.continueLend', rent: 'kit.continueRent' } as const;

/**
 * #3773 — the embedded lending kit's landing page. A link another app built
 * with `@vaipakam/lend-kit` opens it with what that app asked for (borrow
 * against an asset, lend an amount, rent a token) and, optionally, its
 * integrator id. The page reads the link with the kit's own parser and
 * states what it asks for, the network it is for, and the integrator with
 * the registry's answer for it, read from the chain. Nothing is signed
 * here: the user continues to the platform's own page, filled in, and meets
 * its review. The integrator travels as a choice the user can drop first.
 */
export function KitPage() {
  const { text, format } = useCopy();
  const location = useLocation();
  const navigate = useNavigate();
  const { status, chainId } = useAccount();
  const read = readKitLink(new URLSearchParams(location.search));
  const request = read.ok ? read.request : null;
  const linkChain = request ? getSupportedChain(request.chainId) : null;
  const meta = useKitMeta(linkChain, request);
  const integrator: Hex | null = request?.integrator ?? null;
  const [keep, setKeep] = useState(true);
  const entry = useIntegratorEntry(integrator !== null ? linkChain : null, integrator);
  const [, setHandoff] = useStoredValue<KitHandoff>(KIT_HANDOFF_KEY);

  if (!read.ok) {
    return (
      <main className="page kit" data-testid="kit-page" data-state="refused">
        <h1>{text('kit.pageTitle')}</h1>
        <Notice tone="warn" tier="A">
          {format('kit.refused', { reason: read.reason })}
        </Notice>
        <Link to="/">{text('kit.home')}</Link>
      </main>
    );
  }
  const r = read.request;
  if (linkChain === null) {
    return (
      <main className="page kit" data-testid="kit-page" data-state="unserved">
        <h1>{text('kit.pageTitle')}</h1>
        <Notice tone="warn" tier="A">
          {format('kit.unservedChain', { chain: String(r.chainId) })}
        </Notice>
        <Link to="/">{text('kit.home')}</Link>
      </main>
    );
  }
  const connected = status === 'connected';
  const otherNetwork = connected && chainId !== r.chainId;
  const entryText = integrator !== null ? entryLine(entry, format) : null;
  const go = () => {
    setHandoff({ request: r, integrator: keep ? integrator : null });
    navigate(kitRoute(r));
  };
  return (
    <main className="page kit" data-testid="kit-page" data-state="ready" data-action={r.action}>
      <h1>{text('kit.pageTitle')}</h1>
      <p className="tier-a" data-testid="kit-what">
        {format('kit.pageLead', { what: kitWhat(r, meta.data, format), chain: linkChain.name })}
      </p>
      {r.action === 'borrow' && r.lendingAsset !== undefined && <p className="tier-a">{format('kit.suggestsLending', { asset: assetName(r.lendingAsset, meta.data) })}</p>}
      {r.action === 'lend' && <p className="tier-a">{text('kit.amountNotFilled')}</p>}
      <p className="tier-a">{text('kit.nothingSigned')}</p>
      {otherNetwork && (
        <div data-testid="kit-other-network">
          <Notice tone="warn" tier="A">
            {format('kit.wrongNetwork', { chain: linkChain.name })}
          </Notice>
        </div>
      )}
      {integrator !== null && (
        <section aria-labelledby="kit-integrator-title" data-testid="kit-page-integrator" data-integrator={integrator}>
          <h2 id="kit-integrator-title">{text('kit.integratorTitle')}</h2>
          <p className="tier-a">{format('kit.integratorNamed', { who: kitWho(integrator, entry.data, format) })}</p>
          {entryText !== null ? <p className="tier-a">{entryText}</p> : <p className="tier-b">{text('kit.reading')}</p>}
          <p className="tier-a">{ruleLine(r, format)}</p>
          <label className="choice">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} data-testid="kit-keep" />
            <span>{text('kit.keepLabel')}</span>
          </label>
        </section>
      )}
      <button type="button" className="btn btn-primary" onClick={go} data-testid="kit-continue">
        {text(CONTINUE_KEY[r.action])}
      </button>
    </main>
  );
}
