// packages/lib/src/telegramAlerts/securityCopy.ts
//
// #3346 — the alert an owner gets when a change that loosens the protection
// of their protected account is asked for: an unlock, a shorter delay,
// protected mode switched off, a signer added or removed, a destination added
// to the allowlist, a new recovery address or the recovery address cleared,
// the recovery claim switched on or its wait shortened, a Protected → Ready
// top-up, a longer Ready idle period. Each names who asked (when the chain
// says) and when it takes effect, and says to lock the vault if it was not
// them. A lock and a proposed replacement have their own alerts
// (`protectedCopy.ts`).
//
// One catalogue per locale, falling back to English, like `termsCopy.ts`.

import { SUPPORTED_LOCALES, type Locale } from './hfCopy';

export const SECURITY_CHANGES = [
  'unlockRequested',
  'delayShortRequested',
  'switchOffRequested',
  'signerAddRequested',
  'signerRemoveRequested',
  'allowlistAddRequested',
  'recoveryRequested',
  'recoveryCleared',
  'claimSettingRequested',
  'readyTopUp',
  'idleLengthen',
] as const;
export type SecurityChange = (typeof SECURITY_CHANGES)[number];

/** The parts of a change a message names. `subject` an address (a signer, a
 *  destination, a recovery address), `what` an asset and amount, `hours` a
 *  duration (a delay, a claim wait, an idle period; 0 = switched off), `at`
 *  when it takes effect, UTC, `by` who asked. Each is null where the change
 *  has none or the chain did not say. */
export interface SecurityParts {
  subject: string | null;
  what: string | null;
  hours: number | null;
  at: string | null;
  by: string | null;
}

function resolve(s: string | null | undefined): Locale {
  return s && (SUPPORTED_LOCALES as readonly string[]).includes(s) ? (s as Locale) : 'en';
}

interface Copy {
  head: (w: string, c: number) => string;
  change: Record<SecurityChange, (p: SecurityParts) => string>;
  at: (t: string) => string;
  by: (b: string) => string;
  act: (link: string) => string;
  pushTitle: string;
}

const s = (x: string | null) => x ?? '?';
const h = (p: SecurityParts) => (p.hours === null ? '?' : String(p.hours));

const COPY: Record<Locale, Copy> = {
  en: {
    head: (w, c) => `Security change on the protected vault of wallet ${w} on chain ${c}.`,
    change: {
      unlockRequested: () => 'An unlock was requested.',
      delayShortRequested: (p) => `A shorter delay was requested: ${h(p)} hours.`,
      switchOffRequested: () => 'Switching protected mode off was requested.',
      signerAddRequested: (p) => `Adding the signer ${s(p.subject)} was requested.`,
      signerRemoveRequested: (p) => `Removing the signer ${s(p.subject)} was requested.`,
      allowlistAddRequested: (p) => `Adding ${s(p.subject)} to the payout allowlist was requested.`,
      recoveryRequested: (p) => `Setting ${s(p.subject)} as the recovery address was requested.`,
      recoveryCleared: (p) => `The recovery address ${s(p.subject)} was cleared.`,
      claimSettingRequested: (p) => `Switching the recovery claim on, or shortening its wait, was requested: a wait of ${h(p)} hours.`,
      readyTopUp: (p) => `A move of ${s(p.what)} from Protected to Ready was requested.`,
      idleLengthen: (p) => (p.hours === 0 ? 'Switching off the Ready idle period was requested.' : `A longer Ready idle period was requested: ${h(p)} hours.`),
    },
    at: (t) => `It takes effect at ${t} UTC.`,
    by: (b) => `Asked by ${b}.`,
    act: (link) => `If this was not you, lock the vault in the app now: ${link}`,
    pushTitle: 'Protected vault: security change',
  },
  es: {
    head: (w, c) => `Cambio de seguridad en la bóveda protegida de la cartera ${w} en la cadena ${c}.`,
    change: {
      unlockRequested: () => 'Se pidió un desbloqueo.',
      delayShortRequested: (p) => `Se pidió un retraso más corto: ${h(p)} horas.`,
      switchOffRequested: () => 'Se pidió desactivar el modo protegido.',
      signerAddRequested: (p) => `Se pidió añadir el firmante ${s(p.subject)}.`,
      signerRemoveRequested: (p) => `Se pidió quitar el firmante ${s(p.subject)}.`,
      allowlistAddRequested: (p) => `Se pidió añadir ${s(p.subject)} a la lista de destinos permitidos.`,
      recoveryRequested: (p) => `Se pidió fijar ${s(p.subject)} como dirección de recuperación.`,
      recoveryCleared: (p) => `Se quitó la dirección de recuperación ${s(p.subject)}.`,
      claimSettingRequested: (p) => `Se pidió activar la reclamación de recuperación o acortar su espera: una espera de ${h(p)} horas.`,
      readyTopUp: (p) => `Se pidió mover ${s(p.what)} de Protegido a Listo.`,
      idleLengthen: (p) => (p.hours === 0 ? 'Se pidió desactivar el periodo de inactividad de Listo.' : `Se pidió un periodo de inactividad de Listo más largo: ${h(p)} horas.`),
    },
    at: (t) => `Tiene efecto el ${t} UTC.`,
    by: (b) => `Lo pidió ${b}.`,
    act: (link) => `Si no fuiste tú, bloquea la bóveda en la app ahora: ${link}`,
    pushTitle: 'Bóveda protegida: cambio de seguridad',
  },
  fr: {
    head: (w, c) => `Changement de sécurité sur le coffre protégé du portefeuille ${w} sur la chaîne ${c}.`,
    change: {
      unlockRequested: () => 'Un déverrouillage a été demandé.',
      delayShortRequested: (p) => `Un délai plus court a été demandé : ${h(p)} heures.`,
      switchOffRequested: () => 'La désactivation du mode protégé a été demandée.',
      signerAddRequested: (p) => `L'ajout du signataire ${s(p.subject)} a été demandé.`,
      signerRemoveRequested: (p) => `Le retrait du signataire ${s(p.subject)} a été demandé.`,
      allowlistAddRequested: (p) => `L'ajout de ${s(p.subject)} à la liste des destinations autorisées a été demandé.`,
      recoveryRequested: (p) => `La définition de ${s(p.subject)} comme adresse de récupération a été demandée.`,
      recoveryCleared: (p) => `L'adresse de récupération ${s(p.subject)} a été supprimée.`,
      claimSettingRequested: (p) => `L'activation de la demande de récupération, ou le raccourcissement de son délai, a été demandé : un délai de ${h(p)} heures.`,
      readyTopUp: (p) => `Un transfert de ${s(p.what)} de Protégé vers Prêt a été demandé.`,
      idleLengthen: (p) => (p.hours === 0 ? "La désactivation de la période d'inactivité de Prêt a été demandée." : `Une période d'inactivité de Prêt plus longue a été demandée : ${h(p)} heures.`),
    },
    at: (t) => `Prend effet le ${t} UTC.`,
    by: (b) => `Demandé par ${b}.`,
    act: (link) => `Si ce n'était pas vous, verrouillez le coffre dans l'app maintenant : ${link}`,
    pushTitle: 'Coffre protégé : changement de sécurité',
  },
  de: {
    head: (w, c) => `Sicherheitsänderung am geschützten Tresor der Wallet ${w} auf Chain ${c}.`,
    change: {
      unlockRequested: () => 'Eine Entsperrung wurde beantragt.',
      delayShortRequested: (p) => `Eine kürzere Verzögerung wurde beantragt: ${h(p)} Stunden.`,
      switchOffRequested: () => 'Das Abschalten des geschützten Modus wurde beantragt.',
      signerAddRequested: (p) => `Das Hinzufügen des Unterzeichners ${s(p.subject)} wurde beantragt.`,
      signerRemoveRequested: (p) => `Das Entfernen des Unterzeichners ${s(p.subject)} wurde beantragt.`,
      allowlistAddRequested: (p) => `Das Hinzufügen von ${s(p.subject)} zur Liste erlaubter Ziele wurde beantragt.`,
      recoveryRequested: (p) => `${s(p.subject)} als Wiederherstellungsadresse festzulegen wurde beantragt.`,
      recoveryCleared: (p) => `Die Wiederherstellungsadresse ${s(p.subject)} wurde entfernt.`,
      claimSettingRequested: (p) => `Das Einschalten des Wiederherstellungsantrags oder das Verkürzen seiner Wartezeit wurde beantragt: eine Wartezeit von ${h(p)} Stunden.`,
      readyTopUp: (p) => `Eine Verschiebung von ${s(p.what)} von Geschützt nach Bereit wurde beantragt.`,
      idleLengthen: (p) => (p.hours === 0 ? 'Das Abschalten der Leerlaufzeit von Bereit wurde beantragt.' : `Eine längere Leerlaufzeit von Bereit wurde beantragt: ${h(p)} Stunden.`),
    },
    at: (t) => `Wirksam am ${t} UTC.`,
    by: (b) => `Beantragt von ${b}.`,
    act: (link) => `Wenn du das nicht warst, sperre den Tresor jetzt in der App: ${link}`,
    pushTitle: 'Geschützter Tresor: Sicherheitsänderung',
  },
  ja: {
    head: (w, c) => `チェーン ${c} のウォレット ${w} の保護ボールトでセキュリティの変更がありました。`,
    change: {
      unlockRequested: () => 'ロック解除が申請されました。',
      delayShortRequested: (p) => `より短い待機時間が申請されました：${h(p)} 時間。`,
      switchOffRequested: () => '保護モードのオフが申請されました。',
      signerAddRequested: (p) => `署名者 ${s(p.subject)} の追加が申請されました。`,
      signerRemoveRequested: (p) => `署名者 ${s(p.subject)} の削除が申請されました。`,
      allowlistAddRequested: (p) => `${s(p.subject)} を送金先許可リストに追加することが申請されました。`,
      recoveryRequested: (p) => `${s(p.subject)} をリカバリーアドレスに設定することが申請されました。`,
      recoveryCleared: (p) => `リカバリーアドレス ${s(p.subject)} が削除されました。`,
      claimSettingRequested: (p) => `リカバリー請求のオン、または待機期間の短縮が申請されました：待機期間 ${h(p)} 時間。`,
      readyTopUp: (p) => `${s(p.what)} を「保護」から「すぐ使える」へ移すことが申請されました。`,
      idleLengthen: (p) => (p.hours === 0 ? '「すぐ使える」の待機期間のオフが申請されました。' : `「すぐ使える」のより長い待機期間が申請されました：${h(p)} 時間。`),
    },
    at: (t) => `${t} UTC に有効になります。`,
    by: (b) => `申請者：${b}。`,
    act: (link) => `心当たりがない場合は、今すぐアプリでボールトをロックしてください：${link}`,
    pushTitle: '保護ボールト：セキュリティの変更',
  },
  zh: {
    head: (w, c) => `链 ${c} 上钱包 ${w} 的受保护金库发生了安全变更。`,
    change: {
      unlockRequested: () => '有人申请了解锁。',
      delayShortRequested: (p) => `有人申请了更短的延迟：${h(p)} 小时。`,
      switchOffRequested: () => '有人申请关闭受保护模式。',
      signerAddRequested: (p) => `有人申请添加签名人 ${s(p.subject)}。`,
      signerRemoveRequested: (p) => `有人申请移除签名人 ${s(p.subject)}。`,
      allowlistAddRequested: (p) => `有人申请将 ${s(p.subject)} 加入付款白名单。`,
      recoveryRequested: (p) => `有人申请将 ${s(p.subject)} 设为恢复地址。`,
      recoveryCleared: (p) => `恢复地址 ${s(p.subject)} 已被清除。`,
      claimSettingRequested: (p) => `有人申请开启恢复申请或缩短其等待期：等待期 ${h(p)} 小时。`,
      readyTopUp: (p) => `有人申请将 ${s(p.what)} 从“受保护”移至“就绪”。`,
      idleLengthen: (p) => (p.hours === 0 ? '有人申请关闭“就绪”的闲置期。' : `有人申请更长的“就绪”闲置期：${h(p)} 小时。`),
    },
    at: (t) => `于 ${t} UTC 生效。`,
    by: (b) => `申请人：${b}。`,
    act: (link) => `如果不是你本人操作，请立即在应用中锁定金库：${link}`,
    pushTitle: '受保护金库：安全变更',
  },
  ko: {
    head: (w, c) => `체인 ${c}의 지갑 ${w} 보호 금고에 보안 변경이 있습니다.`,
    change: {
      unlockRequested: () => '잠금 해제가 요청되었습니다.',
      delayShortRequested: (p) => `더 짧은 지연이 요청되었습니다: ${h(p)}시간.`,
      switchOffRequested: () => '보호 모드 끄기가 요청되었습니다.',
      signerAddRequested: (p) => `서명자 ${s(p.subject)} 추가가 요청되었습니다.`,
      signerRemoveRequested: (p) => `서명자 ${s(p.subject)} 제거가 요청되었습니다.`,
      allowlistAddRequested: (p) => `${s(p.subject)}를 지급 허용 목록에 추가하는 것이 요청되었습니다.`,
      recoveryRequested: (p) => `${s(p.subject)}를 복구 주소로 설정하는 것이 요청되었습니다.`,
      recoveryCleared: (p) => `복구 주소 ${s(p.subject)}가 지워졌습니다.`,
      claimSettingRequested: (p) => `복구 청구 켜기 또는 대기 기간 단축이 요청되었습니다: 대기 기간 ${h(p)}시간.`,
      readyTopUp: (p) => `${s(p.what)}를 보호에서 준비로 옮기는 것이 요청되었습니다.`,
      idleLengthen: (p) => (p.hours === 0 ? '준비 유휴 기간 끄기가 요청되었습니다.' : `더 긴 준비 유휴 기간이 요청되었습니다: ${h(p)}시간.`),
    },
    at: (t) => `${t} UTC에 적용됩니다.`,
    by: (b) => `요청자: ${b}.`,
    act: (link) => `본인이 아니라면 지금 앱에서 금고를 잠그세요: ${link}`,
    pushTitle: '보호 금고: 보안 변경',
  },
  hi: {
    head: (w, c) => `चेन ${c} पर वॉलेट ${w} की सुरक्षित वॉल्ट में सुरक्षा बदलाव।`,
    change: {
      unlockRequested: () => 'अनलॉक का अनुरोध किया गया।',
      delayShortRequested: (p) => `छोटी देरी का अनुरोध किया गया: ${h(p)} घंटे।`,
      switchOffRequested: () => 'सुरक्षित मोड बंद करने का अनुरोध किया गया।',
      signerAddRequested: (p) => `हस्ताक्षरकर्ता ${s(p.subject)} जोड़ने का अनुरोध किया गया।`,
      signerRemoveRequested: (p) => `हस्ताक्षरकर्ता ${s(p.subject)} हटाने का अनुरोध किया गया।`,
      allowlistAddRequested: (p) => `${s(p.subject)} को भुगतान अनुमति सूची में जोड़ने का अनुरोध किया गया।`,
      recoveryRequested: (p) => `${s(p.subject)} को रिकवरी पता बनाने का अनुरोध किया गया।`,
      recoveryCleared: (p) => `रिकवरी पता ${s(p.subject)} हटा दिया गया।`,
      claimSettingRequested: (p) => `रिकवरी दावा चालू करने या उसकी प्रतीक्षा छोटी करने का अनुरोध किया गया: ${h(p)} घंटे की प्रतीक्षा।`,
      readyTopUp: (p) => `${s(p.what)} को सुरक्षित से तैयार में ले जाने का अनुरोध किया गया।`,
      idleLengthen: (p) => (p.hours === 0 ? 'तैयार की निष्क्रिय अवधि बंद करने का अनुरोध किया गया।' : `तैयार की लंबी निष्क्रिय अवधि का अनुरोध किया गया: ${h(p)} घंटे।`),
    },
    at: (t) => `यह ${t} UTC पर लागू होगा।`,
    by: (b) => `अनुरोधकर्ता: ${b}।`,
    act: (link) => `अगर यह आपने नहीं किया, तो अभी ऐप में वॉल्ट लॉक करें: ${link}`,
    pushTitle: 'सुरक्षित वॉल्ट: सुरक्षा बदलाव',
  },
  ta: {
    head: (w, c) => `சங்கிலி ${c} இல் உள்ள வாலெட் ${w} இன் பாதுகாக்கப்பட்ட வால்டில் பாதுகாப்பு மாற்றம்.`,
    change: {
      unlockRequested: () => 'பூட்டுநீக்கம் கோரப்பட்டது.',
      delayShortRequested: (p) => `குறைவான தாமதம் கோரப்பட்டது: ${h(p)} மணிநேரம்.`,
      switchOffRequested: () => 'பாதுகாக்கப்பட்ட பயன்முறையை அணைக்கக் கோரப்பட்டது.',
      signerAddRequested: (p) => `கையொப்பமிடுபவர் ${s(p.subject)} ஐச் சேர்க்கக் கோரப்பட்டது.`,
      signerRemoveRequested: (p) => `கையொப்பமிடுபவர் ${s(p.subject)} ஐ நீக்கக் கோரப்பட்டது.`,
      allowlistAddRequested: (p) => `${s(p.subject)} ஐ செலுத்துதல் அனுமதிப் பட்டியலில் சேர்க்கக் கோரப்பட்டது.`,
      recoveryRequested: (p) => `${s(p.subject)} ஐ மீட்பு முகவரியாக அமைக்கக் கோரப்பட்டது.`,
      recoveryCleared: (p) => `மீட்பு முகவரி ${s(p.subject)} நீக்கப்பட்டது.`,
      claimSettingRequested: (p) => `மீட்பு கோரிக்கையை இயக்க அல்லது அதன் காத்திருப்பைக் குறைக்கக் கோரப்பட்டது: ${h(p)} மணிநேரக் காத்திருப்பு.`,
      readyTopUp: (p) => `${s(p.what)} ஐ பாதுகாக்கப்பட்டதிலிருந்து தயார் நிலைக்கு நகர்த்தக் கோரப்பட்டது.`,
      idleLengthen: (p) => (p.hours === 0 ? 'தயார் நிலையின் செயலற்ற காலத்தை அணைக்கக் கோரப்பட்டது.' : `தயார் நிலையின் நீண்ட செயலற்ற காலம் கோரப்பட்டது: ${h(p)} மணிநேரம்.`),
    },
    at: (t) => `இது ${t} UTC அன்று நடைமுறைக்கு வரும்.`,
    by: (b) => `கோரியது: ${b}.`,
    act: (link) => `இது நீங்கள் இல்லை என்றால், இப்போதே செயலியில் வால்டைப் பூட்டுங்கள்: ${link}`,
    pushTitle: 'பாதுகாக்கப்பட்ட வால்ட்: பாதுகாப்பு மாற்றம்',
  },
  ar: {
    head: (w, c) => `تغيير أمني على الخزنة المحمية للمحفظة ${w} على السلسلة ${c}.`,
    change: {
      unlockRequested: () => 'طُلب فتح القفل.',
      delayShortRequested: (p) => `طُلبت مهلة أقصر: ${h(p)} ساعة.`,
      switchOffRequested: () => 'طُلب إيقاف الوضع المحمي.',
      signerAddRequested: (p) => `طُلبت إضافة الموقّع ${s(p.subject)}.`,
      signerRemoveRequested: (p) => `طُلبت إزالة الموقّع ${s(p.subject)}.`,
      allowlistAddRequested: (p) => `طُلبت إضافة ${s(p.subject)} إلى قائمة وجهات الدفع المسموح بها.`,
      recoveryRequested: (p) => `طُلب تعيين ${s(p.subject)} عنوانًا للاسترداد.`,
      recoveryCleared: (p) => `أُزيل عنوان الاسترداد ${s(p.subject)}.`,
      claimSettingRequested: (p) => `طُلب تشغيل طلب الاسترداد أو تقصير مدة انتظاره: انتظار ${h(p)} ساعة.`,
      readyTopUp: (p) => `طُلب نقل ${s(p.what)} من المحمي إلى الجاهز.`,
      idleLengthen: (p) => (p.hours === 0 ? 'طُلب إيقاف فترة خمول الجاهز.' : `طُلبت فترة خمول أطول للجاهز: ${h(p)} ساعة.`),
    },
    at: (t) => `يسري في ${t} UTC.`,
    by: (b) => `طلبه ${b}.`,
    act: (link) => `إن لم تكن أنت، فاقفل الخزنة في التطبيق الآن: ${link}`,
    pushTitle: 'الخزنة المحمية: تغيير أمني',
  },
};

export function securityChangeText(
  locale: string | null | undefined,
  change: SecurityChange,
  w: string,
  c: number,
  p: SecurityParts,
  link: string,
): { text: string; title: string } {
  const k = COPY[resolve(locale)];
  const parts = [k.head(w, c), k.change[change](p)];
  if (p.at !== null) parts.push(k.at(p.at));
  if (p.by !== null) parts.push(k.by(p.by));
  parts.push(k.act(link));
  return { text: parts.join(' '), title: k.pushTitle };
}
