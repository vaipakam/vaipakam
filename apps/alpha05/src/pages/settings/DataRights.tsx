import { useEffect, useState } from 'react';
import { useConfig } from 'wagmi';
import { disconnect, getConnections } from 'wagmi/actions';
import { useCopy } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import {
  browserSources,
  clearCookie,
  deleteDatabase,
  downloadBody,
  eraseAll,
  itemCount,
  parseReport,
  REPORT_KEY,
  takeInventory,
  type EraseReport,
  type Inventory,
} from '../../shared/dataRights/dataRights';
import { formatUtc } from '../../shared/ui/format';
import { Notice } from '../../shared/ui/Notice';

const ADDRESS = /0x[0-9a-fA-F]{40}/g;

function readReport(): EraseReport | null {
  try {
    return parseReport(window.sessionStorage.getItem(REPORT_KEY));
  } catch {
    return null;
  }
}

/**
 * Settings › Your data (ACC-55; RB-DATA-RIGHTS). Needs no wallet and no
 * Terms. States what this browser keeps for the app and how many items an
 * erasure would remove before the reader confirms; the download carries the
 * app's own records and names the wallet addresses in it; erasure ends the
 * wallet connection, sweeps this site's storage, databases and the shared
 * language cookie, then reloads so every preference visibly resets, and the
 * report of what was removed and what could not be survives the reload in
 * this tab.
 */
export function DataRights() {
  const { text, format } = useCopy();
  const config = useConfig();
  const [inv, setInv] = useState<Inventory | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [report] = useState<EraseReport | null>(readReport);

  const refresh = () => {
    void takeInventory().then(setInv);
  };
  useEffect(refresh, []);

  const download = async () => {
    // A fresh read: preferences changed on this page since it opened are in
    // the file, and the stated counts follow.
    const inv = await takeInventory();
    setInv(inv);
    const connected = getConnections(config).flatMap((c) => c.accounts);
    const wallets = [...new Set([...connected, ...inv.app.flatMap((r) => `${r.key} ${r.value}`.match(ADDRESS) ?? [])].map((a) => a.toLowerCase()))];
    const now = new Date();
    const blob = new Blob([downloadBody(inv, now, wallets)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vaipakam-app-data-${now.toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const erase = async () => {
    setErasing(true);
    const src = browserSources();
    const result = await eraseAll({
      ...src,
      disconnect: async () => {
        const before = getConnections(config);
        if (before.length === 0) return null;
        for (const c of before) {
          try {
            await disconnect(config, { connector: c.connector });
          } catch {
            // Reported below: a connection still listed is one that did not end.
          }
        }
        return getConnections(config).length === 0;
      },
      deleteDatabase,
      clearCookie: (name) => clearCookie(name),
    });
    try {
      window.sessionStorage.setItem(REPORT_KEY, JSON.stringify(result));
    } catch {
      // The report is then shown for this moment only; the reload drops it.
    }
    window.location.reload();
  };

  const count = inv ? itemCount(inv) : null;
  return (
    <section className="home-section" aria-labelledby="settings-data" data-testid="settings-data">
      <h2 id="settings-data">{text('settings.dataTitle')}</h2>
      {report && <EraseOutcome report={report} />}
      {inv === null && <p className="tier-b">{text('settings.dataReading')}</p>}
      {inv && (
        <>
          <p className="tier-b" data-testid="settings-data-count" data-count={count}>
            {format('settings.dataHeld', { app: String(inv.app.length), connector: String(inv.connector), session: String(inv.session) })}{' '}
            {inv.databases === 'unknown' ? text('settings.dataDatabasesUnknown') : format('settings.dataDatabases', { count: String(inv.databases.length) })}{' '}
            {text(inv.langCookie ? 'settings.dataCookieSet' : 'settings.dataCookieUnset')}
          </p>
          {inv.unreadable.length > 0 && <p className="tier-a">{text('settings.dataUnreadable')}</p>}
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => void download()} data-testid="settings-data-download">
              {text('settings.dataDownload')}
            </button>
            {!confirming && (
              <button type="button" className="btn" onClick={() => (refresh(), setConfirming(true))} data-testid="settings-data-erase">
                {text('settings.dataErase')}
              </button>
            )}
          </div>
          <p className="tier-b">{text('settings.dataDownloadSays')}</p>
          {confirming && (
            <div className="card" data-testid="settings-data-confirm">
              <p className="tier-a">{format('settings.dataEraseWill', { count: String(count ?? 0) })}</p>
              <ul className="tier-b">
                <li>{text('settings.dataEraseSignOut')}</li>
                <li>{text('settings.dataEraseReset')}</li>
                <li>{text('settings.dataEraseChain')}</li>
                <li>{text('settings.dataEraseService')}</li>
                <li>{text('settings.dataEraseElsewhere')}</li>
              </ul>
              <div className="form-actions">
                <button type="button" className="btn btn-primary" disabled={erasing} onClick={() => void erase()} data-testid="settings-data-erase-confirm">
                  {text(erasing ? 'settings.dataErasing' : 'settings.dataEraseConfirm')}
                </button>
                <button type="button" className="btn" disabled={erasing} onClick={() => setConfirming(false)}>
                  {text('settings.dataEraseCancel')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      <WhyLink summaryKey="settings.dataWhySummary" detailKey="settings.dataWhy" />
    </section>
  );
}

function EraseOutcome({ report }: { report: EraseReport }) {
  const { text, format } = useCopy();
  const r = report.removed;
  return (
    <Notice tone={report.refused.length > 0 || report.disconnected === false ? 'warn' : 'ok'} tier="A">
      <span data-testid="settings-data-report">
        {format('settings.dataErased', {
          time: formatUtc(Math.floor(report.at / 1000)),
          app: String(r.app),
          connector: String(r.connector),
          session: String(r.session),
          databases: String(r.databases),
        })}{' '}
        {r.langCookie && `${text('settings.dataErasedCookie')} `}
        {report.disconnected === true && `${text('settings.dataErasedSignedOut')} `}
        {report.disconnected === false && `${text('settings.dataErasedStillConnected')} `}
        {report.databasesUnknown && `${text('settings.dataErasedDatabasesUnknown')} `}
        {report.refused.map((f, i) => (
          <span key={i} className="data-refused">
            {format('settings.dataRefused', { what: text(`settings.dataWhat_${f.what}` as const), name: f.name ?? '', reason: f.reason })}{' '}
          </span>
        ))}
      </span>
    </Notice>
  );
}
