import { useAccount } from 'wagmi';
import { getSupportedChain } from '../../chain/chains';
import { useOwnStateClient } from '../../chain/ownRail';
import { RewardsWidget } from '../../shared/claims/RewardsWidget';
import { FeeDiscountConsent } from '../../shared/consent/FeeDiscountConsent';
import { useCopy } from '../../shared/copy/useCopy';
import { TierElsewhere } from '../../shared/rewards/TierElsewhere';
import { TierSection } from '../../shared/rewards/TierSection';
import { VpfiVault } from '../../shared/rewards/VpfiVault';
import { FrozenNotice, useFrozenState } from '../../shared/sanctions/FrozenNotice';

/**
 * Rewards (RW-01..RW-07, RW-24..RW-27, RW-33, RW-36): one page for the
 * wallet's rewards and its VPFI on the wallet's network (RB-PRECEDENCE: the
 * current app splits the VPFI vault from the vault page). First the
 * interaction rewards: what a claim made now pays, the claim, the soonest
 * removal and any held balance (the shared widget Home and Claims show).
 * Then the VPFI in the wallet's own vault, with its deposit and withdrawal,
 * the fee-discount tier the protocol applies now with the table of tiers
 * (RW-08..RW-10), the tier the other networks hold and sending it to them
 * (RW-11, RW-13, RW-14), and the fee-discount consent that decides whether that
 * VPFI changes any fee. Rewards are usage rebates, never yield (RL-6).
 */
export function RewardsPage() {
  const { text } = useCopy();
  const { status, chainId } = useAccount();
  const own = useOwnStateClient();
  const chain = getSupportedChain(own?.chainId ?? chainId);
  const connected = status === 'connected';
  const served = connected && chain !== null && own !== null ? { chain, own } : null;
  const frozen = useFrozenState(chain?.diamondAddress ?? '0x', served ? served.own.account : null);

  return (
    <main className="page rewards" aria-labelledby="rewards-page-title">
      <h1 id="rewards-page-title">{text('rewardsPage.title')}</h1>
      <p className="tier-b">{text('rewardsPage.lead')}</p>
      {!connected && (
        <p className="tier-b" data-testid="rewards-connect">
          {text('rewardsPage.connect')}
        </p>
      )}
      {connected && chain === null && <p className="tier-b">{text('rewardsPage.unsupported')}</p>}
      {served && (
        <>
          <FrozenNotice state={frozen} />
          <RewardsWidget onRewards />
          <VpfiVault chain={served.chain} own={served.own} />
          <TierSection chain={served.chain} own={served.own} />
          <TierElsewhere chain={served.chain} own={served.own} />
          <FeeDiscountConsent />
        </>
      )}
    </main>
  );
}
