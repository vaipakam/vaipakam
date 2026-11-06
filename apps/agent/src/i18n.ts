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
  /** UX-012 — the one-off "delivery works" message the Send-a-test-
   *  alert button triggers. */
  testAlert: string;
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
    testAlert:
      '✅ Vaipakam test alert — your Telegram alerts are working. This is the only message you asked for; real alerts arrive only when a loan needs your attention.',
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
    testAlert:
      '✅ Alerta de prueba de Vaipakam — tus alertas de Telegram funcionan. Este es el único mensaje que solicitaste; las alertas reales llegan solo cuando un préstamo necesita tu atención.',
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
    testAlert:
      '✅ Alerte de test Vaipakam — vos alertes Telegram fonctionnent. Ceci est le seul message demandé ; les vraies alertes n’arrivent que lorsqu’un prêt requiert votre attention.',
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
    testAlert:
      '✅ Vaipakam-Testwarnung — deine Telegram-Warnungen funktionieren. Dies ist die einzige angeforderte Nachricht; echte Warnungen kommen nur, wenn ein Kredit deine Aufmerksamkeit braucht.',
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
    testAlert:
      '✅ Vaipakam テストアラート — Telegram アラートは正常に動作しています。これは依頼された唯一のメッセージです。実際のアラートはローンに対応が必要なときだけ届きます。',
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
    testAlert:
      '✅ Vaipakam 测试警报 — 你的 Telegram 警报运行正常。这是你请求的唯一一条消息;只有当贷款需要你关注时才会收到真实警报。',
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
    testAlert:
      '✅ Vaipakam 테스트 알림 — Telegram 알림이 정상 작동합니다. 요청하신 유일한 메시지이며, 실제 알림은 대출에 주의가 필요할 때만 도착합니다.',
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
    testAlert:
      '✅ Vaipakam परीक्षण अलर्ट — आपके Telegram अलर्ट काम कर रहे हैं। यह आपके द्वारा मांगा गया एकमात्र संदेश है; असली अलर्ट तभी आते हैं जब किसी लोन को आपके ध्यान की ज़रूरत हो।',
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
    testAlert:
      '✅ Vaipakam சோதனை எச்சரிக்கை — உங்கள் Telegram எச்சரிக்கைகள் வேலை செய்கின்றன. நீங்கள் கேட்ட ஒரே செய்தி இதுதான்; உண்மையான எச்சரிக்கைகள் ஒரு கடனுக்கு உங்கள் கவனம் தேவைப்படும்போது மட்டுமே வரும்.',
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
    testAlert:
      '✅ تنبيه اختباري من Vaipakam — تنبيهات Telegram تعمل. هذه هي الرسالة الوحيدة التي طلبتها؛ التنبيهات الحقيقية تصل فقط عندما يحتاج قرض إلى انتباهك.',
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
  const link = `${opts.frontendOrigin}/loans/${opts.loanId}`;
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

/** UX-012 — the one-off "your alerts are working" test message. */
export function testAlert(locale: string | null | undefined): string {
  return CAT[resolveLocale(locale)].testAlert;
}

// ─── #3088 — the Telegram LOCK command ───────────────────────────────────
//
// The agent only RECORDS a lock request; the keeper makes the call and
// answers with the outcome. So the reply here says that nothing is locked
// yet, never that it is.

type LockCatalogue = {
  /** One linked wallet and chain, as the request names it. */
  lockEntry: (walletShort: string, chainId: number) => string;
  /** The request was recorded for every entry in `list`. */
  lockRecorded: (list: string) => string;
  /** The chat is linked to no wallet. */
  lockNotLinked: string;
  /** LOCK arrived from a group or channel. */
  lockPrivateOnly: string;
  /** The request could not be stored. */
  lockNotRecorded: string;
  /** The LOCK was sent longer ago than the request age limit (or carries no
   *  send time), so it was not recorded. */
  lockStale: string;
  /** No keeper has shown, recently, that it works LOCK requests on the
   *  chains in `list`, so none was recorded for them. */
  lockNotRunning: (list: string) => string;
};

const LOCK_CAT: Record<Locale, LockCatalogue> = {
  en: {
    lockEntry: (w, c) => `wallet ${w} on chain ${c}`,
    lockRecorded: (list) =>
      `LOCK received for ${list}. Nothing is locked yet: the keeper locks each one that has protected mode on and that you have allowed it to lock, usually within two minutes, and tells you the result here.`,
    lockNotLinked:
      'This chat is not linked to any wallet, so there is nothing to lock. Lock the vault from the Vaipakam app instead.',
    lockPrivateOnly: 'LOCK works only in your private chat with this bot. Nothing was locked.',
    lockNotRecorded: 'Your LOCK could not be recorded just now, so nothing will be locked from this message. Send LOCK again, or lock the vault from the Vaipakam app.',
    lockStale: 'This LOCK was sent more than an hour ago and reached the bot only now, so it was not recorded and nothing will be locked from it. Send LOCK again, or lock the vault from the Vaipakam app.',
    lockNotRunning: (list) => `Locking from Telegram is not running right now for ${list}, so nothing was recorded for it and nothing will be locked from this message. Lock the vault from the Vaipakam app.`,
  },
  es: {
    lockEntry: (w, c) => `la billetera ${w} en la cadena ${c}`,
    lockRecorded: (list) =>
      `LOCK recibido para ${list}. Todavía no se ha bloqueado nada: el keeper bloquea cada una que tenga el modo protegido activado y que le hayas permitido bloquear, normalmente en menos de dos minutos, y te informa aquí del resultado.`,
    lockNotLinked:
      'Este chat no está vinculado a ninguna billetera, así que no hay nada que bloquear. Bloquea la bóveda desde la app de Vaipakam.',
    lockPrivateOnly: 'LOCK solo funciona en tu chat privado con este bot. No se ha bloqueado nada.',
    lockNotRecorded: 'No se pudo registrar tu LOCK en este momento, así que este mensaje no bloqueará nada. Envía LOCK de nuevo o bloquea la bóveda desde la app de Vaipakam.',
    lockStale: 'Este LOCK se envió hace más de una hora y ha llegado al bot ahora, así que no se registró y no bloqueará nada. Envía LOCK de nuevo o bloquea la bóveda desde la app de Vaipakam.',
    lockNotRunning: (list) => `El bloqueo desde Telegram no está funcionando ahora para ${list}, así que no se registró nada y este mensaje no bloqueará nada. Bloquea la bóveda desde la app de Vaipakam.`,
  },
  fr: {
    lockEntry: (w, c) => `le portefeuille ${w} sur la chaîne ${c}`,
    lockRecorded: (list) =>
      `LOCK reçu pour ${list}. Rien n'est encore verrouillé : le keeper verrouille chacun de ceux dont le mode protégé est activé et que vous l'avez autorisé à verrouiller, en général en moins de deux minutes, et vous indique le résultat ici.`,
    lockNotLinked:
      "Ce chat n'est lié à aucun portefeuille, il n'y a donc rien à verrouiller. Verrouillez le coffre depuis l'application Vaipakam.",
    lockPrivateOnly: 'LOCK ne fonctionne que dans votre conversation privée avec ce bot. Rien n’a été verrouillé.',
    lockNotRecorded: "Votre LOCK n'a pas pu être enregistré pour l'instant, ce message ne verrouillera donc rien. Envoyez LOCK à nouveau ou verrouillez le coffre depuis l'application Vaipakam.",
    lockStale: 'Ce LOCK a été envoyé il y a plus d\'une heure et n\'a atteint le bot que maintenant : il n\'a pas été enregistré et ne verrouillera rien. Envoyez LOCK à nouveau, ou verrouillez le coffre depuis l\'application Vaipakam.',
    lockNotRunning: (list) => `Le verrouillage depuis Telegram ne fonctionne pas pour l'instant pour ${list} : rien n'a été enregistré et ce message ne verrouillera rien. Verrouillez le coffre depuis l'application Vaipakam.`,
  },
  de: {
    lockEntry: (w, c) => `Wallet ${w} auf Chain ${c}`,
    lockRecorded: (list) =>
      `LOCK empfangen für ${list}. Noch ist nichts gesperrt: Der Keeper sperrt jede davon, bei der der geschützte Modus aktiv ist und der Sie das Sperren erlaubt haben, meist innerhalb von zwei Minuten, und meldet Ihnen das Ergebnis hier.`,
    lockNotLinked:
      'Dieser Chat ist mit keiner Wallet verknüpft, daher gibt es nichts zu sperren. Sperren Sie den Tresor stattdessen in der Vaipakam-App.',
    lockPrivateOnly: 'LOCK funktioniert nur in Ihrem privaten Chat mit diesem Bot. Es wurde nichts gesperrt.',
    lockNotRecorded: 'Ihr LOCK konnte gerade nicht erfasst werden, daher wird durch diese Nachricht nichts gesperrt. Senden Sie LOCK erneut oder sperren Sie den Tresor in der Vaipakam-App.',
    lockStale: 'Dieses LOCK wurde vor mehr als einer Stunde gesendet und hat den Bot erst jetzt erreicht. Es wurde daher nicht erfasst, und es wird dadurch nichts gesperrt. Sende LOCK erneut oder sperre den Tresor in der Vaipakam-App.',
    lockNotRunning: (list) => `Das Sperren über Telegram läuft gerade nicht für ${list}, daher wurde nichts erfasst und durch diese Nachricht wird nichts gesperrt. Sperren Sie den Tresor in der Vaipakam-App.`,
  },
  ja: {
    lockEntry: (w, c) => `チェーン ${c} のウォレット ${w}`,
    lockRecorded: (list) =>
      `${list} の LOCK を受け付けました。まだ何もロックされていません。保護モードが有効で、ロックを許可しているものをキーパーが通常2分以内にロックし、結果をここでお知らせします。`,
    lockNotLinked:
      'このチャットはどのウォレットにも連携されていないため、ロックするものがありません。Vaipakam アプリからボールトをロックしてください。',
    lockPrivateOnly: 'LOCK はこのボットとのプライベートチャットでのみ使えます。何もロックされていません。',
    lockNotRecorded: '今は LOCK を記録できなかったため、このメッセージでは何もロックされません。もう一度 LOCK を送るか、Vaipakam アプリからボールトをロックしてください。',
    lockStale: 'この LOCK は 1 時間以上前に送信され、今になってボットに届いたため、記録されず、何もロックされません。もう一度 LOCK を送信するか、Vaipakam アプリからボールトをロックしてください。',
    lockNotRunning: (list) => `${list} では現在 Telegram からのロックが動作していないため、何も記録されず、このメッセージでは何もロックされません。Vaipakam アプリからボールトをロックしてください。`,
  },
  zh: {
    lockEntry: (w, c) => `链 ${c} 上的钱包 ${w}`,
    lockRecorded: (list) =>
      `已收到 ${list} 的 LOCK 请求。目前尚未锁定任何内容：keeper 会锁定其中已开启保护模式且你已允许其锁定的每一个，通常在两分钟内完成，并在这里告诉你结果。`,
    lockNotLinked: '此聊天未关联任何钱包，因此没有可锁定的内容。请改在 Vaipakam 应用中锁定金库。',
    lockPrivateOnly: 'LOCK 只能在你与此机器人的私聊中使用。未锁定任何内容。',
    lockNotRecorded: '暂时无法记录你的 LOCK 请求，因此这条消息不会锁定任何内容。请再次发送 LOCK，或在 Vaipakam 应用中锁定金库。',
    lockStale: '此 LOCK 发送于一小时以前，现在才送达机器人，因此未被记录，也不会锁定任何内容。请重新发送 LOCK，或在 Vaipakam 应用中锁定金库。',
    lockNotRunning: (list) => `${list} 目前无法通过 Telegram 锁定，因此没有记录任何内容，这条消息也不会锁定任何内容。请在 Vaipakam 应用中锁定金库。`,
  },
  ko: {
    lockEntry: (w, c) => `체인 ${c}의 지갑 ${w}`,
    lockRecorded: (list) =>
      `${list}에 대한 LOCK을 받았습니다. 아직 잠긴 것은 없습니다. 보호 모드가 켜져 있고 잠금을 허용한 항목을 키퍼가 보통 2분 안에 잠그고, 결과를 여기에서 알려 드립니다.`,
    lockNotLinked:
      '이 채팅은 어떤 지갑과도 연결되어 있지 않아 잠글 것이 없습니다. 대신 Vaipakam 앱에서 볼트를 잠그세요.',
    lockPrivateOnly: 'LOCK은 이 봇과의 개인 채팅에서만 작동합니다. 아무것도 잠기지 않았습니다.',
    lockNotRecorded: '지금은 LOCK을 기록할 수 없어 이 메시지로는 아무것도 잠기지 않습니다. LOCK을 다시 보내거나 Vaipakam 앱에서 볼트를 잠그세요.',
    lockStale: '이 LOCK은 1시간 이상 전에 전송되어 이제야 봇에 도착했으므로 기록되지 않았고 아무것도 잠기지 않습니다. LOCK을 다시 보내거나 Vaipakam 앱에서 볼트를 잠그세요.',
    lockNotRunning: (list) => `${list}에 대해 지금은 Telegram 잠금이 작동하지 않아 아무것도 기록되지 않았고 이 메시지로는 아무것도 잠기지 않습니다. Vaipakam 앱에서 볼트를 잠그세요.`,
  },
  hi: {
    lockEntry: (w, c) => `चेन ${c} पर वॉलेट ${w}`,
    lockRecorded: (list) =>
      `${list} के लिए LOCK मिला। अभी कुछ भी लॉक नहीं हुआ है: keeper उनमें से हर उस को लॉक करता है जिसमें सुरक्षित मोड चालू है और जिसे लॉक करने की आपने अनुमति दी है, आमतौर पर दो मिनट के भीतर, और परिणाम यहीं बताता है।`,
    lockNotLinked:
      'यह चैट किसी वॉलेट से जुड़ी नहीं है, इसलिए लॉक करने को कुछ नहीं है। इसके बजाय Vaipakam ऐप से वॉल्ट लॉक करें।',
    lockPrivateOnly: 'LOCK केवल इस बॉट के साथ आपकी निजी चैट में काम करता है। कुछ भी लॉक नहीं हुआ।',
    lockNotRecorded: 'आपका LOCK अभी दर्ज नहीं हो सका, इसलिए इस संदेश से कुछ भी लॉक नहीं होगा। फिर से LOCK भेजें, या Vaipakam ऐप से वॉल्ट लॉक करें।',
    lockStale: 'यह LOCK एक घंटे से भी पहले भेजा गया था और बॉट तक अभी पहुँचा है, इसलिए इसे दर्ज नहीं किया गया और इससे कुछ भी लॉक नहीं होगा। LOCK फिर से भेजें, या Vaipakam ऐप से वॉल्ट लॉक करें।',
    lockNotRunning: (list) => `${list} के लिए Telegram से लॉक करना अभी चालू नहीं है, इसलिए कुछ दर्ज नहीं हुआ और इस संदेश से कुछ भी लॉक नहीं होगा। Vaipakam ऐप से वॉल्ट लॉक करें।`,
  },
  ta: {
    lockEntry: (w, c) => `சங்கிலி ${c} இல் உள்ள வாலெட் ${w}`,
    lockRecorded: (list) =>
      `${list} க்கான LOCK பெறப்பட்டது. இன்னும் எதுவும் பூட்டப்படவில்லை: பாதுகாப்பு முறை இயக்கத்தில் உள்ள, நீங்கள் பூட்ட அனுமதித்த ஒவ்வொன்றையும் keeper வழக்கமாக இரண்டு நிமிடங்களுக்குள் பூட்டி, முடிவை இங்கே தெரிவிக்கும்.`,
    lockNotLinked:
      'இந்த அரட்டை எந்த வாலெட்டுடனும் இணைக்கப்படவில்லை, எனவே பூட்ட எதுவும் இல்லை. அதற்குப் பதிலாக Vaipakam செயலியில் பெட்டகத்தைப் பூட்டுங்கள்.',
    lockPrivateOnly: 'LOCK இந்த பாட்டுடனான உங்கள் தனிப்பட்ட அரட்டையில் மட்டுமே வேலை செய்யும். எதுவும் பூட்டப்படவில்லை.',
    lockNotRecorded: 'உங்கள் LOCK ஐ இப்போது பதிவு செய்ய முடியவில்லை, எனவே இந்தச் செய்தியால் எதுவும் பூட்டப்படாது. மீண்டும் LOCK அனுப்புங்கள், அல்லது Vaipakam செயலியில் பெட்டகத்தைப் பூட்டுங்கள்.',
    lockStale: 'இந்த LOCK ஒரு மணி நேரத்துக்கு முன்பே அனுப்பப்பட்டு இப்போதுதான் பாட்டை அடைந்தது, எனவே இது பதிவு செய்யப்படவில்லை, இதனால் எதுவும் பூட்டப்படாது. LOCK-ஐ மீண்டும் அனுப்புங்கள், அல்லது Vaipakam செயலியில் வால்ட்டைப் பூட்டுங்கள்.',
    lockNotRunning: (list) => `${list} க்கு Telegram மூலம் பூட்டுவது இப்போது இயங்கவில்லை, எனவே எதுவும் பதிவு செய்யப்படவில்லை, இந்தச் செய்தியால் எதுவும் பூட்டப்படாது. Vaipakam செயலியிலிருந்து பெட்டகத்தைப் பூட்டுங்கள்.`,
  },
  ar: {
    lockEntry: (w, c) => `المحفظة ${w} على السلسلة ${c}`,
    lockRecorded: (list) =>
      `تم استلام LOCK لـ ${list}. لم يُقفل أي شيء بعد: يقفل الـ keeper كل واحدة فُعّل فيها الوضع المحمي وسمحت له بقفلها، عادةً خلال دقيقتين، ويخبرك بالنتيجة هنا.`,
    lockNotLinked: 'هذه المحادثة غير مرتبطة بأي محفظة، لذا لا يوجد ما يُقفل. أقفل الخزنة من تطبيق Vaipakam بدلاً من ذلك.',
    lockPrivateOnly: 'يعمل LOCK فقط في محادثتك الخاصة مع هذا البوت. لم يُقفل أي شيء.',
    lockNotRecorded: 'تعذّر تسجيل طلب LOCK الآن، لذا لن يُقفل أي شيء بهذه الرسالة. أرسل LOCK مرة أخرى، أو أقفل الخزنة من تطبيق Vaipakam.',
    lockStale: 'أُرسل أمر LOCK هذا قبل أكثر من ساعة ولم يصل إلى البوت إلا الآن، لذا لم يُسجَّل ولن يُقفل شيئًا. أرسل LOCK مرة أخرى، أو اقفل الخزنة من تطبيق Vaipakam.',
    lockNotRunning: (list) => `القفل عبر Telegram لا يعمل الآن لـ ${list}، لذا لم يُسجَّل شيء ولن يُقفل أي شيء بهذه الرسالة. أقفل الخزنة من تطبيق Vaipakam.`,
  },
};

/** #3088 — the reply to a LOCK the agent recorded for `entries`. */
export function lockRecorded(
  locale: string | null | undefined,
  entries: readonly { walletShort: string; chainId: number }[],
): string {
  const c = LOCK_CAT[resolveLocale(locale)];
  return c.lockRecorded(entries.map((e) => c.lockEntry(e.walletShort, e.chainId)).join('; '));
}

/** #3088 — the reply to a LOCK from a chat linked to no wallet. */
export function lockNotLinked(locale: string | null | undefined): string {
  return LOCK_CAT[resolveLocale(locale)].lockNotLinked;
}

/** #3088 — the reply to a LOCK sent from a group or channel. */
export function lockPrivateOnly(locale: string | null | undefined): string {
  return LOCK_CAT[resolveLocale(locale)].lockPrivateOnly;
}

/** #3088 — the reply for the linked wallets on chains where no keeper is
 *  currently working LOCK requests: nothing was recorded for them. */
export function lockNotRunning(
  locale: string | null | undefined,
  entries: readonly { walletShort: string; chainId: number }[],
): string {
  const c = LOCK_CAT[resolveLocale(locale)];
  return c.lockNotRunning(entries.map((e) => c.lockEntry(e.walletShort, e.chainId)).join('; '));
}

/** #3088 — the reply to a LOCK the agent could not store. */
export function lockNotRecorded(locale: string | null | undefined): string {
  return LOCK_CAT[resolveLocale(locale)].lockNotRecorded;
}

/** A LOCK sent longer ago than the age limit, not recorded (#3088). */
export function lockStale(locale: string | null | undefined): string {
  return LOCK_CAT[resolveLocale(locale)].lockStale;
}

// ─── #3246 — removing an alert chat waits under protected mode ───────────
//
// While a wallet's account is protected on a chain, removing the Telegram
// chat linked for it (an unlink, or linking a different chat in its place)
// waits the account's delay. The chat linked now is told at once, keeps every
// alert until then, and may reply CANCEL. Lock advice names the app first,
// since Telegram LOCK works only where the owner allowed it and a keeper is
// running it (the bot's own LOCK reply says which). `list` names wallet-and-chain
// entries (the LOCK catalogue's `lockEntry`), `when` a UTC time.

type ChannelCatalogue = {
  /** To the chat linked now: an unlink of it is pending. */
  removalPending: (list: string, when: string) => string;
  /** To the chat linked now: a move of its alerts to another chat is pending. */
  movePending: (list: string, when: string) => string;
  /** To the new chat: it takes over at `when`. */
  moveIncoming: (list: string, when: string) => string;
  /** To the new chat: the move waits, but its wait has not started because
   *  the chat linked now has not received the notice yet. */
  moveWaitingForNotice: (list: string) => string;
  /** To the new chat: the protection status could not be read, nothing changed. */
  protectionUnknown: string;
  /** Reply to CANCEL that stopped the changes for `list`. */
  cancelDone: (list: string) => string;
  /** Reply to CANCEL with nothing pending for this chat. */
  cancelNone: string;
  /** Reply to CANCEL from a group or channel. */
  cancelPrivateOnly: string;
  /** CANCEL could not be processed: the change still stands. */
  cancelNotRecorded: string;
  /** To the old chat when an unlink took effect. */
  removalApplied: (list: string) => string;
  /** To the old chat when a move took effect. */
  moveApplied: (list: string) => string;
};

const CHANNEL_CAT: Record<Locale, ChannelCatalogue> = {
  en: {
    removalPending: (list, when) =>
      `Someone asked to stop sending alerts to this chat for ${list}. Protected mode is on, so this waits until ${when}, and this chat keeps getting every alert until then. If you did not ask for this, reply CANCEL to stop it, and lock the vault now in the Vaipakam app. Sending LOCK here works too if you allowed Telegram locking; the bot replies whether it was recorded.`,
    movePending: (list, when) =>
      `Someone asked to move the alerts for ${list} from this chat to a different Telegram chat. Protected mode is on, so this waits until ${when}, and this chat keeps getting every alert until then. If you did not ask for this, reply CANCEL to stop it, and lock the vault now in the Vaipakam app. Sending LOCK here works too if you allowed Telegram locking; the bot replies whether it was recorded.`,
    moveIncoming: (list, when) =>
      `This chat will start getting alerts for ${list} at ${when}. Protected mode is on, so moving alerts away from the chat linked now waits, and that chat has been told and can cancel the move.`,
    moveWaitingForNotice: (list) =>
      `A move of the alerts for ${list} to this chat is waiting: protected mode is on, and the wait starts once the chat linked now has received our notice about it. We will tell you here when it starts.`,
    protectionUnknown:
      'Nothing was changed: we could not check just now whether this wallet has protected mode on. Get a new link code from the Vaipakam app and try again later.',
    cancelDone: (list) =>
      `Cancelled. This chat keeps getting alerts for ${list}. If you did not ask for that change, someone may hold your wallet key: lock the vault now in the Vaipakam app (sending LOCK here works too if you allowed Telegram locking) and check it there.`,
    cancelNone: 'There is no pending change to cancel for this chat.',
    cancelPrivateOnly: 'CANCEL works only in your private chat with this bot. Nothing was cancelled.',
    cancelNotRecorded: 'CANCEL could not be recorded just now, so the pending change still stands. Send CANCEL again, and lock the vault in the Vaipakam app if you did not ask for this change.',
    removalApplied: (list) => `As requested, this chat no longer gets alerts for ${list}.`,
    moveApplied: (list) => `As requested, the alerts for ${list} now go to a different Telegram chat. This chat no longer gets them.`,
  },
  es: {
    removalPending: (list, when) =>
      `Alguien pidió dejar de enviar alertas a este chat para ${list}. El modo protegido está activado, así que esto espera hasta ${when} y este chat sigue recibiendo todas las alertas hasta entonces. Si no lo pediste tú, responde CANCEL para detenerlo y bloquea la bóveda ahora en la app de Vaipakam. Enviar LOCK aquí también funciona si permitiste el bloqueo por Telegram; el bot responde si quedó registrado.`,
    movePending: (list, when) =>
      `Alguien pidió mover las alertas de ${list} de este chat a otro chat de Telegram. El modo protegido está activado, así que esto espera hasta ${when} y este chat sigue recibiendo todas las alertas hasta entonces. Si no lo pediste tú, responde CANCEL para detenerlo y bloquea la bóveda ahora en la app de Vaipakam. Enviar LOCK aquí también funciona si permitiste el bloqueo por Telegram; el bot responde si quedó registrado.`,
    moveIncoming: (list, when) =>
      `Este chat empezará a recibir alertas de ${list} a las ${when}. El modo protegido está activado, así que quitar las alertas del chat vinculado ahora espera, y ese chat ha sido avisado y puede cancelar el cambio.`,
    moveWaitingForNotice: (list) =>
      `Mover las alertas de ${list} a este chat está en espera: el modo protegido está activado y la espera empieza cuando el chat vinculado ahora reciba nuestro aviso. Te diremos aquí cuándo empieza.`,
    protectionUnknown:
      'No se cambió nada: ahora mismo no pudimos comprobar si esta billetera tiene el modo protegido activado. Obtén un nuevo código de vinculación en la app de Vaipakam e inténtalo más tarde.',
    cancelDone: (list) =>
      `Cancelado. Este chat sigue recibiendo alertas de ${list}. Si no pediste ese cambio, alguien podría tener la clave de tu billetera: bloquea la bóveda ahora en la app de Vaipakam (enviar LOCK aquí también funciona si permitiste el bloqueo por Telegram) y revísala allí.`,
    cancelNone: 'No hay ningún cambio pendiente que cancelar para este chat.',
    cancelPrivateOnly: 'CANCEL solo funciona en tu chat privado con este bot. No se canceló nada.',
    cancelNotRecorded: 'No se pudo registrar CANCEL en este momento, así que el cambio pendiente sigue en pie. Envía CANCEL de nuevo y bloquea la bóveda en la app de Vaipakam si no pediste este cambio.',
    removalApplied: (list) => `Como se pidió, este chat ya no recibe alertas de ${list}.`,
    moveApplied: (list) => `Como se pidió, las alertas de ${list} ahora van a otro chat de Telegram. Este chat ya no las recibe.`,
  },
  fr: {
    removalPending: (list, when) =>
      `Quelqu'un a demandé de ne plus envoyer d'alertes à ce chat pour ${list}. Le mode protégé est activé : cela attend jusqu'au ${when}, et ce chat reçoit toutes les alertes jusque-là. Si ce n'est pas vous, répondez CANCEL pour l'arrêter et verrouillez le coffre maintenant dans l'application Vaipakam. Envoyer LOCK ici fonctionne aussi si vous avez autorisé le verrouillage par Telegram ; le bot indique s'il a été enregistré.`,
    movePending: (list, when) =>
      `Quelqu'un a demandé de déplacer les alertes de ${list} de ce chat vers un autre chat Telegram. Le mode protégé est activé : cela attend jusqu'au ${when}, et ce chat reçoit toutes les alertes jusque-là. Si ce n'est pas vous, répondez CANCEL pour l'arrêter et verrouillez le coffre maintenant dans l'application Vaipakam. Envoyer LOCK ici fonctionne aussi si vous avez autorisé le verrouillage par Telegram ; le bot indique s'il a été enregistré.`,
    moveIncoming: (list, when) =>
      `Ce chat commencera à recevoir les alertes de ${list} le ${when}. Le mode protégé est activé : retirer les alertes du chat lié actuellement attend, et ce chat a été prévenu et peut annuler le changement.`,
    moveWaitingForNotice: (list) =>
      `Le déplacement des alertes de ${list} vers ce chat est en attente : le mode protégé est activé, et l'attente commence quand le chat lié actuellement aura reçu notre avis. Nous vous dirons ici quand elle commence.`,
    protectionUnknown:
      "Rien n'a été modifié : nous n'avons pas pu vérifier pour l'instant si ce portefeuille a le mode protégé activé. Obtenez un nouveau code de liaison dans l'application Vaipakam et réessayez plus tard.",
    cancelDone: (list) =>
      `Annulé. Ce chat continue de recevoir les alertes de ${list}. Si vous n'avez pas demandé ce changement, quelqu'un détient peut-être la clé de votre portefeuille : verrouillez le coffre maintenant dans l'application Vaipakam (envoyer LOCK ici fonctionne aussi si vous avez autorisé le verrouillage par Telegram) et vérifiez-le là-bas.`,
    cancelNone: "Aucun changement en attente à annuler pour ce chat.",
    cancelPrivateOnly: "CANCEL ne fonctionne que dans votre conversation privée avec ce bot. Rien n'a été annulé.",
    cancelNotRecorded: "CANCEL n'a pas pu être enregistré pour l'instant, le changement en attente est donc maintenu. Envoyez CANCEL à nouveau et verrouillez le coffre dans l'application Vaipakam si vous n'avez pas demandé ce changement.",
    removalApplied: (list) => `Comme demandé, ce chat ne reçoit plus les alertes de ${list}.`,
    moveApplied: (list) => `Comme demandé, les alertes de ${list} vont maintenant vers un autre chat Telegram. Ce chat ne les reçoit plus.`,
  },
  de: {
    removalPending: (list, when) =>
      `Jemand hat verlangt, diesem Chat keine Warnungen mehr für ${list} zu senden. Der geschützte Modus ist aktiv, daher wartet dies bis ${when}, und dieser Chat erhält bis dahin jede Warnung. Wenn Sie das nicht verlangt haben, antworten Sie CANCEL, um es zu stoppen, und sperren Sie den Tresor jetzt in der Vaipakam-App. LOCK hier zu senden funktioniert auch, wenn Sie das Sperren über Telegram erlaubt haben; der Bot antwortet, ob es erfasst wurde.`,
    movePending: (list, when) =>
      `Jemand hat verlangt, die Warnungen für ${list} von diesem Chat in einen anderen Telegram-Chat zu verlegen. Der geschützte Modus ist aktiv, daher wartet dies bis ${when}, und dieser Chat erhält bis dahin jede Warnung. Wenn Sie das nicht verlangt haben, antworten Sie CANCEL, um es zu stoppen, und sperren Sie den Tresor jetzt in der Vaipakam-App. LOCK hier zu senden funktioniert auch, wenn Sie das Sperren über Telegram erlaubt haben; der Bot antwortet, ob es erfasst wurde.`,
    moveIncoming: (list, when) =>
      `Dieser Chat erhält ab ${when} Warnungen für ${list}. Der geschützte Modus ist aktiv, daher wartet das Entfernen der Warnungen aus dem jetzt verknüpften Chat, und dieser Chat wurde informiert und kann den Wechsel abbrechen.`,
    moveWaitingForNotice: (list) =>
      `Das Verlegen der Warnungen für ${list} in diesen Chat wartet: Der geschützte Modus ist aktiv, und die Wartezeit beginnt, sobald der jetzt verknüpfte Chat unsere Mitteilung erhalten hat. Wir sagen Ihnen hier, wann sie beginnt.`,
    protectionUnknown:
      'Es wurde nichts geändert: Wir konnten gerade nicht prüfen, ob für diese Wallet der geschützte Modus aktiv ist. Holen Sie sich in der Vaipakam-App einen neuen Verknüpfungscode und versuchen Sie es später erneut.',
    cancelDone: (list) =>
      `Abgebrochen. Dieser Chat erhält weiter Warnungen für ${list}. Wenn Sie diese Änderung nicht verlangt haben, hat vielleicht jemand Ihren Wallet-Schlüssel: Sperren Sie den Tresor jetzt in der Vaipakam-App (LOCK hier zu senden funktioniert auch, wenn Sie das Sperren über Telegram erlaubt haben) und prüfen Sie ihn dort.`,
    cancelNone: 'Für diesen Chat gibt es keine ausstehende Änderung zum Abbrechen.',
    cancelPrivateOnly: 'CANCEL funktioniert nur in Ihrem privaten Chat mit diesem Bot. Es wurde nichts abgebrochen.',
    cancelNotRecorded: 'CANCEL konnte gerade nicht erfasst werden, die ausstehende Änderung bleibt also bestehen. Senden Sie CANCEL erneut und sperren Sie den Tresor in der Vaipakam-App, wenn Sie diese Änderung nicht angefordert haben.',
    removalApplied: (list) => `Wie verlangt erhält dieser Chat keine Warnungen mehr für ${list}.`,
    moveApplied: (list) => `Wie verlangt gehen die Warnungen für ${list} jetzt an einen anderen Telegram-Chat. Dieser Chat erhält sie nicht mehr.`,
  },
  ja: {
    removalPending: (list, when) =>
      `${list} のアラートをこのチャットに送るのをやめる依頼がありました。保護モードが有効なため、これは ${when} まで待機し、それまでこのチャットはすべてのアラートを受け取ります。心当たりがない場合は CANCEL と返信して止め、今すぐ Vaipakam アプリでボールトをロックしてください。Telegram からのロックを許可している場合は、ここで LOCK を送ることもでき、記録されたかどうかをボットが返信します。`,
    movePending: (list, when) =>
      `${list} のアラートをこのチャットから別の Telegram チャットに移す依頼がありました。保護モードが有効なため、これは ${when} まで待機し、それまでこのチャットはすべてのアラートを受け取ります。心当たりがない場合は CANCEL と返信して止め、今すぐ Vaipakam アプリでボールトをロックしてください。Telegram からのロックを許可している場合は、ここで LOCK を送ることもでき、記録されたかどうかをボットが返信します。`,
    moveIncoming: (list, when) =>
      `このチャットは ${when} から ${list} のアラートを受け取ります。保護モードが有効なため、現在連携しているチャットからアラートを外すには待機が必要で、そのチャットには通知済みで、変更を取り消せます。`,
    moveWaitingForNotice: (list) =>
      `${list} のアラートをこのチャットに移す変更は待機中です。保護モードが有効で、現在連携しているチャットが通知を受け取った時点から待機が始まります。開始したらここでお知らせします。`,
    protectionUnknown:
      '何も変更していません。このウォレットの保護モードが有効かどうかを今は確認できませんでした。Vaipakam アプリで新しい連携コードを取得し、後でもう一度お試しください。',
    cancelDone: (list) =>
      `取り消しました。このチャットは引き続き ${list} のアラートを受け取ります。その変更に心当たりがない場合、誰かがウォレットの鍵を持っている可能性があります。今すぐ Vaipakam アプリでボールトをロックし（Telegram からのロックを許可している場合はここで LOCK を送ることもできます）、そこで確認してください。`,
    cancelNone: 'このチャットには取り消せる保留中の変更はありません。',
    cancelPrivateOnly: 'CANCEL はこのボットとのプライベートチャットでのみ使えます。何も取り消されていません。',
    cancelNotRecorded: '現在 CANCEL を記録できなかったため、保留中の変更は有効なままです。もう一度 CANCEL を送信し、この変更に心当たりがなければ Vaipakam アプリで保管庫をロックしてください。',
    removalApplied: (list) => `ご依頼どおり、このチャットは ${list} のアラートを受け取らなくなりました。`,
    moveApplied: (list) => `ご依頼どおり、${list} のアラートは別の Telegram チャットに届くようになりました。このチャットにはもう届きません。`,
  },
  zh: {
    removalPending: (list, when) =>
      `有人请求停止向此聊天发送 ${list} 的提醒。保护模式已开启，因此这需要等到 ${when}，在此之前此聊天仍会收到所有提醒。如果不是你提出的，请回复 CANCEL 阻止它，并立即在 Vaipakam 应用中锁定金库。如果你允许通过 Telegram 锁定，也可以在这里发送 LOCK，机器人会回复是否已记录。`,
    movePending: (list, when) =>
      `有人请求把 ${list} 的提醒从此聊天移到另一个 Telegram 聊天。保护模式已开启，因此这需要等到 ${when}，在此之前此聊天仍会收到所有提醒。如果不是你提出的，请回复 CANCEL 阻止它，并立即在 Vaipakam 应用中锁定金库。如果你允许通过 Telegram 锁定，也可以在这里发送 LOCK，机器人会回复是否已记录。`,
    moveIncoming: (list, when) =>
      `此聊天将从 ${when} 起收到 ${list} 的提醒。保护模式已开启，因此从当前关联的聊天移走提醒需要等待，该聊天已收到通知并可以取消此更改。`,
    moveWaitingForNotice: (list) =>
      `把 ${list} 的提醒移到此聊天的更改正在等待：保护模式已开启，等待期从当前关联的聊天收到我们的通知时开始。开始时我们会在这里告诉你。`,
    protectionUnknown: '未做任何更改：目前无法确认此钱包是否开启了保护模式。请在 Vaipakam 应用中获取新的关联码，稍后再试。',
    cancelDone: (list) =>
      `已取消。此聊天继续收到 ${list} 的提醒。如果你没有提出该更改，可能有人掌握了你的钱包密钥：请立即在 Vaipakam 应用中锁定金库（如果你允许通过 Telegram 锁定，也可以在这里发送 LOCK），并在那里检查。`,
    cancelNone: '此聊天没有可取消的待处理更改。',
    cancelPrivateOnly: 'CANCEL 只能在你与此机器人的私聊中使用。未取消任何内容。',
    cancelNotRecorded: '目前无法记录 CANCEL，因此待处理的更改仍然有效。请再次发送 CANCEL；如果你没有请求此更改，请在 Vaipakam 应用中锁定保管库。',
    removalApplied: (list) => `按你的请求，此聊天不再收到 ${list} 的提醒。`,
    moveApplied: (list) => `按你的请求，${list} 的提醒现在发送到另一个 Telegram 聊天。此聊天不再收到。`,
  },
  ko: {
    removalPending: (list, when) =>
      `${list}의 알림을 이 채팅으로 보내지 않도록 요청이 있었습니다. 보호 모드가 켜져 있어 ${when}까지 기다리며, 그때까지 이 채팅은 모든 알림을 계속 받습니다. 직접 요청하지 않았다면 CANCEL로 답장해 중지하고, 지금 Vaipakam 앱에서 볼트를 잠그세요. Telegram 잠금을 허용했다면 여기서 LOCK을 보내도 되며, 봇이 기록 여부를 답장합니다.`,
    movePending: (list, when) =>
      `${list}의 알림을 이 채팅에서 다른 Telegram 채팅으로 옮기도록 요청이 있었습니다. 보호 모드가 켜져 있어 ${when}까지 기다리며, 그때까지 이 채팅은 모든 알림을 계속 받습니다. 직접 요청하지 않았다면 CANCEL로 답장해 중지하고, 지금 Vaipakam 앱에서 볼트를 잠그세요. Telegram 잠금을 허용했다면 여기서 LOCK을 보내도 되며, 봇이 기록 여부를 답장합니다.`,
    moveIncoming: (list, when) =>
      `이 채팅은 ${when}부터 ${list}의 알림을 받습니다. 보호 모드가 켜져 있어 지금 연결된 채팅에서 알림을 옮기려면 기다려야 하며, 그 채팅에는 알림이 갔고 변경을 취소할 수 있습니다.`,
    moveWaitingForNotice: (list) =>
      `${list}의 알림을 이 채팅으로 옮기는 변경이 대기 중입니다. 보호 모드가 켜져 있으며, 지금 연결된 채팅이 알림을 받은 때부터 대기가 시작됩니다. 시작되면 여기서 알려 드립니다.`,
    protectionUnknown:
      '아무것도 바뀌지 않았습니다. 지금은 이 지갑에 보호 모드가 켜져 있는지 확인할 수 없었습니다. Vaipakam 앱에서 새 연결 코드를 받아 나중에 다시 시도하세요.',
    cancelDone: (list) =>
      `취소했습니다. 이 채팅은 계속 ${list}의 알림을 받습니다. 그 변경을 요청하지 않았다면 누군가 지갑 키를 가지고 있을 수 있습니다. 지금 Vaipakam 앱에서 볼트를 잠그고(Telegram 잠금을 허용했다면 여기서 LOCK을 보내도 됩니다) 거기서 확인하세요.`,
    cancelNone: '이 채팅에는 취소할 대기 중인 변경이 없습니다.',
    cancelPrivateOnly: 'CANCEL은 이 봇과의 개인 채팅에서만 작동합니다. 아무것도 취소되지 않았습니다.',
    cancelNotRecorded: '지금은 CANCEL을 기록할 수 없어 대기 중인 변경이 그대로 유지됩니다. CANCEL을 다시 보내고, 이 변경을 요청하지 않았다면 Vaipakam 앱에서 금고를 잠그세요.',
    removalApplied: (list) => `요청하신 대로 이 채팅은 더 이상 ${list}의 알림을 받지 않습니다.`,
    moveApplied: (list) => `요청하신 대로 ${list}의 알림은 이제 다른 Telegram 채팅으로 갑니다. 이 채팅은 더 이상 받지 않습니다.`,
  },
  hi: {
    removalPending: (list, when) =>
      `किसी ने ${list} के अलर्ट इस चैट पर भेजना बंद करने को कहा है। सुरक्षित मोड चालू है, इसलिए यह ${when} तक रुका रहेगा, और तब तक इस चैट को हर अलर्ट मिलता रहेगा। अगर यह आपने नहीं माँगा, तो रोकने के लिए CANCEL लिखकर जवाब दें, और अभी Vaipakam ऐप में वॉल्ट लॉक करें। अगर आपने Telegram से लॉक करने की अनुमति दी है तो यहाँ LOCK भेजना भी काम करता है; बॉट बताता है कि वह दर्ज हुआ या नहीं।`,
    movePending: (list, when) =>
      `किसी ने ${list} के अलर्ट इस चैट से किसी दूसरे Telegram चैट पर ले जाने को कहा है। सुरक्षित मोड चालू है, इसलिए यह ${when} तक रुका रहेगा, और तब तक इस चैट को हर अलर्ट मिलता रहेगा। अगर यह आपने नहीं माँगा, तो रोकने के लिए CANCEL लिखकर जवाब दें, और अभी Vaipakam ऐप में वॉल्ट लॉक करें। अगर आपने Telegram से लॉक करने की अनुमति दी है तो यहाँ LOCK भेजना भी काम करता है; बॉट बताता है कि वह दर्ज हुआ या नहीं।`,
    moveIncoming: (list, when) =>
      `इस चैट को ${when} से ${list} के अलर्ट मिलने लगेंगे। सुरक्षित मोड चालू है, इसलिए अभी जुड़े चैट से अलर्ट हटाने में प्रतीक्षा होती है, और उस चैट को बता दिया गया है और वह बदलाव रद्द कर सकता है।`,
    moveWaitingForNotice: (list) =>
      `${list} के अलर्ट इस चैट पर लाने का बदलाव प्रतीक्षा में है: सुरक्षित मोड चालू है, और प्रतीक्षा तब शुरू होती है जब अभी जुड़ी चैट को हमारी सूचना मिल जाए। शुरू होने पर हम यहीं बताएँगे।`,
    protectionUnknown:
      'कुछ नहीं बदला गया: हम अभी जाँच नहीं पाए कि इस वॉलेट में सुरक्षित मोड चालू है या नहीं। Vaipakam ऐप से नया लिंक कोड लें और बाद में फिर कोशिश करें।',
    cancelDone: (list) =>
      `रद्द कर दिया गया। इस चैट को ${list} के अलर्ट मिलते रहेंगे। अगर वह बदलाव आपने नहीं माँगा था, तो हो सकता है किसी के पास आपकी वॉलेट कुंजी हो: अभी Vaipakam ऐप में वॉल्ट लॉक करें (अगर आपने Telegram से लॉक करने की अनुमति दी है तो यहाँ LOCK भेजना भी काम करता है) और वहीं जाँचें।`,
    cancelNone: 'इस चैट के लिए रद्द करने को कोई लंबित बदलाव नहीं है।',
    cancelPrivateOnly: 'CANCEL केवल इस बॉट के साथ आपकी निजी चैट में काम करता है। कुछ भी रद्द नहीं हुआ।',
    cancelNotRecorded: 'CANCEL अभी दर्ज नहीं हो सका, इसलिए लंबित बदलाव अब भी बना हुआ है। CANCEL फिर से भेजें, और अगर आपने यह बदलाव नहीं माँगा था तो Vaipakam ऐप में वॉल्ट लॉक करें।',
    removalApplied: (list) => `आपके अनुरोध के अनुसार, इस चैट को अब ${list} के अलर्ट नहीं मिलेंगे।`,
    moveApplied: (list) => `आपके अनुरोध के अनुसार, ${list} के अलर्ट अब किसी दूसरे Telegram चैट पर जाते हैं। इस चैट को अब वे नहीं मिलेंगे।`,
  },
  ta: {
    removalPending: (list, when) =>
      `${list} க்கான எச்சரிக்கைகளை இந்த அரட்டைக்கு அனுப்புவதை நிறுத்தும்படி யாரோ கேட்டுள்ளனர். பாதுகாப்பு முறை இயக்கத்தில் உள்ளதால், இது ${when} வரை காத்திருக்கும், அதுவரை இந்த அரட்டை எல்லா எச்சரிக்கைகளையும் பெறும். இதை நீங்கள் கேட்கவில்லை என்றால், நிறுத்த CANCEL என்று பதிலளியுங்கள், இப்போதே Vaipakam செயலியில் பெட்டகத்தைப் பூட்டுங்கள். Telegram மூலம் பூட்ட நீங்கள் அனுமதித்திருந்தால் இங்கே LOCK அனுப்புவதும் வேலை செய்யும்; அது பதிவானதா என்று பாட் பதிலளிக்கும்.`,
    movePending: (list, when) =>
      `${list} க்கான எச்சரிக்கைகளை இந்த அரட்டையிலிருந்து வேறு Telegram அரட்டைக்கு மாற்றும்படி யாரோ கேட்டுள்ளனர். பாதுகாப்பு முறை இயக்கத்தில் உள்ளதால், இது ${when} வரை காத்திருக்கும், அதுவரை இந்த அரட்டை எல்லா எச்சரிக்கைகளையும் பெறும். இதை நீங்கள் கேட்கவில்லை என்றால், நிறுத்த CANCEL என்று பதிலளியுங்கள், இப்போதே Vaipakam செயலியில் பெட்டகத்தைப் பூட்டுங்கள். Telegram மூலம் பூட்ட நீங்கள் அனுமதித்திருந்தால் இங்கே LOCK அனுப்புவதும் வேலை செய்யும்; அது பதிவானதா என்று பாட் பதிலளிக்கும்.`,
    moveIncoming: (list, when) =>
      `இந்த அரட்டை ${when} முதல் ${list} க்கான எச்சரிக்கைகளைப் பெறும். பாதுகாப்பு முறை இயக்கத்தில் உள்ளதால், இப்போது இணைக்கப்பட்ட அரட்டையிலிருந்து எச்சரிக்கைகளை மாற்றுவது காத்திருக்கும்; அந்த அரட்டைக்குத் தெரிவிக்கப்பட்டுள்ளது, அது இந்த மாற்றத்தை ரத்து செய்யலாம்.`,
    moveWaitingForNotice: (list) =>
      `${list} க்கான எச்சரிக்கைகளை இந்த அரட்டைக்கு மாற்றுவது காத்திருப்பில் உள்ளது: பாதுகாப்பு முறை இயக்கத்தில் உள்ளது, இப்போது இணைக்கப்பட்ட அரட்டை எங்கள் அறிவிப்பைப் பெற்றதும் காத்திருப்பு தொடங்கும். அது தொடங்கும்போது இங்கே சொல்வோம்.`,
    protectionUnknown:
      'எதுவும் மாற்றப்படவில்லை: இந்த வாலெட்டில் பாதுகாப்பு முறை இயக்கத்தில் உள்ளதா என்பதை இப்போது சரிபார்க்க முடியவில்லை. Vaipakam செயலியில் புதிய இணைப்புக் குறியீட்டைப் பெற்று பிறகு மீண்டும் முயலுங்கள்.',
    cancelDone: (list) =>
      `ரத்து செய்யப்பட்டது. இந்த அரட்டை ${list} க்கான எச்சரிக்கைகளைத் தொடர்ந்து பெறும். அந்த மாற்றத்தை நீங்கள் கேட்கவில்லை என்றால், உங்கள் வாலெட் சாவி வேறொருவரிடம் இருக்கலாம்: இப்போதே Vaipakam செயலியில் பெட்டகத்தைப் பூட்டி (Telegram மூலம் பூட்ட அனுமதித்திருந்தால் இங்கே LOCK அனுப்புவதும் வேலை செய்யும்) அங்கே சரிபாருங்கள்.`,
    cancelNone: 'இந்த அரட்டைக்கு ரத்து செய்ய நிலுவையில் உள்ள மாற்றம் எதுவும் இல்லை.',
    cancelPrivateOnly: 'CANCEL இந்த பாட்டுடனான உங்கள் தனிப்பட்ட அரட்டையில் மட்டுமே வேலை செய்யும். எதுவும் ரத்து செய்யப்படவில்லை.',
    cancelNotRecorded: 'இப்போது CANCEL ஐப் பதிவு செய்ய முடியவில்லை, எனவே நிலுவையில் உள்ள மாற்றம் தொடர்கிறது. CANCEL ஐ மீண்டும் அனுப்புங்கள்; இந்த மாற்றத்தை நீங்கள் கேட்கவில்லை என்றால் Vaipakam செயலியில் பெட்டகத்தைப் பூட்டுங்கள்.',
    removalApplied: (list) => `கேட்டபடி, இந்த அரட்டை இனி ${list} க்கான எச்சரிக்கைகளைப் பெறாது.`,
    moveApplied: (list) => `கேட்டபடி, ${list} க்கான எச்சரிக்கைகள் இப்போது வேறு Telegram அரட்டைக்குச் செல்கின்றன. இந்த அரட்டை இனி அவற்றைப் பெறாது.`,
  },
  ar: {
    removalPending: (list, when) =>
      `طلب أحدهم إيقاف إرسال التنبيهات إلى هذه المحادثة لـ ${list}. الوضع المحمي مفعّل، لذا ينتظر ذلك حتى ${when}، وتستمر هذه المحادثة في تلقي كل التنبيهات حتى ذلك الحين. إن لم تطلب ذلك، فأرسل CANCEL لإيقافه، واقفل الخزنة الآن من تطبيق Vaipakam. يعمل إرسال LOCK هنا أيضًا إن سمحت بالقفل عبر Telegram؛ ويرد البوت بما إذا سُجّل الطلب.`,
    movePending: (list, when) =>
      `طلب أحدهم نقل تنبيهات ${list} من هذه المحادثة إلى محادثة Telegram أخرى. الوضع المحمي مفعّل، لذا ينتظر ذلك حتى ${when}، وتستمر هذه المحادثة في تلقي كل التنبيهات حتى ذلك الحين. إن لم تطلب ذلك، فأرسل CANCEL لإيقافه، واقفل الخزنة الآن من تطبيق Vaipakam. يعمل إرسال LOCK هنا أيضًا إن سمحت بالقفل عبر Telegram؛ ويرد البوت بما إذا سُجّل الطلب.`,
    moveIncoming: (list, when) =>
      `ستبدأ هذه المحادثة بتلقي تنبيهات ${list} في ${when}. الوضع المحمي مفعّل، لذا ينتظر نقل التنبيهات من المحادثة المرتبطة الآن، وقد أُبلغت تلك المحادثة ويمكنها إلغاء النقل.`,
    moveWaitingForNotice: (list) =>
      `نقل تنبيهات ${list} إلى هذه المحادثة قيد الانتظار: الوضع المحمي مفعّل، وتبدأ مدة الانتظار عندما تتلقى المحادثة المرتبطة الآن إشعارنا. سنخبرك هنا عندما تبدأ.`,
    protectionUnknown:
      'لم يتغير شيء: تعذّر علينا الآن التحقق مما إذا كان الوضع المحمي مفعّلاً لهذه المحفظة. احصل على رمز ربط جديد من تطبيق Vaipakam وحاول مرة أخرى لاحقًا.',
    cancelDone: (list) =>
      `تم الإلغاء. تستمر هذه المحادثة في تلقي تنبيهات ${list}. إن لم تطلب ذلك التغيير، فقد يملك أحدهم مفتاح محفظتك: اقفل الخزنة الآن من تطبيق Vaipakam (يعمل إرسال LOCK هنا أيضًا إن سمحت بالقفل عبر Telegram) وتحقق منها هناك.`,
    cancelNone: 'لا يوجد تغيير معلّق لإلغائه لهذه المحادثة.',
    cancelPrivateOnly: 'يعمل CANCEL فقط في محادثتك الخاصة مع هذا البوت. لم يُلغَ أي شيء.',
    cancelNotRecorded: 'تعذّر تسجيل CANCEL الآن، لذا ما زال التغيير المعلّق قائمًا. أرسل CANCEL مرة أخرى، وأقفل الخزنة في تطبيق Vaipakam إن لم تكن قد طلبت هذا التغيير.',
    removalApplied: (list) => `كما طُلب، لم تعد هذه المحادثة تتلقى تنبيهات ${list}.`,
    moveApplied: (list) => `كما طُلب، تذهب تنبيهات ${list} الآن إلى محادثة Telegram أخرى. لم تعد هذه المحادثة تتلقاها.`,
  },
};

type Entry = { walletShort: string; chainId: number };
function channelList(locale: string | null | undefined, entries: readonly Entry[]): string {
  const c = LOCK_CAT[resolveLocale(locale)];
  return entries.map((e) => c.lockEntry(e.walletShort, e.chainId)).join('; ');
}

/** #3246 — notices about a pending or applied removal of an alert chat. */
export const channelCopy = {
  removalPending: (locale: string | null | undefined, entries: readonly Entry[], when: string) =>
    CHANNEL_CAT[resolveLocale(locale)].removalPending(channelList(locale, entries), when),
  movePending: (locale: string | null | undefined, entries: readonly Entry[], when: string) =>
    CHANNEL_CAT[resolveLocale(locale)].movePending(channelList(locale, entries), when),
  moveIncoming: (locale: string | null | undefined, entries: readonly Entry[], when: string) =>
    CHANNEL_CAT[resolveLocale(locale)].moveIncoming(channelList(locale, entries), when),
  moveWaitingForNotice: (locale: string | null | undefined, entries: readonly Entry[]) =>
    CHANNEL_CAT[resolveLocale(locale)].moveWaitingForNotice(channelList(locale, entries)),
  protectionUnknown: (locale: string | null | undefined) => CHANNEL_CAT[resolveLocale(locale)].protectionUnknown,
  cancelDone: (locale: string | null | undefined, entries: readonly Entry[]) =>
    CHANNEL_CAT[resolveLocale(locale)].cancelDone(channelList(locale, entries)),
  cancelNone: (locale: string | null | undefined) => CHANNEL_CAT[resolveLocale(locale)].cancelNone,
  cancelPrivateOnly: (locale: string | null | undefined) => CHANNEL_CAT[resolveLocale(locale)].cancelPrivateOnly,
  cancelNotRecorded: (locale: string | null | undefined) => CHANNEL_CAT[resolveLocale(locale)].cancelNotRecorded,
  removalApplied: (locale: string | null | undefined, entries: readonly Entry[]) =>
    CHANNEL_CAT[resolveLocale(locale)].removalApplied(channelList(locale, entries)),
  moveApplied: (locale: string | null | undefined, entries: readonly Entry[]) =>
    CHANNEL_CAT[resolveLocale(locale)].moveApplied(channelList(locale, entries)),
};
