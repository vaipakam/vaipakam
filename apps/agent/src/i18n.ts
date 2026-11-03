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
    lockNotRunning: (list) => `${list} では現在 Telegram からのロックが動作していないため、何も記録されず、このメッセージでは何もロックされません。Vaipakam アプリからボールトをロックしてください。`,
  },
  zh: {
    lockEntry: (w, c) => `链 ${c} 上的钱包 ${w}`,
    lockRecorded: (list) =>
      `已收到 ${list} 的 LOCK 请求。目前尚未锁定任何内容：keeper 会锁定其中已开启保护模式且你已允许其锁定的每一个，通常在两分钟内完成，并在这里告诉你结果。`,
    lockNotLinked: '此聊天未关联任何钱包，因此没有可锁定的内容。请改在 Vaipakam 应用中锁定金库。',
    lockPrivateOnly: 'LOCK 只能在你与此机器人的私聊中使用。未锁定任何内容。',
    lockNotRecorded: '暂时无法记录你的 LOCK 请求，因此这条消息不会锁定任何内容。请再次发送 LOCK，或在 Vaipakam 应用中锁定金库。',
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
    lockNotRunning: (list) => `${list} க்கு Telegram மூலம் பூட்டுவது இப்போது இயங்கவில்லை, எனவே எதுவும் பதிவு செய்யப்படவில்லை, இந்தச் செய்தியால் எதுவும் பூட்டப்படாது. Vaipakam செயலியிலிருந்து பெட்டகத்தைப் பூட்டுங்கள்.`,
  },
  ar: {
    lockEntry: (w, c) => `المحفظة ${w} على السلسلة ${c}`,
    lockRecorded: (list) =>
      `تم استلام LOCK لـ ${list}. لم يُقفل أي شيء بعد: يقفل الـ keeper كل واحدة فُعّل فيها الوضع المحمي وسمحت له بقفلها، عادةً خلال دقيقتين، ويخبرك بالنتيجة هنا.`,
    lockNotLinked: 'هذه المحادثة غير مرتبطة بأي محفظة، لذا لا يوجد ما يُقفل. أقفل الخزنة من تطبيق Vaipakam بدلاً من ذلك.',
    lockPrivateOnly: 'يعمل LOCK فقط في محادثتك الخاصة مع هذا البوت. لم يُقفل أي شيء.',
    lockNotRecorded: 'تعذّر تسجيل طلب LOCK الآن، لذا لن يُقفل أي شيء بهذه الرسالة. أرسل LOCK مرة أخرى، أو أقفل الخزنة من تطبيق Vaipakam.',
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
