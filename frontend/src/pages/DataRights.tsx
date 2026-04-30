import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileDown, ShieldAlert, AlertTriangle, CheckCircle } from 'lucide-react';
import { downloadMyData, deleteMyData } from '../lib/gdpr';

/**
 * Data rights (GDPR / UK GDPR / CCPA) page.
 *
 * Two actions:
 *   1. **Download my data** — exports every client-side key under
 *      Vaipakam's storage namespace (journey log, consent choice,
 *      cached event index) as a portable JSON file. Right-to-access
 *      / right-to-data-portability deliverable. Safe; non-destructive.
 *   2. **Delete my data** — clears every client-side key under
 *      Vaipakam's namespace. Wipes journey log, consent banner
 *      choice (so the cookie banner returns on next page load),
 *      cached event indexes, and any other Vaipakam-namespaced
 *      storage. Right-to-erasure deliverable. **Destructive on the
 *      client side**, but on-chain positions are unaffected — the
 *      protocol has no power to erase blockchain state.
 *
 * The page intentionally over-explains what gets cleared. The same
 * controls live in a tighter form in the Diagnostics drawer (scoped
 * to the journey-log buffer for support workflows); the broader
 * GDPR-scoped pair lives here so the consequences ("you'll see the
 * cookie banner again, your local activity history will reset") are
 * visible *before* the user clicks anything.
 */
export default function DataRights() {
  const { t } = useTranslation();
  const [downloaded, setDownloaded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const onDownload = () => {
    downloadMyData();
    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 2500);
  };

  const onDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    deleteMyData();
    // Reload so every hook / banner rehydrates from the now-empty
    // storage. The user will see the cookie banner re-appear and the
    // dashboard re-scan from a cold cache.
    window.location.reload();
  };

  return (
    <div className="data-rights" style={{ maxWidth: 760, margin: '0 auto' }}>
      <div className="page-header">
        <h1 className="page-title">{t('dataRights.title')}</h1>
        <p className="page-subtitle">{t('dataRights.subtitle')}</p>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div
          className="card-title"
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <FileDown size={16} />
          {t('dataRights.downloadTitle')}
        </div>
        <p>{t('dataRights.downloadBody')}</p>
        <ul style={{ margin: '8px 0 0 0', paddingLeft: 20 }}>
          <li>{t('dataRights.downloadBullet1')}</li>
          <li>{t('dataRights.downloadBullet2')}</li>
          <li>{t('dataRights.downloadBullet3')}</li>
        </ul>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onDownload}
          style={{ marginTop: 12 }}
        >
          {downloaded ? <CheckCircle size={14} /> : <FileDown size={14} />}
          {downloaded ? t('dataRights.downloadDone') : t('dataRights.downloadCta')}
        </button>
      </div>

      <div
        className="card"
        style={{
          marginTop: 16,
          borderLeft: '4px solid var(--accent-red, #ef4444)',
        }}
      >
        <div
          className="card-title"
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <ShieldAlert size={16} />
          {t('dataRights.deleteTitle')}
        </div>
        <p>{t('dataRights.deleteBody')}</p>

        {/* Itemised list of what actually gets wiped, so the user
            sees the consequences before clicking. The bullets cover
            every effect they'll notice on the next page load. */}
        <div
          style={{
            marginTop: 8,
            padding: '10px 12px',
            background: 'var(--bg-card-hover)',
            borderRadius: 8,
            fontSize: '0.88rem',
          }}
        >
          <strong>{t('dataRights.deleteWhatHappensTitle')}</strong>
          <ul style={{ margin: '6px 0 0 0', paddingLeft: 20 }}>
            <li>{t('dataRights.deleteEffect1')}</li>
            <li>{t('dataRights.deleteEffect2')}</li>
            <li>{t('dataRights.deleteEffect3')}</li>
            <li>{t('dataRights.deleteEffect4')}</li>
          </ul>
        </div>

        <p
          style={{
            marginTop: 10,
            fontSize: '0.85rem',
            opacity: 0.85,
          }}
        >
          <AlertTriangle
            size={12}
            style={{ verticalAlign: 'middle', marginRight: 4 }}
          />
          {t('dataRights.deleteOnChainNote')}
        </p>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onDelete}
          style={{
            marginTop: 12,
            color: confirmDelete
              ? 'var(--accent-red, #ef4444)'
              : 'var(--text-primary)',
            borderColor: confirmDelete
              ? 'var(--accent-red, #ef4444)'
              : undefined,
          }}
        >
          <ShieldAlert size={14} />
          {confirmDelete
            ? t('dataRights.deleteConfirmCta')
            : t('dataRights.deleteCta')}
        </button>
        {confirmDelete && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setConfirmDelete(false)}
            style={{ marginTop: 12, marginLeft: 8 }}
          >
            {t('common.cancel')}
          </button>
        )}
      </div>

      <p
        style={{
          marginTop: 16,
          fontSize: '0.78rem',
          opacity: 0.65,
        }}
      >
        {t('dataRights.legalFooter')}
      </p>
    </div>
  );
}
