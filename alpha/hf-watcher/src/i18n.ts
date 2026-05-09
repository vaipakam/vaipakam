/**
 * Worker-side i18n catalogue for user-visible Telegram and Push
 * notification copy. The frontend's react-i18next setup is rich and
 * runs in the browser; the watcher needs the same _strings_ but in a
 * tiny inline form because the worker has no i18next runtime and a
 * cold-start budget worth keeping low.
 *
 * Keep this catalogue narrow — only strings the watcher emits to
 * users. UI surfaces in the frontend stay sourced from the locale
 * JSON files. When a string is added here, also add the matching
 * frontend i18n key (or vice versa) so the two stay aligned for any
 * future cross-referencing.
 *
 * Lookup falls back to English when the user's stored locale isn't in
 * SUPPORTED_LOCALES — never throws, never blocks an alert.
 */

export const SUPPORTED_LOCALES = [
  'en', 'es', 'fr', 'de', 'ja', 'zh', 'ko', 'hi', 'ta', 'ar',
] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

function resolveLocale(s: string | null | undefined): Locale {
  if (!s) return 'en';
  return (SUPPORTED_LOCALES as readonly string[]).includes(s)
    ? (s as Locale)
    : 'en';
}

/** All translatable strings the watcher emits, keyed by an internal
 *  short name. Kept in one object per locale so the table is easy to
 *  audit at a glance. */
type Catalogue = {
  /** Short tag rendered before the message body. */
  bandTagWarn: string;
  bandTagAlert: string;
  bandTagCritical: string;
  /** Body template — one sentence; %s placeholders are filled in below
   *  by `formatAlertBody` since templated string interpolation in TS
   *  worker without i18next is fine to handcode. */
  alertBody: (chain: string, loanId: number, hf: string, link: string) => string;
  /** Push notification titles (short — Telegram doesn't use them, but
   *  Push surfaces title + body separately). */
  pushTitleCritical: string;
  pushTitleNormal: string;
  /** Telegram handshake responses. */
  handshakeExpired: string;
  handshakeLinked: (walletShort: string, chainId: number) => string;
};

const CAT: Record<Locale, Catalogue> = {
  en: {
    bandTagWarn: 'Heads up',
    bandTagAlert: '⚠ ALERT',
    bandTagCritical: '🚨 CRITICAL',
    alertBody: (chain, loanId, hf, link) =>
      `Vaipakam loan on ${chain} (loan #${loanId}) has HF ${hf}. Liquidation triggers at HF < 1.00. Review the position: ${link}`,
    pushTitleCritical: 'Vaipakam liquidation imminent',
    pushTitleNormal: 'Vaipakam HF alert',
    handshakeExpired:
      'That code is expired or unrecognised. Head back to Vaipakam → Alerts and request a new one.',
    handshakeLinked: (walletShort, chainId) =>
      `Linked — HF alerts will arrive for wallet ${walletShort} on chain ${chainId}.`,
  },
  es: {
    bandTagWarn: 'Aviso',
    bandTagAlert: '⚠ ALERTA',
    bandTagCritical: '🚨 CRÍTICO',
    alertBody: (chain, loanId, hf, link) =>
      `El préstamo Vaipakam en ${chain} (préstamo #${loanId}) tiene HF ${hf}. La liquidación se activa con HF < 1.00. Revisa la posición: ${link}`,
    pushTitleCritical: 'Liquidación de Vaipakam inminente',
    pushTitleNormal: 'Alerta HF de Vaipakam',
    handshakeExpired:
      'Ese código ha caducado o no se reconoce. Vuelve a Vaipakam → Alertas y solicita uno nuevo.',
    handshakeLinked: (walletShort, chainId) =>
      `Vinculado — recibirás alertas HF para la billetera ${walletShort} en la cadena ${chainId}.`,
  },
  fr: {
    bandTagWarn: 'À noter',
    bandTagAlert: '⚠ ALERTE',
    bandTagCritical: '🚨 CRITIQUE',
    alertBody: (chain, loanId, hf, link) =>
      `Le prêt Vaipakam sur ${chain} (prêt #${loanId}) a un HF de ${hf}. La liquidation se déclenche à HF < 1,00. Consultez la position : ${link}`,
    pushTitleCritical: 'Liquidation Vaipakam imminente',
    pushTitleNormal: 'Alerte HF Vaipakam',
    handshakeExpired:
      "Ce code est expiré ou non reconnu. Retournez sur Vaipakam → Alertes et demandez-en un nouveau.",
    handshakeLinked: (walletShort, chainId) =>
      `Lié — les alertes HF arriveront pour le portefeuille ${walletShort} sur la chaîne ${chainId}.`,
  },
  de: {
    bandTagWarn: 'Hinweis',
    bandTagAlert: '⚠ WARNUNG',
    bandTagCritical: '🚨 KRITISCH',
    alertBody: (chain, loanId, hf, link) =>
      `Vaipakam-Kredit auf ${chain} (Kredit #${loanId}) hat HF ${hf}. Liquidation wird ausgelöst bei HF < 1,00. Position prüfen: ${link}`,
    pushTitleCritical: 'Vaipakam-Liquidation steht unmittelbar bevor',
    pushTitleNormal: 'Vaipakam HF-Warnung',
    handshakeExpired:
      'Dieser Code ist abgelaufen oder unbekannt. Zurück zu Vaipakam → Alerts und einen neuen anfordern.',
    handshakeLinked: (walletShort, chainId) =>
      `Verknüpft — HF-Warnungen werden an Wallet ${walletShort} auf Chain ${chainId} gesendet.`,
  },
  ja: {
    bandTagWarn: 'お知らせ',
    bandTagAlert: '⚠ アラート',
    bandTagCritical: '🚨 緊急',
    alertBody: (chain, loanId, hf, link) =>
      `${chain} のVaipakamローン (ローン #${loanId}) のHFは ${hf} です。HF < 1.00 で清算が発動します。ポジションを確認: ${link}`,
    pushTitleCritical: 'Vaipakam の清算が間近です',
    pushTitleNormal: 'Vaipakam HFアラート',
    handshakeExpired:
      'そのコードは期限切れか認識できません。Vaipakam → アラートに戻り、新しいコードをリクエストしてください。',
    handshakeLinked: (walletShort, chainId) =>
      `リンク完了 — ウォレット ${walletShort}(チェーン ${chainId})宛にHFアラートを送信します。`,
  },
  zh: {
    bandTagWarn: '提示',
    bandTagAlert: '⚠ 警报',
    bandTagCritical: '🚨 紧急',
    alertBody: (chain, loanId, hf, link) =>
      `${chain} 上的 Vaipakam 贷款 (贷款 #${loanId}) 的 HF 为 ${hf}。HF < 1.00 时触发清算。查看持仓:${link}`,
    pushTitleCritical: 'Vaipakam 清算迫在眉睫',
    pushTitleNormal: 'Vaipakam HF 警报',
    handshakeExpired:
      '该验证码已过期或无法识别。请返回 Vaipakam → 警报页面重新申请。',
    handshakeLinked: (walletShort, chainId) =>
      `已关联 — 钱包 ${walletShort}(链 ${chainId})将收到 HF 警报。`,
  },
  ko: {
    bandTagWarn: '안내',
    bandTagAlert: '⚠ 경보',
    bandTagCritical: '🚨 긴급',
    alertBody: (chain, loanId, hf, link) =>
      `${chain} 의 Vaipakam 대출 (대출 #${loanId}) HF가 ${hf} 입니다. HF < 1.00 에서 청산이 발동됩니다. 포지션 확인: ${link}`,
    pushTitleCritical: 'Vaipakam 청산 임박',
    pushTitleNormal: 'Vaipakam HF 경보',
    handshakeExpired:
      '해당 코드는 만료되었거나 알 수 없는 코드입니다. Vaipakam → 알림 페이지로 돌아가 새 코드를 요청하세요.',
    handshakeLinked: (walletShort, chainId) =>
      `연결됨 — 지갑 ${walletShort}(체인 ${chainId})에 HF 알림이 발송됩니다.`,
  },
  hi: {
    bandTagWarn: 'सूचना',
    bandTagAlert: '⚠ अलर्ट',
    bandTagCritical: '🚨 गंभीर',
    alertBody: (chain, loanId, hf, link) =>
      `${chain} पर Vaipakam लोन (लोन #${loanId}) का HF ${hf} है। HF < 1.00 पर लिक्विडेशन ट्रिगर होता है। पोजीशन देखें: ${link}`,
    pushTitleCritical: 'Vaipakam लिक्विडेशन निकट है',
    pushTitleNormal: 'Vaipakam HF अलर्ट',
    handshakeExpired:
      'वह कोड समाप्त हो गया है या पहचाना नहीं गया। Vaipakam → अलर्ट पर वापस जाकर नया कोड अनुरोध करें।',
    handshakeLinked: (walletShort, chainId) =>
      `लिंक हो गया — वॉलेट ${walletShort} (चेन ${chainId}) पर HF अलर्ट प्राप्त होंगे।`,
  },
  ta: {
    bandTagWarn: 'அறிவிப்பு',
    bandTagAlert: '⚠ எச்சரிக்கை',
    bandTagCritical: '🚨 அவசரம்',
    alertBody: (chain, loanId, hf, link) =>
      `${chain} இல் உள்ள Vaipakam கடன் (கடன் #${loanId}) க்கு HF ${hf}. HF < 1.00 இல் நிலுவைத் தீர்ப்பு (liquidation) தொடங்கும். பொசிஷனைப் பார்க்க: ${link}`,
    pushTitleCritical: 'Vaipakam நிலுவைத் தீர்ப்பு நெருங்குகிறது',
    pushTitleNormal: 'Vaipakam HF எச்சரிக்கை',
    handshakeExpired:
      'அந்த குறியீடு காலாவதியானது அல்லது அறியப்படாதது. Vaipakam → Alerts க்குத் திரும்பி புதிய ஒன்றை கோருங்கள்.',
    handshakeLinked: (walletShort, chainId) =>
      `இணைக்கப்பட்டது — வாலெட் ${walletShort} (சங்கிலி ${chainId}) க்கு HF எச்சரிக்கைகள் வரும்.`,
  },
  ar: {
    bandTagWarn: 'تنبيه',
    bandTagAlert: '⚠ إنذار',
    bandTagCritical: '🚨 حرج',
    alertBody: (chain, loanId, hf, link) =>
      `قرض Vaipakam على ${chain} (قرض رقم ${loanId}) لديه HF ${hf}. تُفعَّل التصفية عند HF < 1.00. راجع المركز: ${link}`,
    pushTitleCritical: 'تصفية Vaipakam وشيكة',
    pushTitleNormal: 'تنبيه HF من Vaipakam',
    handshakeExpired:
      'انتهت صلاحية هذا الرمز أو لم يتم التعرف عليه. عُد إلى Vaipakam ← التنبيهات واطلب رمزًا جديدًا.',
    handshakeLinked: (walletShort, chainId) =>
      `تم الربط — ستصل تنبيهات HF إلى المحفظة ${walletShort} على السلسلة ${chainId}.`,
  },
};

/** Format the full Telegram message body (also used as Push body). */
export function formatAlert(
  band: 'warn' | 'alert' | 'critical',
  locale: string | null | undefined,
  opts: {
    chainName: string;
    loanId: number;
    hf: number;
    frontendOrigin: string;
  },
): string {
  const c = CAT[resolveLocale(locale)];
  const tag =
    band === 'critical'
      ? c.bandTagCritical
      : band === 'alert'
        ? c.bandTagAlert
        : c.bandTagWarn;
  const link = `${opts.frontendOrigin}/app/loans/${opts.loanId}`;
  return `${tag}: ${c.alertBody(opts.chainName, opts.loanId, opts.hf.toFixed(3), link)}`;
}

export function pushTitle(
  band: 'warn' | 'alert' | 'critical',
  locale: string | null | undefined,
): string {
  const c = CAT[resolveLocale(locale)];
  return band === 'critical' ? c.pushTitleCritical : c.pushTitleNormal;
}

export function handshakeExpired(locale: string | null | undefined): string {
  return CAT[resolveLocale(locale)].handshakeExpired;
}

export function handshakeLinked(
  locale: string | null | undefined,
  walletShort: string,
  chainId: number,
): string {
  return CAT[resolveLocale(locale)].handshakeLinked(walletShort, chainId);
}
