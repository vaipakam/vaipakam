import { useState } from 'react';
import { useCopy } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { promptInstall, useInstall } from '../../shared/install/install';
import { Notice } from '../../shared/ui/Notice';

/**
 * Settings › Install the app (ACC-11, RB-INSTALL). The browser's own install
 * prompt where it offered one; otherwise which case this is (already
 * installed, an iPhone or iPad, or a browser that has not offered it), never
 * a button that does nothing. Says what the app keeps on the device (this
 * version's files) and what it never serves from there (pages and every
 * figure). Advanced, per the matrix.
 */
export function InstallApp() {
  const { text, format } = useCopy();
  const install = useInstall();
  const [outcome, setOutcome] = useState<'accepted' | 'dismissed' | null>(null);
  const worker = install.worker;

  return (
    <section className="home-section" aria-labelledby="settings-install" data-testid="settings-install">
      <h2 id="settings-install">{text('install.title')}</h2>
      <div data-testid="settings-install-state" data-installed={install.installed || outcome === 'accepted' ? 'yes' : 'no'} data-prompt={install.canPrompt ? 'yes' : 'no'}>
        {install.installed && outcome === null && <p className="tier-a">{text('install.installed')}</p>}
        {outcome === 'accepted' && <p className="tier-a">{text('install.installedNow')}</p>}
        {!install.installed && outcome !== 'accepted' && (
          <>
            <p className="tier-b">{text('install.lead')}</p>
            {install.canPrompt && (
              <p className="actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="settings-install-button"
                  onClick={() => void promptInstall().then((o) => setOutcome(o === 'unavailable' ? null : o))}
                >
                  {text('install.button')}
                </button>
              </p>
            )}
            {outcome === 'dismissed' && <p className="tier-b">{text('install.dismissed')}</p>}
            {!install.canPrompt && outcome === null && <p className="tier-a">{text(install.ios ? 'install.ios' : 'install.notOffered')}</p>}
          </>
        )}
      </div>
      <p className="tier-a">{text('install.files')}</p>
      <p className="tier-a">{text('install.fresh')}</p>
      {worker.kind === 'failed' && (
        <Notice tone="warn" tier="B">
          {format('install.workerFailed', { reason: worker.reason })}
        </Notice>
      )}
      {worker.kind === 'unsupported' && <p className="tier-b">{text('install.workerUnsupported')}</p>}
      <WhyLink summaryKey="install.whySummary" detailKey="install.why" />
    </section>
  );
}
