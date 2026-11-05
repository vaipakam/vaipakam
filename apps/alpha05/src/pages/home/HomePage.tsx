import { useAccount } from 'wagmi';
import { getSupportedChain } from '../../chain/chains';
import { useCopy } from '../../shared/copy/useCopy';
import { FeeDiscountConsent } from '../../shared/consent/FeeDiscountConsent';
import { Faucet } from './Faucet';
import { FirstRunCards } from './FirstRunCards';
import { IntentChooser } from './IntentChooser';
import { useStatusStrip } from './StatusStrip';
import { useHomeBook } from './useHomeBook';
import { YourPositions } from './YourPositions';

/**
 * Home (rulebook §4: positions with next action, deadlines, first-run
 * cards). Two writes live here: the fee-discount toggle (RW-07, behind the
 * Terms gate when turned on) and, on a testnet, the faucet (ACC-63); each
 * runs the shared signing flow (receipt, re-check, measured outcome).
 *
 * Order, by what the reader needs first:
 * - an urgent protocol status (paused, keeper service paused, unreadable);
 * - with no wallet, the job chooser (ACC-05) and a connect prompt;
 * - with a wallet on a served network, the first-run cards, then the
 *   wallet's book (payouts ready, live loans, open offers), then on a
 *   testnet the faucet, then the job chooser, then the fee-discount
 *   setting; a wallet with nothing yet sees the faucet and the chooser
 *   right after the "nothing yet" line;
 * - a running protocol as one quiet line at the end.
 */
export function HomePage() {
  const { text } = useCopy();
  const { status, chainId } = useAccount();
  const connected = status === 'connected';
  const served = connected && getSupportedChain(chainId) !== null;
  const strip = useStatusStrip();
  const book = useHomeBook();

  return (
    <main className="page home" aria-labelledby="home-title">
      <h1 id="home-title">{text('home.title')}</h1>
      {strip.urgent && strip.node}
      {!connected && (
        <>
          <IntentChooser />
          <p className="tier-b">{text('home.connectPrompt')}</p>
        </>
      )}
      {connected && !served && (
        <>
          <p className="tier-b">{text('home.unsupportedChain')}</p>
          <IntentChooser />
        </>
      )}
      {served && (
        <>
          <FirstRunCards />
          <YourPositions book={book} />
          <Faucet />
          <IntentChooser />
          <FeeDiscountConsent />
        </>
      )}
      {!strip.urgent && strip.node}
    </main>
  );
}
