/**
 * Help — short plain-language answers to the questions naive users
 * actually ask, plus the risk-disclosures section the consent
 * checkbox links to (#1030) and build info for testers. Deep-dive
 * docs stay on the marketing site; this page is deliberately small.
 */
import { useEffect } from 'react';
import { copy } from '../content/copy';
import { useProtocolFees, bpsToPercentText } from '../data/fees';

const FAQ: Array<{ q: string; a: string }> = [
  {
    q: 'Where are my assets held?',
    a: 'In your own Vaipakam Vault — an on-chain account that only your wallet controls. Vaipakam never pools user funds and cannot spend them for you.',
  },
  {
    q: 'What happens if I don’t repay a loan?',
    a: 'After the due date plus a grace period, the lender can receive your locked collateral. If the collateral has a live market price, it can also be sold automatically when its value falls too far — repaying on time avoids both.',
  },
  {
    q: 'Is the interest I see guaranteed when I lend?',
    a: 'No. It is what you earn if the borrower repays on time. If they default, your recovery depends on the collateral they locked — the review screen spells this out before you sign.',
  },
  {
    q: 'What is an NFT rental?',
    a: 'The NFT stays locked in its owner’s vault; the renter gets temporary use rights, never ownership. Rental fees are prepaid, with a small refundable buffer.',
  },
  {
    q: 'Do I need VPFI?',
    a: 'No. VPFI is optional — holding it in your vault can reduce protocol fees on eligible loans. It never reduces network gas, and you never need it to borrow, lend, or rent.',
  },
];

export function Help() {
  const buildHash = import.meta.env.VITE_BUILD_HASH as string | undefined;
  const buildTime = import.meta.env.VITE_BUILD_TIME as string | undefined;
  const fees = useProtocolFees();

  // The consent checkbox links here as /help#risks — the router
  // doesn't scroll to hashes on its own.
  useEffect(() => {
    if (window.location.hash) {
      document.querySelector(window.location.hash)?.scrollIntoView();
    }
  }, []);

  // Fee numbers come from the live protocol config — governance can
  // retune them and this answer must track the deployed values.
  const feeFaq = {
    q: 'What fees does Vaipakam charge?',
    a: `${copy.fees.borrowerLIF(bpsToPercentText(fees.loanInitiationFeeBps))} ${copy.fees.lenderYieldFee(bpsToPercentText(fees.treasuryFeeBps))} ${copy.fees.lateFee} Network gas is separate and goes to the blockchain, not to Vaipakam.`,
  };
  const faq = [...FAQ, feeFaq];

  return (
    <div>
      <h1 className="page-title">Help</h1>
      {/* The exact platform disclaimer the spec mandates (§29) —
          wording is load-bearing, don't paraphrase. */}
      <p className="page-lede">
        Quick answers in plain language. {copy.help.disclaimer}
      </p>

      <div className="stack">
        {/* The consent checkbox's "Risk Disclosures" link lands here. */}
        <section id="risks" className="card">
          <h3>{copy.help.risksTitle}</h3>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {copy.help.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
        {faq.map((item) => (
          <section key={item.q} className="card">
            <h3>{item.q}</h3>
            <p style={{ margin: 0 }}>{item.a}</p>
          </section>
        ))}
      </div>

      <p className="muted" style={{ marginTop: 24 }}>
        Build {buildHash ?? 'dev'}
        {buildTime ? ` · ${buildTime}` : ''}
      </p>
    </div>
  );
}
