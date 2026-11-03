// apps/keeper/src/protectedCopy.ts
//
// #3088 — what the protected account pass says to an owner on Telegram and
// Push: the answer to a LOCK the owner sent, and the alerts on a lock, a
// queued payout and a proposed replacement of the primary wallet. One
// catalogue per locale, falling back to English, like `i18n.ts`; kept apart
// from it so that file stays the HF watcher's.
//
// Every message says what the chain shows and nothing more: a LOCK answer
// names the outcome the keeper saw, never "locked" before the lock landed,
// and an alert names the figures from the event and the chain, with the raw
// amount when the token's decimals could not be read.

import { SUPPORTED_LOCALES, type Locale } from './i18n';

function resolve(s: string | null | undefined): Locale {
  return s && (SUPPORTED_LOCALES as readonly string[]).includes(s) ? (s as Locale) : 'en';
}

/** `w`: the wallet, shortened; `c`: the chain id. */
type Copy = {
  lockDone: (w: string, c: number) => string;
  /** Locked since the request was made: nothing to do. */
  lockAlready: (w: string, c: number) => string;
  /** Locked before the request: locked again, which drops what was asked since. */
  lockAgain: (w: string, c: number) => string;
  lockNotProtected: (w: string, c: number) => string;
  lockNotAllowed: (w: string, c: number) => string;
  lockRefused: (w: string, c: number, reason: string) => string;
  lockExpired: (w: string, c: number) => string;
  alertLockedByOwner: (w: string, c: number) => string;
  alertLockedBy: (w: string, c: number, by: string) => string;
  /** `what`: the asset and amount; `when`: the release time, UTC. */
  alertPayout: (w: string, c: number, what: string, to: string, when: string, code: string) => string;
  alertReplacement: (w: string, c: number, nominee: string, by: string) => string;
  pushTitle: string;
};

const COPY: Record<Locale, Copy> = {
  en: {
    lockDone: (w, c) => `Locked: the protected vault of wallet ${w} on chain ${c} is now locked. Every queued payout and position transfer was cancelled, and nothing new can be queued. Unlocking takes your full delay and is requested from the app.`,
    lockAlready: (w, c) => `Wallet ${w} on chain ${c} was already locked. Nothing changed.`,
    lockAgain: (w, c) => `Wallet ${w} on chain ${c} was already locked. The lock was set again, which cancels any pending unlock or other loosening change.`,
    lockNotProtected: (w, c) => `Wallet ${w} on chain ${c} does not have protected mode on, so there is no vault lock to set. Nothing was locked.`,
    lockNotAllowed: (w, c) => `Wallet ${w} on chain ${c} was not locked: you have not allowed the keeper to lock your vault. Grant the lock permission in the app, or lock the vault from the app now.`,
    lockRefused: (w, c, r) => `Wallet ${w} on chain ${c} was not locked: the protocol refused the call (${r}). Lock the vault from the app.`,
    lockExpired: (w, c) => `Your LOCK for wallet ${w} on chain ${c} was not acted on within an hour, so it was dropped and nothing was locked. Send LOCK again if you still want the vault locked.`,
    alertLockedByOwner: (w, c) => `The protected vault of wallet ${w} on chain ${c} was locked by its owner (from the app, or by the keeper on your LOCK). Every queued payout and position transfer was cancelled.`,
    alertLockedBy: (w, c, by) => `The protected vault of wallet ${w} on chain ${c} was locked by ${by}, one of its signers. Every queued payout and position transfer was cancelled. If you did not expect this, check your signers in the app.`,
    alertPayout: (w, c, what, to, when, code) => `A payout from the protected vault of wallet ${w} on chain ${c} was queued: ${what} to ${to}, released no earlier than ${when} UTC. Request code ${code}; the app shows the same code for this payout. If you did not ask for it, cancel it in the app or send LOCK.`,
    alertReplacement: (w, c, n, by) => `A replacement of the primary wallet ${w} on chain ${c} was proposed by ${by}, naming ${n} as the new primary. If you did not ask for it, cancel it in the app.`,
    pushTitle: 'Vaipakam protected vault',
  },
  es: {
    lockDone: (w, c) => `Bloqueada: la bóveda protegida de la billetera ${w} en la cadena ${c} ya está bloqueada. Se cancelaron todos los pagos y transferencias de posiciones en cola, y no se puede poner nada nuevo en cola. Desbloquearla tarda todo tu plazo y se solicita desde la app.`,
    lockAlready: (w, c) => `La billetera ${w} en la cadena ${c} ya estaba bloqueada. No cambió nada.`,
    lockAgain: (w, c) => `La billetera ${w} en la cadena ${c} ya estaba bloqueada. El bloqueo se aplicó de nuevo, lo que cancela cualquier desbloqueo pendiente u otro cambio que relaje la protección.`,
    lockNotProtected: (w, c) => `La billetera ${w} en la cadena ${c} no tiene el modo protegido activado, así que no hay bloqueo de bóveda que aplicar. No se bloqueó nada.`,
    lockNotAllowed: (w, c) => `La billetera ${w} en la cadena ${c} no se bloqueó: no has permitido al keeper bloquear tu bóveda. Concede el permiso de bloqueo en la app o bloquea la bóveda desde la app ahora.`,
    lockRefused: (w, c, r) => `La billetera ${w} en la cadena ${c} no se bloqueó: el protocolo rechazó la llamada (${r}). Bloquea la bóveda desde la app.`,
    lockExpired: (w, c) => `Tu LOCK para la billetera ${w} en la cadena ${c} no se atendió en una hora, así que se descartó y no se bloqueó nada. Envía LOCK de nuevo si aún quieres bloquear la bóveda.`,
    alertLockedByOwner: (w, c) => `La bóveda protegida de la billetera ${w} en la cadena ${c} fue bloqueada por su propietario (desde la app, o por el keeper tras tu LOCK). Se cancelaron todos los pagos y transferencias de posiciones en cola.`,
    alertLockedBy: (w, c, by) => `La bóveda protegida de la billetera ${w} en la cadena ${c} fue bloqueada por ${by}, uno de sus firmantes. Se cancelaron todos los pagos y transferencias de posiciones en cola. Si no lo esperabas, revisa tus firmantes en la app.`,
    alertPayout: (w, c, what, to, when, code) => `Se puso en cola un pago desde la bóveda protegida de la billetera ${w} en la cadena ${c}: ${what} a ${to}, liberado no antes de ${when} UTC. Código de solicitud ${code}; la app muestra el mismo código para este pago. Si no lo pediste, cancélalo en la app o envía LOCK.`,
    alertReplacement: (w, c, n, by) => `${by} propuso reemplazar la billetera principal ${w} en la cadena ${c}, nombrando a ${n} como nueva principal. Si no lo pediste, cancélalo en la app.`,
    pushTitle: 'Bóveda protegida de Vaipakam',
  },
  fr: {
    lockDone: (w, c) => `Verrouillé : le coffre protégé du portefeuille ${w} sur la chaîne ${c} est maintenant verrouillé. Tous les paiements et transferts de position en file d'attente ont été annulés, et rien de nouveau ne peut être mis en file. Le déverrouillage prend tout votre délai et se demande depuis l'application.`,
    lockAlready: (w, c) => `Le portefeuille ${w} sur la chaîne ${c} était déjà verrouillé. Rien n'a changé.`,
    lockAgain: (w, c) => `Le portefeuille ${w} sur la chaîne ${c} était déjà verrouillé. Le verrou a été posé à nouveau, ce qui annule tout déverrouillage en attente ou autre changement qui assouplit la protection.`,
    lockNotProtected: (w, c) => `Le portefeuille ${w} sur la chaîne ${c} n'a pas le mode protégé activé, il n'y a donc pas de verrou de coffre à poser. Rien n'a été verrouillé.`,
    lockNotAllowed: (w, c) => `Le portefeuille ${w} sur la chaîne ${c} n'a pas été verrouillé : vous n'avez pas autorisé le keeper à verrouiller votre coffre. Accordez la permission de verrouillage dans l'application, ou verrouillez le coffre depuis l'application maintenant.`,
    lockRefused: (w, c, r) => `Le portefeuille ${w} sur la chaîne ${c} n'a pas été verrouillé : le protocole a refusé l'appel (${r}). Verrouillez le coffre depuis l'application.`,
    lockExpired: (w, c) => `Votre LOCK pour le portefeuille ${w} sur la chaîne ${c} n'a pas été traité dans l'heure, il a donc été abandonné et rien n'a été verrouillé. Renvoyez LOCK si vous voulez toujours verrouiller le coffre.`,
    alertLockedByOwner: (w, c) => `Le coffre protégé du portefeuille ${w} sur la chaîne ${c} a été verrouillé par son propriétaire (depuis l'application, ou par le keeper sur votre LOCK). Tous les paiements et transferts de position en file d'attente ont été annulés.`,
    alertLockedBy: (w, c, by) => `Le coffre protégé du portefeuille ${w} sur la chaîne ${c} a été verrouillé par ${by}, l'un de ses signataires. Tous les paiements et transferts de position en file d'attente ont été annulés. Si vous ne vous y attendiez pas, vérifiez vos signataires dans l'application.`,
    alertPayout: (w, c, what, to, when, code) => `Un paiement depuis le coffre protégé du portefeuille ${w} sur la chaîne ${c} a été mis en file : ${what} vers ${to}, libéré au plus tôt le ${when} UTC. Code de demande ${code} ; l'application affiche le même code pour ce paiement. Si vous ne l'avez pas demandé, annulez-le dans l'application ou envoyez LOCK.`,
    alertReplacement: (w, c, n, by) => `${by} a proposé de remplacer le portefeuille principal ${w} sur la chaîne ${c}, en désignant ${n} comme nouveau principal. Si vous ne l'avez pas demandé, annulez-le dans l'application.`,
    pushTitle: 'Coffre protégé Vaipakam',
  },
  de: {
    lockDone: (w, c) => `Gesperrt: Der geschützte Tresor von Wallet ${w} auf Chain ${c} ist jetzt gesperrt. Alle wartenden Auszahlungen und Positionsübertragungen wurden storniert, und es kann nichts Neues eingereiht werden. Das Entsperren dauert Ihre volle Wartezeit und wird in der App beantragt.`,
    lockAlready: (w, c) => `Wallet ${w} auf Chain ${c} war bereits gesperrt. Es hat sich nichts geändert.`,
    lockAgain: (w, c) => `Wallet ${w} auf Chain ${c} war bereits gesperrt. Die Sperre wurde erneut gesetzt; damit sind eine anstehende Entsperrung und jede andere anstehende Lockerung aufgehoben.`,
    lockNotProtected: (w, c) => `Bei Wallet ${w} auf Chain ${c} ist der geschützte Modus nicht aktiv, daher gibt es keine Tresorsperre zu setzen. Es wurde nichts gesperrt.`,
    lockNotAllowed: (w, c) => `Wallet ${w} auf Chain ${c} wurde nicht gesperrt: Sie haben dem Keeper das Sperren Ihres Tresors nicht erlaubt. Erteilen Sie die Sperrberechtigung in der App oder sperren Sie den Tresor jetzt in der App.`,
    lockRefused: (w, c, r) => `Wallet ${w} auf Chain ${c} wurde nicht gesperrt: Das Protokoll hat den Aufruf abgelehnt (${r}). Sperren Sie den Tresor in der App.`,
    lockExpired: (w, c) => `Ihr LOCK für Wallet ${w} auf Chain ${c} wurde nicht innerhalb einer Stunde bearbeitet, daher wurde er verworfen und nichts gesperrt. Senden Sie LOCK erneut, wenn Sie den Tresor weiterhin sperren möchten.`,
    alertLockedByOwner: (w, c) => `Der geschützte Tresor von Wallet ${w} auf Chain ${c} wurde von seinem Eigentümer gesperrt (in der App oder durch den Keeper auf Ihr LOCK). Alle wartenden Auszahlungen und Positionsübertragungen wurden storniert.`,
    alertLockedBy: (w, c, by) => `Der geschützte Tresor von Wallet ${w} auf Chain ${c} wurde von ${by}, einem seiner Unterzeichner, gesperrt. Alle wartenden Auszahlungen und Positionsübertragungen wurden storniert. Falls Sie das nicht erwartet haben, prüfen Sie Ihre Unterzeichner in der App.`,
    alertPayout: (w, c, what, to, when, code) => `Eine Auszahlung aus dem geschützten Tresor von Wallet ${w} auf Chain ${c} wurde eingereiht: ${what} an ${to}, frühestens freigegeben am ${when} UTC. Anfragecode ${code}; die App zeigt für diese Auszahlung denselben Code. Falls Sie sie nicht angefordert haben, stornieren Sie sie in der App oder senden Sie LOCK.`,
    alertReplacement: (w, c, n, by) => `${by} hat vorgeschlagen, die primäre Wallet ${w} auf Chain ${c} zu ersetzen, mit ${n} als neuer primärer Wallet. Falls Sie das nicht angefordert haben, stornieren Sie es in der App.`,
    pushTitle: 'Geschützter Vaipakam-Tresor',
  },
  ja: {
    lockDone: (w, c) => `ロックしました：チェーン ${c} のウォレット ${w} の保護ボールトはロックされました。キュー中の支払いとポジション移転はすべて取り消され、新たにキューに入れることはできません。ロック解除には設定した待機時間がすべてかかり、アプリから申請します。`,
    lockAlready: (w, c) => `チェーン ${c} のウォレット ${w} はすでにロックされていました。変更はありません。`,
    lockAgain: (w, c) => `チェーン ${c} のウォレット ${w} はすでにロックされていました。ロックを再設定したため、保留中のロック解除や保護を緩めるその他の変更はすべて取り消されました。`,
    lockNotProtected: (w, c) => `チェーン ${c} のウォレット ${w} は保護モードが有効ではないため、設定するボールトロックがありません。何もロックされていません。`,
    lockNotAllowed: (w, c) => `チェーン ${c} のウォレット ${w} はロックされませんでした。キーパーにボールトのロックを許可していません。アプリでロック権限を付与するか、今すぐアプリからボールトをロックしてください。`,
    lockRefused: (w, c, r) => `チェーン ${c} のウォレット ${w} はロックされませんでした。プロトコルが呼び出しを拒否しました（${r}）。アプリからボールトをロックしてください。`,
    lockExpired: (w, c) => `チェーン ${c} のウォレット ${w} への LOCK は1時間以内に処理されなかったため破棄され、何もロックされていません。まだロックしたい場合は、もう一度 LOCK を送ってください。`,
    alertLockedByOwner: (w, c) => `チェーン ${c} のウォレット ${w} の保護ボールトが所有者によってロックされました（アプリから、またはあなたの LOCK によりキーパーが実行）。キュー中の支払いとポジション移転はすべて取り消されました。`,
    alertLockedBy: (w, c, by) => `チェーン ${c} のウォレット ${w} の保護ボールトが、署名者の一人 ${by} によってロックされました。キュー中の支払いとポジション移転はすべて取り消されました。心当たりがない場合は、アプリで署名者を確認してください。`,
    alertPayout: (w, c, what, to, when, code) => `チェーン ${c} のウォレット ${w} の保護ボールトから支払いがキューに入りました：${what} を ${to} へ、${when} UTC 以降に解放。リクエストコード ${code}（アプリにもこの支払いの同じコードが表示されます）。心当たりがない場合は、アプリで取り消すか LOCK を送ってください。`,
    alertReplacement: (w, c, n, by) => `${by} が、チェーン ${c} のプライマリウォレット ${w} を ${n} に置き換えることを提案しました。心当たりがない場合は、アプリで取り消してください。`,
    pushTitle: 'Vaipakam 保護ボールト',
  },
  zh: {
    lockDone: (w, c) => `已锁定：链 ${c} 上钱包 ${w} 的受保护金库现已锁定。所有排队中的付款和头寸转移均已取消，且无法再排入新的。解锁需要等待你设置的完整延迟，并须在应用中申请。`,
    lockAlready: (w, c) => `链 ${c} 上的钱包 ${w} 早已锁定。没有任何变化。`,
    lockAgain: (w, c) => `链 ${c} 上的钱包 ${w} 早已锁定。已再次设置锁定，这会取消任何待生效的解锁或其他放宽保护的更改。`,
    lockNotProtected: (w, c) => `链 ${c} 上的钱包 ${w} 未开启保护模式，因此没有可设置的金库锁。未锁定任何内容。`,
    lockNotAllowed: (w, c) => `链 ${c} 上的钱包 ${w} 未被锁定：你尚未允许 keeper 锁定你的金库。请在应用中授予锁定权限，或立即在应用中锁定金库。`,
    lockRefused: (w, c, r) => `链 ${c} 上的钱包 ${w} 未被锁定：协议拒绝了该调用（${r}）。请在应用中锁定金库。`,
    lockExpired: (w, c) => `你对链 ${c} 上钱包 ${w} 的 LOCK 请求在一小时内未被处理，因此已被丢弃，未锁定任何内容。如仍需锁定金库，请再次发送 LOCK。`,
    alertLockedByOwner: (w, c) => `链 ${c} 上钱包 ${w} 的受保护金库已被其所有者锁定（通过应用，或由 keeper 根据你的 LOCK 执行）。所有排队中的付款和头寸转移均已取消。`,
    alertLockedBy: (w, c, by) => `链 ${c} 上钱包 ${w} 的受保护金库已被其签名人之一 ${by} 锁定。所有排队中的付款和头寸转移均已取消。如非预期，请在应用中检查你的签名人。`,
    alertPayout: (w, c, what, to, when, code) => `链 ${c} 上钱包 ${w} 的受保护金库有一笔付款已排队：${what} 付给 ${to}，最早于 ${when} UTC 放行。请求码 ${code}；应用中这笔付款显示相同的码。如果不是你发起的，请在应用中取消或发送 LOCK。`,
    alertReplacement: (w, c, n, by) => `${by} 提议替换链 ${c} 上的主钱包 ${w}，新的主钱包为 ${n}。如果不是你发起的，请在应用中取消。`,
    pushTitle: 'Vaipakam 受保护金库',
  },
  ko: {
    lockDone: (w, c) => `잠금 완료: 체인 ${c}의 지갑 ${w} 보호 볼트가 이제 잠겼습니다. 대기 중인 모든 지급과 포지션 이전이 취소되었으며 새로 대기열에 넣을 수 없습니다. 잠금 해제에는 설정한 지연 시간 전체가 걸리며 앱에서 요청합니다.`,
    lockAlready: (w, c) => `체인 ${c}의 지갑 ${w}은(는) 이미 잠겨 있었습니다. 변경된 것은 없습니다.`,
    lockAgain: (w, c) => `체인 ${c}의 지갑 ${w}은(는) 이미 잠겨 있었습니다. 잠금을 다시 설정했으므로 대기 중인 잠금 해제나 보호를 완화하는 다른 변경은 모두 취소되었습니다.`,
    lockNotProtected: (w, c) => `체인 ${c}의 지갑 ${w}은(는) 보호 모드가 켜져 있지 않아 설정할 볼트 잠금이 없습니다. 아무것도 잠기지 않았습니다.`,
    lockNotAllowed: (w, c) => `체인 ${c}의 지갑 ${w}이(가) 잠기지 않았습니다. 키퍼에게 볼트 잠금을 허용하지 않았습니다. 앱에서 잠금 권한을 부여하거나 지금 앱에서 볼트를 잠그세요.`,
    lockRefused: (w, c, r) => `체인 ${c}의 지갑 ${w}이(가) 잠기지 않았습니다. 프로토콜이 호출을 거부했습니다(${r}). 앱에서 볼트를 잠그세요.`,
    lockExpired: (w, c) => `체인 ${c}의 지갑 ${w}에 대한 LOCK이 한 시간 안에 처리되지 않아 폐기되었고, 아무것도 잠기지 않았습니다. 여전히 볼트를 잠그려면 LOCK을 다시 보내세요.`,
    alertLockedByOwner: (w, c) => `체인 ${c}의 지갑 ${w} 보호 볼트가 소유자에 의해 잠겼습니다(앱에서, 또는 LOCK에 따라 키퍼가 실행). 대기 중인 모든 지급과 포지션 이전이 취소되었습니다.`,
    alertLockedBy: (w, c, by) => `체인 ${c}의 지갑 ${w} 보호 볼트가 서명자 중 한 명인 ${by}에 의해 잠겼습니다. 대기 중인 모든 지급과 포지션 이전이 취소되었습니다. 예상하지 못했다면 앱에서 서명자를 확인하세요.`,
    alertPayout: (w, c, what, to, when, code) => `체인 ${c}의 지갑 ${w} 보호 볼트에서 지급이 대기열에 들어갔습니다: ${what}을(를) ${to}에게, ${when} UTC 이후 지급. 요청 코드 ${code}(앱에도 이 지급에 같은 코드가 표시됩니다). 요청하지 않았다면 앱에서 취소하거나 LOCK을 보내세요.`,
    alertReplacement: (w, c, n, by) => `${by}이(가) 체인 ${c}의 기본 지갑 ${w}을(를) ${n}(으)로 교체할 것을 제안했습니다. 요청하지 않았다면 앱에서 취소하세요.`,
    pushTitle: 'Vaipakam 보호 볼트',
  },
  hi: {
    lockDone: (w, c) => `लॉक हो गया: चेन ${c} पर वॉलेट ${w} का सुरक्षित वॉल्ट अब लॉक है। कतार में लगे सभी भुगतान और पोज़िशन ट्रांसफ़र रद्द कर दिए गए, और कुछ भी नया कतार में नहीं लगाया जा सकता। अनलॉक करने में आपकी पूरी देरी लगती है और इसका अनुरोध ऐप से किया जाता है।`,
    lockAlready: (w, c) => `चेन ${c} पर वॉलेट ${w} पहले से लॉक था। कुछ नहीं बदला।`,
    lockAgain: (w, c) => `चेन ${c} पर वॉलेट ${w} पहले से लॉक था। लॉक फिर से लगाया गया, जिससे कोई भी लंबित अनलॉक या सुरक्षा ढीली करने वाला अन्य बदलाव रद्द हो जाता है।`,
    lockNotProtected: (w, c) => `चेन ${c} पर वॉलेट ${w} में सुरक्षित मोड चालू नहीं है, इसलिए लगाने के लिए कोई वॉल्ट लॉक नहीं है। कुछ भी लॉक नहीं हुआ।`,
    lockNotAllowed: (w, c) => `चेन ${c} पर वॉलेट ${w} लॉक नहीं हुआ: आपने keeper को अपना वॉल्ट लॉक करने की अनुमति नहीं दी है। ऐप में लॉक की अनुमति दें, या अभी ऐप से वॉल्ट लॉक करें।`,
    lockRefused: (w, c, r) => `चेन ${c} पर वॉलेट ${w} लॉक नहीं हुआ: प्रोटोकॉल ने कॉल अस्वीकार कर दी (${r})। ऐप से वॉल्ट लॉक करें।`,
    lockExpired: (w, c) => `चेन ${c} पर वॉलेट ${w} के लिए आपके LOCK पर एक घंटे के भीतर कार्रवाई नहीं हुई, इसलिए उसे छोड़ दिया गया और कुछ भी लॉक नहीं हुआ। अगर आप अब भी वॉल्ट लॉक करना चाहते हैं तो फिर से LOCK भेजें।`,
    alertLockedByOwner: (w, c) => `चेन ${c} पर वॉलेट ${w} का सुरक्षित वॉल्ट उसके मालिक ने लॉक किया (ऐप से, या आपके LOCK पर keeper ने)। कतार में लगे सभी भुगतान और पोज़िशन ट्रांसफ़र रद्द कर दिए गए।`,
    alertLockedBy: (w, c, by) => `चेन ${c} पर वॉलेट ${w} का सुरक्षित वॉल्ट उसके एक हस्ताक्षरकर्ता ${by} ने लॉक किया। कतार में लगे सभी भुगतान और पोज़िशन ट्रांसफ़र रद्द कर दिए गए। अगर आपको इसकी उम्मीद नहीं थी, तो ऐप में अपने हस्ताक्षरकर्ता जाँचें।`,
    alertPayout: (w, c, what, to, when, code) => `चेन ${c} पर वॉलेट ${w} के सुरक्षित वॉल्ट से एक भुगतान कतार में लगा: ${what}, ${to} को, ${when} UTC से पहले जारी नहीं होगा। अनुरोध कोड ${code}; ऐप इस भुगतान के लिए यही कोड दिखाता है। अगर आपने यह नहीं माँगा, तो ऐप में इसे रद्द करें या LOCK भेजें।`,
    alertReplacement: (w, c, n, by) => `${by} ने चेन ${c} पर प्राथमिक वॉलेट ${w} को ${n} से बदलने का प्रस्ताव रखा है। अगर आपने यह नहीं माँगा, तो ऐप में इसे रद्द करें।`,
    pushTitle: 'Vaipakam सुरक्षित वॉल्ट',
  },
  ta: {
    lockDone: (w, c) => `பூட்டப்பட்டது: சங்கிலி ${c} இல் உள்ள வாலெட் ${w} இன் பாதுகாக்கப்பட்ட பெட்டகம் இப்போது பூட்டப்பட்டுள்ளது. வரிசையில் இருந்த அனைத்து பணம் செலுத்துதல்களும் நிலை மாற்றங்களும் ரத்து செய்யப்பட்டன, புதிதாக எதையும் வரிசையில் சேர்க்க முடியாது. திறக்க உங்கள் முழு தாமதமும் ஆகும், அதை செயலியில் கோர வேண்டும்.`,
    lockAlready: (w, c) => `சங்கிலி ${c} இல் உள்ள வாலெட் ${w} ஏற்கனவே பூட்டப்பட்டிருந்தது. எதுவும் மாறவில்லை.`,
    lockAgain: (w, c) => `சங்கிலி ${c} இல் உள்ள வாலெட் ${w} ஏற்கனவே பூட்டப்பட்டிருந்தது. பூட்டு மீண்டும் அமைக்கப்பட்டது; இதனால் நிலுவையில் உள்ள திறப்பு அல்லது பாதுகாப்பைத் தளர்த்தும் வேறு எந்த மாற்றமும் ரத்தாகிறது.`,
    lockNotProtected: (w, c) => `சங்கிலி ${c} இல் உள்ள வாலெட் ${w} இல் பாதுகாப்பு முறை இயக்கத்தில் இல்லை, எனவே அமைக்க பெட்டகப் பூட்டு இல்லை. எதுவும் பூட்டப்படவில்லை.`,
    lockNotAllowed: (w, c) => `சங்கிலி ${c} இல் உள்ள வாலெட் ${w} பூட்டப்படவில்லை: உங்கள் பெட்டகத்தைப் பூட்ட keeper க்கு நீங்கள் அனுமதி தரவில்லை. செயலியில் பூட்டு அனுமதியை வழங்குங்கள், அல்லது இப்போதே செயலியில் பெட்டகத்தைப் பூட்டுங்கள்.`,
    lockRefused: (w, c, r) => `சங்கிலி ${c} இல் உள்ள வாலெட் ${w} பூட்டப்படவில்லை: நெறிமுறை அழைப்பை மறுத்தது (${r}). செயலியில் பெட்டகத்தைப் பூட்டுங்கள்.`,
    lockExpired: (w, c) => `சங்கிலி ${c} இல் உள்ள வாலெட் ${w} க்கான உங்கள் LOCK ஒரு மணி நேரத்துக்குள் செயல்படுத்தப்படவில்லை, எனவே அது கைவிடப்பட்டது, எதுவும் பூட்டப்படவில்லை. இன்னும் பெட்டகத்தைப் பூட்ட வேண்டுமானால் மீண்டும் LOCK அனுப்புங்கள்.`,
    alertLockedByOwner: (w, c) => `சங்கிலி ${c} இல் உள்ள வாலெட் ${w} இன் பாதுகாக்கப்பட்ட பெட்டகம் அதன் உரிமையாளரால் பூட்டப்பட்டது (செயலியில், அல்லது உங்கள் LOCK இன் பேரில் keeper ஆல்). வரிசையில் இருந்த அனைத்து பணம் செலுத்துதல்களும் நிலை மாற்றங்களும் ரத்து செய்யப்பட்டன.`,
    alertLockedBy: (w, c, by) => `சங்கிலி ${c} இல் உள்ள வாலெட் ${w} இன் பாதுகாக்கப்பட்ட பெட்டகம் அதன் கையொப்பமிடுபவர்களில் ஒருவரான ${by} ஆல் பூட்டப்பட்டது. வரிசையில் இருந்த அனைத்து பணம் செலுத்துதல்களும் நிலை மாற்றங்களும் ரத்து செய்யப்பட்டன. இதை நீங்கள் எதிர்பார்க்கவில்லை என்றால், செயலியில் உங்கள் கையொப்பமிடுபவர்களைச் சரிபாருங்கள்.`,
    alertPayout: (w, c, what, to, when, code) => `சங்கிலி ${c} இல் உள்ள வாலெட் ${w} இன் பாதுகாக்கப்பட்ட பெட்டகத்திலிருந்து ஒரு பணம் செலுத்துதல் வரிசையில் சேர்க்கப்பட்டது: ${what}, ${to} க்கு, ${when} UTC க்கு முன் விடுவிக்கப்படாது. கோரிக்கைக் குறியீடு ${code}; இந்தப் பணம் செலுத்துதலுக்குச் செயலியும் அதே குறியீட்டைக் காட்டும். நீங்கள் இதைக் கோரவில்லை என்றால், செயலியில் ரத்து செய்யுங்கள் அல்லது LOCK அனுப்புங்கள்.`,
    alertReplacement: (w, c, n, by) => `சங்கிலி ${c} இல் உள்ள முதன்மை வாலெட் ${w} ஐ ${n} ஆல் மாற்ற ${by} முன்மொழிந்துள்ளார். நீங்கள் இதைக் கோரவில்லை என்றால், செயலியில் ரத்து செய்யுங்கள்.`,
    pushTitle: 'Vaipakam பாதுகாக்கப்பட்ட பெட்டகம்',
  },
  ar: {
    lockDone: (w, c) => `تم القفل: الخزنة المحمية للمحفظة ${w} على السلسلة ${c} مقفلة الآن. أُلغيت كل المدفوعات وعمليات نقل المراكز في قائمة الانتظار، ولا يمكن إضافة شيء جديد إليها. يستغرق فتح القفل مهلتك كاملة ويُطلب من التطبيق.`,
    lockAlready: (w, c) => `المحفظة ${w} على السلسلة ${c} كانت مقفلة بالفعل. لم يتغير شيء.`,
    lockAgain: (w, c) => `المحفظة ${w} على السلسلة ${c} كانت مقفلة بالفعل. أُعيد تعيين القفل، وهذا يلغي أي فتح معلّق أو أي تغيير آخر يخفف الحماية.`,
    lockNotProtected: (w, c) => `الوضع المحمي غير مفعّل للمحفظة ${w} على السلسلة ${c}، لذا لا يوجد قفل خزنة لضبطه. لم يُقفل أي شيء.`,
    lockNotAllowed: (w, c) => `لم تُقفل المحفظة ${w} على السلسلة ${c}: لم تسمح للـ keeper بقفل خزنتك. امنح إذن القفل في التطبيق، أو أقفل الخزنة من التطبيق الآن.`,
    lockRefused: (w, c, r) => `لم تُقفل المحفظة ${w} على السلسلة ${c}: رفض البروتوكول الاستدعاء (${r}). أقفل الخزنة من التطبيق.`,
    lockExpired: (w, c) => `لم يُنفّذ طلب LOCK للمحفظة ${w} على السلسلة ${c} خلال ساعة، لذا أُسقط ولم يُقفل أي شيء. أرسل LOCK مرة أخرى إن كنت لا تزال تريد قفل الخزنة.`,
    alertLockedByOwner: (w, c) => `أقفل مالكُ المحفظة ${w} على السلسلة ${c} خزنتها المحمية (من التطبيق، أو عبر الـ keeper بناءً على طلب LOCK). أُلغيت كل المدفوعات وعمليات نقل المراكز في قائمة الانتظار.`,
    alertLockedBy: (w, c, by) => `أُقفلت الخزنة المحمية للمحفظة ${w} على السلسلة ${c} بواسطة ${by}، أحد موقّعيها. أُلغيت كل المدفوعات وعمليات نقل المراكز في قائمة الانتظار. إن لم تكن تتوقع ذلك، فراجع موقّعيك في التطبيق.`,
    alertPayout: (w, c, what, to, when, code) => `أُضيفت دفعة من الخزنة المحمية للمحفظة ${w} على السلسلة ${c} إلى قائمة الانتظار: ${what} إلى ${to}، لا تُصرف قبل ${when} UTC. رمز الطلب ${code}؛ يعرض التطبيق الرمز نفسه لهذه الدفعة. إن لم تطلبها، فألغها في التطبيق أو أرسل LOCK.`,
    alertReplacement: (w, c, n, by) => `اقترح ${by} استبدال المحفظة الرئيسية ${w} على السلسلة ${c} بالمحفظة ${n}. إن لم تطلب ذلك، فألغه في التطبيق.`,
    pushTitle: 'خزنة Vaipakam المحمية',
  },
};

/** The copy for `locale`, English when it is not one this catalogue has. */
export function protectedCopy(locale: string | null | undefined): Copy {
  return COPY[resolve(locale)];
}

/** A wallet as the messages show it. */
export const shortAddress = (a: string): string => `${a.slice(0, 8)}…${a.slice(-6)}`;
