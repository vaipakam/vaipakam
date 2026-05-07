import { useTranslation } from 'react-i18next';
import './HowItWorks.css';

interface StepSpec {
  number: string;
  titleKey: string;
  descKey: string;
  detailKeys: string[];
}

const STEPS: StepSpec[] = [
  {
    number: '01',
    titleKey: 'howItWorksSection.step1Title',
    descKey: 'howItWorksSection.step1Desc',
    detailKeys: ['howItWorksSection.step1Detail1', 'howItWorksSection.step1Detail2', 'howItWorksSection.step1Detail3'],
  },
  {
    number: '02',
    titleKey: 'howItWorksSection.step2Title',
    descKey: 'howItWorksSection.step2Desc',
    detailKeys: ['howItWorksSection.step2Detail1', 'howItWorksSection.step2Detail2', 'howItWorksSection.step2Detail3'],
  },
  {
    number: '03',
    titleKey: 'howItWorksSection.step3Title',
    descKey: 'howItWorksSection.step3Desc',
    detailKeys: ['howItWorksSection.step3Detail1', 'howItWorksSection.step3Detail2', 'howItWorksSection.step3Detail3'],
  },
  {
    number: '04',
    titleKey: 'howItWorksSection.step4Title',
    descKey: 'howItWorksSection.step4Desc',
    detailKeys: [
      'howItWorksSection.step4Detail1',
      'howItWorksSection.step4Detail2',
      'howItWorksSection.step4Detail3',
      'howItWorksSection.step4Detail4',
    ],
  },
];

export default function HowItWorks() {
  const { t } = useTranslation();
  return (
    <section className="section how-it-works" id="how-it-works">
      <div className="container">
        <div className="how-header">
          <span className="section-label">{t('howItWorksSection.sectionLabel')}</span>
          <h2 className="section-title">{t('howItWorksSection.title')}</h2>
          <p className="section-subtitle">{t('howItWorksSection.subtitle')}</p>
        </div>

        <div className="steps-grid">
          {STEPS.map((step, i) => (
            <div key={step.number} className="step-card">
              <div className="step-number">{step.number}</div>
              <h3 className="step-title">{t(step.titleKey)}</h3>
              <p className="step-desc">{t(step.descKey)}</p>
              <ul className="step-details">
                {step.detailKeys.map((dk) => (
                  <li key={dk}>{t(dk)}</li>
                ))}
              </ul>
              {i < STEPS.length - 1 && <div className="step-connector" />}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
