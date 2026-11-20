// packages/lib/src/telegramAlerts/recoveryClaimCopy.ts
//
// #3756 — what the owner and every signer of a protected account hear about
// a recovery claim (RecoveryClaimDesign 4.6): the request, the reminders at
// the half-way point, seven days and one day before the claim may run, and
// how the claim ended (cancelled, dropped and why, lapsed, or run).
//
// Every message says what the chain shows. A claim is announced with the
// times the vault recorded, which never move; an end the keeper could not
// read the reason for says so instead of naming one.
//
// One catalogue per locale, falling back to English, like `termsCopy.ts`.

import { SUPPORTED_LOCALES, type Locale } from './hfCopy';

/** The four announcements of an open claim, in the order they fall due. */
export const CLAIM_STAGES = ['requested', 'halfway', 'week', 'day'] as const;
export type ClaimStage = (typeof CLAIM_STAGES)[number];

/** How a claim ended. The first seven are the vault's own reasons
 *  (`RecoveryClaimEnded`; its clawback reason reads as `recovered`);
 *  `recovered` is the claim run (or the account recovered while it was
 *  open), `lapsed` a claim nobody ran in time, `cancelledOrDropped` an end
 *  that started the pause but whose reason could not be read, and `unknown`
 *  an end the keeper could not tell apart at all. */
export const CLAIM_ENDS = [
  'cancelled',
  'ownerCall',
  'switchedOff',
  'locked',
  'replaced',
  'protectionOff',
  'recoveryChanged',
  'recovered',
  'lapsed',
  'cancelledOrDropped',
  'unknown',
] as const;
export type ClaimEnd = (typeof CLAIM_ENDS)[number];

function resolve(s: string | null | undefined): Locale {
  return s && (SUPPORTED_LOCALES as readonly string[]).includes(s) ? (s as Locale) : 'en';
}

interface Copy {
  lead: Record<ClaimStage, string>;
  /** `w` the wallet (shortened), `c` the chain id, `r` the recovery address,
   *  `asked` / `runAt` / `lapseAt` UTC times, `link` the app. */
  open: (w: string, c: number, r: string, asked: string, runAt: string, lapseAt: string, link: string) => string;
  /** The end, as one sentence; `by` the key that cancelled (null: not named). */
  end: Record<ClaimEnd, (by: string | null) => string>;
  /** The head of an end message. */
  ended: (w: string, c: number) => string;
  /** The pause on a new request, until `t` UTC. */
  pause: (t: string) => string;
  more: (link: string) => string;
  pushTitle: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    lead: {
      requested: 'New recovery claim.',
      halfway: 'Reminder: half of the wait has passed.',
      week: 'Reminder: 7 days left.',
      day: 'Reminder: 1 day left.',
    },
    open: (w, c, r, asked, runAt, lapseAt, link) =>
      `A recovery claim is open on the protected vault of wallet ${w} on chain ${c}. Its recovery address ${r} asked for the account on ${asked} UTC. From ${runAt} UTC until ${lapseAt} UTC it can take the account over. If you did not expect this, cancel the claim in the app now with the owner key or a signer key: ${link}`,
    end: {
      cancelled: (by) => (by ? `It was cancelled by ${by}.` : 'It was cancelled.'),
      ownerCall: () => 'It was dropped because the owner key acted on the account directly.',
      switchedOff: () => 'It was dropped because the recovery claim setting was switched off.',
      locked: () => 'It was dropped because the account was locked.',
      replaced: () => 'It was dropped because the primary wallet was replaced.',
      protectionOff: () => 'It was dropped because protected mode was switched off.',
      recoveryChanged: () => 'It was dropped because a new recovery address came into force. That address may ask for its own claim, which waits the full wait.',
      recovered: () => 'The recovery address recovered the account.',
      lapsed: () => 'It lapsed without being run. Nothing changed.',
      cancelledOrDropped: () => 'It was cancelled or dropped. The reason could not be read.',
      unknown: () => 'It is no longer open. How it ended could not be read.',
    },
    ended: (w, c) => `The recovery claim on the protected vault of wallet ${w} on chain ${c} has ended.`,
    pause: (t) => `No new claim can be asked before ${t} UTC.`,
    more: (link) => `Details in the app: ${link}`,
    pushTitle: 'Recovery claim',
  },
  es: {
    lead: {
      requested: 'Nueva reclamación de recuperación.',
      halfway: 'Recordatorio: ha pasado la mitad de la espera.',
      week: 'Recordatorio: quedan 7 días.',
      day: 'Recordatorio: queda 1 día.',
    },
    open: (w, c, r, asked, runAt, lapseAt, link) =>
      `Hay una reclamación de recuperación abierta sobre la bóveda protegida de la cartera ${w} en la cadena ${c}. Su dirección de recuperación ${r} pidió la cuenta el ${asked} UTC. Desde el ${runAt} UTC hasta el ${lapseAt} UTC puede tomar el control de la cuenta. Si no lo esperabas, cancela la reclamación ahora en la app con la clave del propietario o la de un firmante: ${link}`,
    end: {
      cancelled: (by) => (by ? `La canceló ${by}.` : 'Se canceló.'),
      ownerCall: () => 'Se anuló porque la clave del propietario actuó directamente sobre la cuenta.',
      switchedOff: () => 'Se anuló porque se desactivó la opción de reclamación de recuperación.',
      locked: () => 'Se anuló porque la cuenta se bloqueó.',
      replaced: () => 'Se anuló porque se sustituyó la cartera principal.',
      protectionOff: () => 'Se anuló porque se desactivó el modo protegido.',
      recoveryChanged: () => 'Se anuló porque entró en vigor una nueva dirección de recuperación. Esa dirección puede pedir su propia reclamación, que espera el plazo completo.',
      recovered: () => 'La dirección de recuperación recuperó la cuenta.',
      lapsed: () => 'Caducó sin ejecutarse. No cambió nada.',
      cancelledOrDropped: () => 'Se canceló o se anuló. No se pudo leer el motivo.',
      unknown: () => 'Ya no está abierta. No se pudo saber cómo terminó.',
    },
    ended: (w, c) => `La reclamación de recuperación sobre la bóveda protegida de la cartera ${w} en la cadena ${c} ha terminado.`,
    pause: (t) => `No se puede pedir una nueva reclamación antes del ${t} UTC.`,
    more: (link) => `Detalles en la app: ${link}`,
    pushTitle: 'Reclamación de recuperación',
  },
  fr: {
    lead: {
      requested: 'Nouvelle demande de récupération.',
      halfway: 'Rappel : la moitié du délai est écoulée.',
      week: 'Rappel : il reste 7 jours.',
      day: 'Rappel : il reste 1 jour.',
    },
    open: (w, c, r, asked, runAt, lapseAt, link) =>
      `Une demande de récupération est ouverte sur le coffre protégé du portefeuille ${w} sur la chaîne ${c}. Son adresse de récupération ${r} a demandé le compte le ${asked} UTC. Du ${runAt} UTC au ${lapseAt} UTC, elle peut prendre le contrôle du compte. Si vous ne l'attendiez pas, annulez la demande dans l'app maintenant avec la clé du propriétaire ou celle d'un signataire : ${link}`,
    end: {
      cancelled: (by) => (by ? `Elle a été annulée par ${by}.` : 'Elle a été annulée.'),
      ownerCall: () => 'Elle a été abandonnée car la clé du propriétaire a agi directement sur le compte.',
      switchedOff: () => 'Elle a été abandonnée car le réglage de demande de récupération a été désactivé.',
      locked: () => 'Elle a été abandonnée car le compte a été verrouillé.',
      replaced: () => 'Elle a été abandonnée car le portefeuille principal a été remplacé.',
      protectionOff: () => 'Elle a été abandonnée car le mode protégé a été désactivé.',
      recoveryChanged: () => "Elle a été abandonnée car une nouvelle adresse de récupération est entrée en vigueur. Cette adresse peut faire sa propre demande, qui attend le délai complet.",
      recovered: () => "L'adresse de récupération a récupéré le compte.",
      lapsed: () => "Elle a expiré sans être exécutée. Rien n'a changé.",
      cancelledOrDropped: () => "Elle a été annulée ou abandonnée. Le motif n'a pas pu être lu.",
      unknown: () => "Elle n'est plus ouverte. La façon dont elle s'est terminée n'a pas pu être lue.",
    },
    ended: (w, c) => `La demande de récupération sur le coffre protégé du portefeuille ${w} sur la chaîne ${c} est terminée.`,
    pause: (t) => `Aucune nouvelle demande ne peut être faite avant le ${t} UTC.`,
    more: (link) => `Détails dans l'app : ${link}`,
    pushTitle: 'Demande de récupération',
  },
  de: {
    lead: {
      requested: 'Neuer Wiederherstellungsantrag.',
      halfway: 'Erinnerung: Die Hälfte der Wartezeit ist vorbei.',
      week: 'Erinnerung: noch 7 Tage.',
      day: 'Erinnerung: noch 1 Tag.',
    },
    open: (w, c, r, asked, runAt, lapseAt, link) =>
      `Für den geschützten Tresor der Wallet ${w} auf Chain ${c} ist ein Wiederherstellungsantrag offen. Ihre Wiederherstellungsadresse ${r} hat das Konto am ${asked} UTC beantragt. Vom ${runAt} UTC bis zum ${lapseAt} UTC kann sie das Konto übernehmen. Wenn du das nicht erwartet hast, brich den Antrag jetzt in der App mit dem Eigentümerschlüssel oder einem Unterzeichnerschlüssel ab: ${link}`,
    end: {
      cancelled: (by) => (by ? `Er wurde von ${by} abgebrochen.` : 'Er wurde abgebrochen.'),
      ownerCall: () => 'Er ist entfallen, weil der Eigentümerschlüssel direkt auf dem Konto gehandelt hat.',
      switchedOff: () => 'Er ist entfallen, weil die Einstellung für Wiederherstellungsanträge abgeschaltet wurde.',
      locked: () => 'Er ist entfallen, weil das Konto gesperrt wurde.',
      replaced: () => 'Er ist entfallen, weil die primäre Wallet ersetzt wurde.',
      protectionOff: () => 'Er ist entfallen, weil der geschützte Modus abgeschaltet wurde.',
      recoveryChanged: () => 'Er ist entfallen, weil eine neue Wiederherstellungsadresse in Kraft getreten ist. Diese Adresse kann einen eigenen Antrag stellen, der die volle Wartezeit abwartet.',
      recovered: () => 'Die Wiederherstellungsadresse hat das Konto wiederhergestellt.',
      lapsed: () => 'Er ist abgelaufen, ohne ausgeführt zu werden. Nichts hat sich geändert.',
      cancelledOrDropped: () => 'Er wurde abgebrochen oder ist entfallen. Der Grund konnte nicht gelesen werden.',
      unknown: () => 'Er ist nicht mehr offen. Wie er geendet hat, konnte nicht gelesen werden.',
    },
    ended: (w, c) => `Der Wiederherstellungsantrag für den geschützten Tresor der Wallet ${w} auf Chain ${c} ist beendet.`,
    pause: (t) => `Vor dem ${t} UTC kann kein neuer Antrag gestellt werden.`,
    more: (link) => `Details in der App: ${link}`,
    pushTitle: 'Wiederherstellungsantrag',
  },
  ja: {
    lead: {
      requested: '新しいリカバリー請求です。',
      halfway: 'リマインダー：待機期間の半分が過ぎました。',
      week: 'リマインダー：残り7日です。',
      day: 'リマインダー：残り1日です。',
    },
    open: (w, c, r, asked, runAt, lapseAt, link) =>
      `チェーン ${c} のウォレット ${w} の保護ボールトに、リカバリー請求が出ています。リカバリーアドレス ${r} が ${asked} UTC にアカウントを請求しました。${runAt} UTC から ${lapseAt} UTC まで、このアドレスはアカウントを引き継ぐことができます。心当たりがない場合は、今すぐアプリでオーナーキーまたは署名者キーを使って請求を取り消してください：${link}`,
    end: {
      cancelled: (by) => (by ? `${by} によって取り消されました。` : '取り消されました。'),
      ownerCall: () => 'オーナーキーがアカウントを直接操作したため、取り下げられました。',
      switchedOff: () => 'リカバリー請求の設定がオフにされたため、取り下げられました。',
      locked: () => 'アカウントがロックされたため、取り下げられました。',
      replaced: () => 'プライマリーウォレットが置き換えられたため、取り下げられました。',
      protectionOff: () => '保護モードがオフにされたため、取り下げられました。',
      recoveryChanged: () => '新しいリカバリーアドレスが有効になったため、取り下げられました。そのアドレスは自身の請求を出すことができ、その請求は待機期間を最初から待ちます。',
      recovered: () => 'リカバリーアドレスがアカウントを回復しました。',
      lapsed: () => '実行されないまま失効しました。何も変わっていません。',
      cancelledOrDropped: () => '取り消されたか、取り下げられました。理由は読み取れませんでした。',
      unknown: () => 'すでに請求は出ていません。どのように終わったかは読み取れませんでした。',
    },
    ended: (w, c) => `チェーン ${c} のウォレット ${w} の保護ボールトへのリカバリー請求は終了しました。`,
    pause: (t) => `${t} UTC より前に新しい請求を出すことはできません。`,
    more: (link) => `詳細はアプリで：${link}`,
    pushTitle: 'リカバリー請求',
  },
  zh: {
    lead: {
      requested: '新的恢复申请。',
      halfway: '提醒：等待期已过一半。',
      week: '提醒：还剩 7 天。',
      day: '提醒：还剩 1 天。',
    },
    open: (w, c, r, asked, runAt, lapseAt, link) =>
      `链 ${c} 上钱包 ${w} 的受保护金库有一项未结的恢复申请。其恢复地址 ${r} 于 ${asked} UTC 申请了该账户。从 ${runAt} UTC 到 ${lapseAt} UTC，该地址可以接管账户。如果这不在你的预料之中，请立即在应用中用所有者密钥或签名人密钥取消申请：${link}`,
    end: {
      cancelled: (by) => (by ? `已被 ${by} 取消。` : '已被取消。'),
      ownerCall: () => '因所有者密钥直接操作了账户，申请已作废。',
      switchedOff: () => '因恢复申请设置被关闭，申请已作废。',
      locked: () => '因账户被锁定，申请已作废。',
      replaced: () => '因主钱包被替换，申请已作废。',
      protectionOff: () => '因受保护模式被关闭，申请已作废。',
      recoveryChanged: () => '因新的恢复地址已生效，申请已作废。该地址可以提出自己的申请，并需等待完整的等待期。',
      recovered: () => '恢复地址已恢复该账户。',
      lapsed: () => '申请未被执行而失效。没有任何变化。',
      cancelledOrDropped: () => '申请已被取消或作废。无法读取原因。',
      unknown: () => '申请已不再未结。无法读取其结束方式。',
    },
    ended: (w, c) => `链 ${c} 上钱包 ${w} 的受保护金库的恢复申请已结束。`,
    pause: (t) => `在 ${t} UTC 之前不能提出新的申请。`,
    more: (link) => `应用中查看详情：${link}`,
    pushTitle: '恢复申请',
  },
  ko: {
    lead: {
      requested: '새 복구 청구입니다.',
      halfway: '알림: 대기 기간의 절반이 지났습니다.',
      week: '알림: 7일 남았습니다.',
      day: '알림: 1일 남았습니다.',
    },
    open: (w, c, r, asked, runAt, lapseAt, link) =>
      `체인 ${c}의 지갑 ${w} 보호 금고에 복구 청구가 열려 있습니다. 복구 주소 ${r}가 ${asked} UTC에 계정을 청구했습니다. ${runAt} UTC부터 ${lapseAt} UTC까지 이 주소가 계정을 넘겨받을 수 있습니다. 예상하지 못한 일이라면 지금 앱에서 소유자 키나 서명자 키로 청구를 취소하세요: ${link}`,
    end: {
      cancelled: (by) => (by ? `${by}가 취소했습니다.` : '취소되었습니다.'),
      ownerCall: () => '소유자 키가 계정에서 직접 작업했기 때문에 무효가 되었습니다.',
      switchedOff: () => '복구 청구 설정이 꺼졌기 때문에 무효가 되었습니다.',
      locked: () => '계정이 잠겼기 때문에 무효가 되었습니다.',
      replaced: () => '기본 지갑이 교체되었기 때문에 무효가 되었습니다.',
      protectionOff: () => '보호 모드가 꺼졌기 때문에 무효가 되었습니다.',
      recoveryChanged: () => '새 복구 주소가 효력을 얻었기 때문에 무효가 되었습니다. 그 주소는 자신의 청구를 할 수 있으며, 그 청구는 대기 기간 전체를 기다립니다.',
      recovered: () => '복구 주소가 계정을 복구했습니다.',
      lapsed: () => '실행되지 않고 만료되었습니다. 아무것도 바뀌지 않았습니다.',
      cancelledOrDropped: () => '취소되었거나 무효가 되었습니다. 이유를 읽을 수 없었습니다.',
      unknown: () => '더 이상 열려 있지 않습니다. 어떻게 끝났는지 읽을 수 없었습니다.',
    },
    ended: (w, c) => `체인 ${c}의 지갑 ${w} 보호 금고에 대한 복구 청구가 끝났습니다.`,
    pause: (t) => `${t} UTC 전에는 새 청구를 할 수 없습니다.`,
    more: (link) => `앱에서 자세히 보기: ${link}`,
    pushTitle: '복구 청구',
  },
  hi: {
    lead: {
      requested: 'नया रिकवरी दावा।',
      halfway: 'याद दिलाना: प्रतीक्षा का आधा समय बीत गया है।',
      week: 'याद दिलाना: 7 दिन बचे हैं।',
      day: 'याद दिलाना: 1 दिन बचा है।',
    },
    open: (w, c, r, asked, runAt, lapseAt, link) =>
      `चेन ${c} पर वॉलेट ${w} की सुरक्षित वॉल्ट पर एक रिकवरी दावा खुला है। इसके रिकवरी पते ${r} ने ${asked} UTC पर खाते के लिए अनुरोध किया। ${runAt} UTC से ${lapseAt} UTC तक यह पता खाते को अपने हाथ में ले सकता है। अगर आपको इसकी उम्मीद नहीं थी, तो अभी ऐप में मालिक की कुंजी या किसी हस्ताक्षरकर्ता की कुंजी से दावा रद्द करें: ${link}`,
    end: {
      cancelled: (by) => (by ? `इसे ${by} ने रद्द किया।` : 'इसे रद्द कर दिया गया।'),
      ownerCall: () => 'यह छोड़ दिया गया, क्योंकि मालिक की कुंजी ने खाते पर सीधे काम किया।',
      switchedOff: () => 'यह छोड़ दिया गया, क्योंकि रिकवरी दावे की सेटिंग बंद कर दी गई।',
      locked: () => 'यह छोड़ दिया गया, क्योंकि खाता लॉक कर दिया गया।',
      replaced: () => 'यह छोड़ दिया गया, क्योंकि मुख्य वॉलेट बदल दिया गया।',
      protectionOff: () => 'यह छोड़ दिया गया, क्योंकि सुरक्षित मोड बंद कर दिया गया।',
      recoveryChanged: () => 'यह छोड़ दिया गया, क्योंकि एक नया रिकवरी पता लागू हो गया। वह पता अपना दावा कर सकता है, जो पूरी प्रतीक्षा करता है।',
      recovered: () => 'रिकवरी पते ने खाता वापस ले लिया।',
      lapsed: () => 'यह चलाए बिना समाप्त हो गया। कुछ नहीं बदला।',
      cancelledOrDropped: () => 'इसे रद्द किया गया या छोड़ दिया गया। कारण पढ़ा नहीं जा सका।',
      unknown: () => 'यह अब खुला नहीं है। यह कैसे समाप्त हुआ, यह पढ़ा नहीं जा सका।',
    },
    ended: (w, c) => `चेन ${c} पर वॉलेट ${w} की सुरक्षित वॉल्ट पर रिकवरी दावा समाप्त हो गया है।`,
    pause: (t) => `${t} UTC से पहले कोई नया दावा नहीं किया जा सकता।`,
    more: (link) => `ऐप में विवरण: ${link}`,
    pushTitle: 'रिकवरी दावा',
  },
  ta: {
    lead: {
      requested: 'புதிய மீட்பு கோரிக்கை.',
      halfway: 'நினைவூட்டல்: காத்திருப்பில் பாதி கடந்துவிட்டது.',
      week: 'நினைவூட்டல்: 7 நாட்கள் உள்ளன.',
      day: 'நினைவூட்டல்: 1 நாள் உள்ளது.',
    },
    open: (w, c, r, asked, runAt, lapseAt, link) =>
      `சங்கிலி ${c} இல் உள்ள வாலெட் ${w} இன் பாதுகாக்கப்பட்ட வால்டில் ஒரு மீட்பு கோரிக்கை திறந்துள்ளது. அதன் மீட்பு முகவரி ${r} ${asked} UTC அன்று கணக்கைக் கோரியது. ${runAt} UTC முதல் ${lapseAt} UTC வரை அது கணக்கைக் கைப்பற்றலாம். இது நீங்கள் எதிர்பார்க்காதது என்றால், இப்போதே செயலியில் உரிமையாளர் விசை அல்லது கையொப்பமிடுபவர் விசையால் கோரிக்கையை ரத்துசெய்யுங்கள்: ${link}`,
    end: {
      cancelled: (by) => (by ? `${by} அதை ரத்துசெய்தது.` : 'அது ரத்துசெய்யப்பட்டது.'),
      ownerCall: () => 'உரிமையாளர் விசை கணக்கில் நேரடியாகச் செயல்பட்டதால் அது கைவிடப்பட்டது.',
      switchedOff: () => 'மீட்பு கோரிக்கை அமைப்பு அணைக்கப்பட்டதால் அது கைவிடப்பட்டது.',
      locked: () => 'கணக்கு பூட்டப்பட்டதால் அது கைவிடப்பட்டது.',
      replaced: () => 'முதன்மை வாலெட் மாற்றப்பட்டதால் அது கைவிடப்பட்டது.',
      protectionOff: () => 'பாதுகாக்கப்பட்ட பயன்முறை அணைக்கப்பட்டதால் அது கைவிடப்பட்டது.',
      recoveryChanged: () => 'புதிய மீட்பு முகவரி நடைமுறைக்கு வந்ததால் அது கைவிடப்பட்டது. அந்த முகவரி தன் சொந்தக் கோரிக்கையை வைக்கலாம்; அது முழுக் காத்திருப்பையும் காத்திருக்கும்.',
      recovered: () => 'மீட்பு முகவரி கணக்கை மீட்டெடுத்தது.',
      lapsed: () => 'அது இயக்கப்படாமலேயே காலாவதியானது. எதுவும் மாறவில்லை.',
      cancelledOrDropped: () => 'அது ரத்துசெய்யப்பட்டது அல்லது கைவிடப்பட்டது. காரணத்தைப் படிக்க முடியவில்லை.',
      unknown: () => 'அது இனி திறந்திருக்கவில்லை. அது எப்படி முடிந்தது என்பதைப் படிக்க முடியவில்லை.',
    },
    ended: (w, c) => `சங்கிலி ${c} இல் உள்ள வாலெட் ${w} இன் பாதுகாக்கப்பட்ட வால்ட் மீதான மீட்பு கோரிக்கை முடிந்தது.`,
    pause: (t) => `${t} UTC க்கு முன் புதிய கோரிக்கை வைக்க முடியாது.`,
    more: (link) => `செயலியில் விவரங்கள்: ${link}`,
    pushTitle: 'மீட்பு கோரிக்கை',
  },
  ar: {
    lead: {
      requested: 'طلب استرداد جديد.',
      halfway: 'تذكير: مضى نصف مدة الانتظار.',
      week: 'تذكير: بقيت 7 أيام.',
      day: 'تذكير: بقي يوم واحد.',
    },
    open: (w, c, r, asked, runAt, lapseAt, link) =>
      `يوجد طلب استرداد مفتوح على الخزنة المحمية للمحفظة ${w} على السلسلة ${c}. طلب عنوان الاسترداد ${r} الحساب في ${asked} UTC. من ${runAt} UTC حتى ${lapseAt} UTC يمكنه تولي الحساب. إن لم تكن تتوقع ذلك، فألغِ الطلب الآن في التطبيق بمفتاح المالك أو بمفتاح أحد الموقّعين: ${link}`,
    end: {
      cancelled: (by) => (by ? `ألغاه ${by}.` : 'أُلغي.'),
      ownerCall: () => 'سقط لأن مفتاح المالك تصرف في الحساب مباشرة.',
      switchedOff: () => 'سقط لأن إعداد طلب الاسترداد أُوقف.',
      locked: () => 'سقط لأن الحساب قُفل.',
      replaced: () => 'سقط لأن المحفظة الأساسية استُبدلت.',
      protectionOff: () => 'سقط لأن الوضع المحمي أُوقف.',
      recoveryChanged: () => 'سقط لأن عنوان استرداد جديدًا أصبح نافذًا. يمكن لهذا العنوان أن يقدم طلبه الخاص، الذي ينتظر المدة كاملة.',
      recovered: () => 'استرد عنوان الاسترداد الحساب.',
      lapsed: () => 'انتهت صلاحيته دون تنفيذ. لم يتغير شيء.',
      cancelledOrDropped: () => 'أُلغي أو سقط. تعذرت قراءة السبب.',
      unknown: () => 'لم يعد مفتوحًا. تعذرت قراءة كيف انتهى.',
    },
    ended: (w, c) => `انتهى طلب الاسترداد على الخزنة المحمية للمحفظة ${w} على السلسلة ${c}.`,
    pause: (t) => `لا يمكن تقديم طلب جديد قبل ${t} UTC.`,
    more: (link) => `التفاصيل في التطبيق: ${link}`,
    pushTitle: 'طلب استرداد',
  },
};

/** An open claim's announcement at `stage`. */
export function recoveryClaimOpenText(
  locale: string | null | undefined,
  stage: ClaimStage,
  w: string,
  c: number,
  recovery: string,
  asked: string,
  runAt: string,
  lapseAt: string,
  link: string,
): { text: string; title: string } {
  const k = COPY[resolve(locale)];
  return { text: `${k.lead[stage]} ${k.open(w, c, recovery, asked, runAt, lapseAt, link)}`, title: k.pushTitle };
}

/** A claim's end; `pauseUntil` the UTC time no new claim may be asked
 *  before, null when none is in force. */
export function recoveryClaimEndedText(
  locale: string | null | undefined,
  end: ClaimEnd,
  by: string | null,
  w: string,
  c: number,
  pauseUntil: string | null,
  link: string,
): { text: string; title: string } {
  const k = COPY[resolve(locale)];
  const parts = [k.ended(w, c), k.end[end](by)];
  if (pauseUntil !== null) parts.push(k.pause(pauseUntil));
  parts.push(k.more(link));
  return { text: parts.join(' '), title: k.pushTitle };
}
