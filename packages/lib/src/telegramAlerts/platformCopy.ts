// packages/lib/src/telegramAlerts/platformCopy.ts
//
// #3719 — the platform's own alert, with the true terms, for every loan
// opened and every offer or Auto-lend slot created or edited, and for every
// step that lowers a user's protection. A user who came through another
// website sees only what that website showed; this message is built from the
// chain event, whichever front end was used, and never passes through an
// integrator.
//
// Every message states what the event carries and says "unknown" for what it
// does not, never leaving a field out. A warning the contract derived is
// stated as a plain line.
//
// One catalogue per locale, falling back to English, like `termsCopy.ts`.

import { SUPPORTED_LOCALES, type Locale } from './hfCopy';

/** The steps that lower a user's protection. */
export const PROTECTION_STEPS = ['riskLevel', 'illiquidPair', 'keeperActions', 'loanKeeper', 'offerKeeper', 'tokenApproval', 'positionUnlock', 'positionLockDelay'] as const;
export type ProtectionStep = (typeof PROTECTION_STEPS)[number];

/** The warnings bits (`warnings` in the loan and offer events): 0 the loan's
 *  collateral at or above the concentration caution level, 1 the rate far
 *  above the term average, 2 far below. */
export const WARNING_BITS = [0, 1, 2] as const;

function resolve(s: string | null | undefined): Locale {
  return s && (SUPPORTED_LOCALES as readonly string[]).includes(s) ? (s as Locale) : 'en';
}

interface Copy {
  unknown: string;
  none: string;
  /** `c` chain, `id` the loan, `role` the reader's side. */
  loanHead: (c: number, id: string, lender: boolean) => string;
  offerHead: (c: number, id: string, edit: boolean, lend: boolean) => string;
  slotHead: (c: number, slot: number) => string;
  lend: (x: string) => string;
  collateral: (x: string) => string;
  rate: (x: string) => string;
  /** A slot's least rate. */
  minRate: (x: string) => string;
  term: (x: string) => string;
  /** The margin over the market rate, in percentage points (signed). */
  linked: (x: string) => string;
  integrator: (x: string) => string;
  warning: Record<(typeof WARNING_BITS)[number], string>;
  check: (link: string) => string;
  days: (n: number) => string;
  /** The protection steps; `s` subject, `r` reference, `l`/`p` levels. */
  step: Record<ProtectionStep, (a: { s: string; r: string; lend: string; coll: string; l: string; p: string; h: string }) => string>;
  stepHead: (c: number) => string;
  from: (t: string) => string;
  notYou: (link: string) => string;
  pushTitle: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    unknown: 'unknown',
    none: 'none',
    loanHead: (c, id, lender) => `A loan was opened on chain ${c}: loan #${id}, where you are the ${lender ? 'lender' : 'borrower'}. The platform's own record of its terms:`,
    offerHead: (c, id, edit, lend) => `Your ${lend ? 'lending' : 'borrowing'} offer #${id} on chain ${c} was ${edit ? 'edited' : 'posted'}. The platform's own record of its terms:`,
    slotHead: (c, slot) => `The rate terms of your Auto-lend slot ${slot} on chain ${c} were set. The platform's own record:`,
    lend: (x) => `Lent: ${x}.`,
    collateral: (x) => `Collateral: ${x}.`,
    rate: (x) => `Interest rate: ${x} a year.`,
    minRate: (x) => `Least interest rate: ${x} a year.`,
    term: (x) => `Term: ${x}.`,
    linked: (x) => `The rate follows the market rate, ${x} percentage points over it.`,
    integrator: (x) => `Website named: ${x}.`,
    warning: {
      0: 'Warning: the collateral is at or above the concentration caution level.',
      1: 'Warning: the rate is far above the recent average for this term.',
      2: 'Warning: the rate is far below the recent average for this term.',
    },
    check: (link) => `If this is not what you agreed to, check it in the app: ${link}`,
    days: (n) => `${n} days`,
    stepHead: (c) => `A step that lowers your protection was taken on chain ${c}.`,
    step: {
      riskLevel: (a) => `Your asset access level was raised from ${a.p} to ${a.l}.`,
      illiquidPair: (a) => `You gave consent to lend or borrow ${a.lend} against ${a.coll}, a pair without a market price.`,
      keeperActions: (a) => `You allowed the keeper ${a.s} to act for you, or allowed it more actions.`,
      loanKeeper: (a) => `You allowed the keeper ${a.s} to act on loan #${a.r}.`,
      offerKeeper: (a) => `You allowed the keeper ${a.s} to act on offer #${a.r}.`,
      tokenApproval: (a) => `You approved ${a.s} to move your position token #${a.r}.`,
      positionUnlock: () => `You asked to unlock your position tokens.`,
      positionLockDelay: (a) => `You asked to shorten the wait before your position tokens can be unlocked to ${a.h} hours.`,
    },
    from: (t) => `It takes effect at ${t} UTC.`,
    notYou: (link) => `If this was not you, open the app now: ${link}`,
    pushTitle: 'Platform record',
  },
  es: {
    unknown: 'desconocido',
    none: 'ninguno',
    loanHead: (c, id, lender) => `Se abrió un préstamo en la cadena ${c}: el préstamo #${id}, en el que eres ${lender ? 'el prestamista' : 'el prestatario'}. Registro de la plataforma sobre sus condiciones:`,
    offerHead: (c, id, edit, lend) => `Tu oferta de ${lend ? 'préstamo' : 'endeudamiento'} #${id} en la cadena ${c} se ${edit ? 'editó' : 'publicó'}. Registro de la plataforma sobre sus condiciones:`,
    slotHead: (c, slot) => `Se fijaron las condiciones de tipo de tu espacio de Auto-lend ${slot} en la cadena ${c}. Registro de la plataforma:`,
    lend: (x) => `Prestado: ${x}.`,
    collateral: (x) => `Garantía: ${x}.`,
    rate: (x) => `Tipo de interés: ${x} al año.`,
    minRate: (x) => `Tipo de interés mínimo: ${x} al año.`,
    term: (x) => `Plazo: ${x}.`,
    linked: (x) => `El tipo sigue al tipo de mercado, ${x} puntos porcentuales por encima.`,
    integrator: (x) => `Sitio web indicado: ${x}.`,
    warning: {
      0: 'Aviso: la garantía está en el nivel de precaución por concentración o por encima.',
      1: 'Aviso: el tipo está muy por encima de la media reciente para este plazo.',
      2: 'Aviso: el tipo está muy por debajo de la media reciente para este plazo.',
    },
    check: (link) => `Si esto no es lo que acordaste, revísalo en la app: ${link}`,
    days: (n) => `${n} días`,
    stepHead: (c) => `Se dio un paso que reduce tu protección en la cadena ${c}.`,
    step: {
      riskLevel: (a) => `Tu nivel de acceso a activos subió de ${a.p} a ${a.l}.`,
      illiquidPair: (a) => `Diste tu consentimiento para prestar o pedir prestado ${a.lend} contra ${a.coll}, un par sin precio de mercado.`,
      keeperActions: (a) => `Permitiste al keeper ${a.s} actuar por ti, o le permitiste más acciones.`,
      loanKeeper: (a) => `Permitiste al keeper ${a.s} actuar sobre el préstamo #${a.r}.`,
      offerKeeper: (a) => `Permitiste al keeper ${a.s} actuar sobre la oferta #${a.r}.`,
      tokenApproval: (a) => `Autorizaste a ${a.s} a mover tu token de posición #${a.r}.`,
      positionUnlock: () => `Pediste desbloquear tus tokens de posición.`,
      positionLockDelay: (a) => `Pediste acortar a ${a.h} horas la espera para desbloquear tus tokens de posición.`,
    },
    from: (t) => `Tiene efecto el ${t} UTC.`,
    notYou: (link) => `Si no fuiste tú, abre la app ahora: ${link}`,
    pushTitle: 'Registro de la plataforma',
  },
  fr: {
    unknown: 'inconnu',
    none: 'aucun',
    loanHead: (c, id, lender) => `Un prêt a été ouvert sur la chaîne ${c} : le prêt #${id}, dont vous êtes ${lender ? 'le prêteur' : "l'emprunteur"}. Le relevé de la plateforme sur ses conditions :`,
    offerHead: (c, id, edit, lend) => `Votre offre ${lend ? 'de prêt' : "d'emprunt"} #${id} sur la chaîne ${c} a été ${edit ? 'modifiée' : 'publiée'}. Le relevé de la plateforme sur ses conditions :`,
    slotHead: (c, slot) => `Les conditions de taux de votre emplacement Auto-lend ${slot} sur la chaîne ${c} ont été fixées. Le relevé de la plateforme :`,
    lend: (x) => `Prêté : ${x}.`,
    collateral: (x) => `Garantie : ${x}.`,
    rate: (x) => `Taux d'intérêt : ${x} par an.`,
    minRate: (x) => `Taux d'intérêt minimum : ${x} par an.`,
    term: (x) => `Durée : ${x}.`,
    linked: (x) => `Le taux suit le taux du marché, ${x} points de pourcentage au-dessus.`,
    integrator: (x) => `Site web indiqué : ${x}.`,
    warning: {
      0: 'Avertissement : la garantie atteint ou dépasse le seuil de prudence de concentration.',
      1: 'Avertissement : le taux est très au-dessus de la moyenne récente pour cette durée.',
      2: 'Avertissement : le taux est très en dessous de la moyenne récente pour cette durée.',
    },
    check: (link) => `Si ce n'est pas ce que vous avez accepté, vérifiez dans l'app : ${link}`,
    days: (n) => `${n} jours`,
    stepHead: (c) => `Une étape qui réduit votre protection a été effectuée sur la chaîne ${c}.`,
    step: {
      riskLevel: (a) => `Votre niveau d'accès aux actifs est passé de ${a.p} à ${a.l}.`,
      illiquidPair: (a) => `Vous avez consenti à prêter ou emprunter ${a.lend} contre ${a.coll}, une paire sans prix de marché.`,
      keeperActions: (a) => `Vous avez autorisé le keeper ${a.s} à agir pour vous, ou lui avez permis davantage d'actions.`,
      loanKeeper: (a) => `Vous avez autorisé le keeper ${a.s} à agir sur le prêt #${a.r}.`,
      offerKeeper: (a) => `Vous avez autorisé le keeper ${a.s} à agir sur l'offre #${a.r}.`,
      tokenApproval: (a) => `Vous avez autorisé ${a.s} à déplacer votre jeton de position #${a.r}.`,
      positionUnlock: () => `Vous avez demandé le déverrouillage de vos jetons de position.`,
      positionLockDelay: (a) => `Vous avez demandé de réduire à ${a.h} heures le délai avant le déverrouillage de vos jetons de position.`,
    },
    from: (t) => `Prend effet le ${t} UTC.`,
    notYou: (link) => `Si ce n'était pas vous, ouvrez l'app maintenant : ${link}`,
    pushTitle: 'Relevé de la plateforme',
  },
  de: {
    unknown: 'unbekannt',
    none: 'keine',
    loanHead: (c, id, lender) => `Auf Chain ${c} wurde ein Kredit eröffnet: Kredit #${id}, bei dem du ${lender ? 'der Kreditgeber' : 'der Kreditnehmer'} bist. Die eigene Aufzeichnung der Plattform zu seinen Bedingungen:`,
    offerHead: (c, id, edit, lend) => `Dein ${lend ? 'Verleih' : 'Leih'}angebot #${id} auf Chain ${c} wurde ${edit ? 'geändert' : 'eingestellt'}. Die eigene Aufzeichnung der Plattform zu seinen Bedingungen:`,
    slotHead: (c, slot) => `Die Zinsbedingungen deines Auto-lend-Platzes ${slot} auf Chain ${c} wurden festgelegt. Die eigene Aufzeichnung der Plattform:`,
    lend: (x) => `Verliehen: ${x}.`,
    collateral: (x) => `Sicherheit: ${x}.`,
    rate: (x) => `Zinssatz: ${x} pro Jahr.`,
    minRate: (x) => `Mindestzinssatz: ${x} pro Jahr.`,
    term: (x) => `Laufzeit: ${x}.`,
    linked: (x) => `Der Zins folgt dem Marktzins, ${x} Prozentpunkte darüber.`,
    integrator: (x) => `Genannte Website: ${x}.`,
    warning: {
      0: 'Warnung: Die Sicherheit liegt auf oder über der Vorsichtsschwelle für Konzentration.',
      1: 'Warnung: Der Zins liegt weit über dem jüngsten Durchschnitt für diese Laufzeit.',
      2: 'Warnung: Der Zins liegt weit unter dem jüngsten Durchschnitt für diese Laufzeit.',
    },
    check: (link) => `Wenn das nicht ist, was du vereinbart hast, prüfe es in der App: ${link}`,
    days: (n) => `${n} Tage`,
    stepHead: (c) => `Auf Chain ${c} wurde ein Schritt ausgeführt, der deinen Schutz verringert.`,
    step: {
      riskLevel: (a) => `Deine Asset-Zugangsstufe wurde von ${a.p} auf ${a.l} angehoben.`,
      illiquidPair: (a) => `Du hast zugestimmt, ${a.lend} gegen ${a.coll} zu verleihen oder zu leihen, ein Paar ohne Marktpreis.`,
      keeperActions: (a) => `Du hast dem Keeper ${a.s} erlaubt, für dich zu handeln, oder ihm weitere Aktionen erlaubt.`,
      loanKeeper: (a) => `Du hast dem Keeper ${a.s} erlaubt, bei Kredit #${a.r} zu handeln.`,
      offerKeeper: (a) => `Du hast dem Keeper ${a.s} erlaubt, bei Angebot #${a.r} zu handeln.`,
      tokenApproval: (a) => `Du hast ${a.s} erlaubt, deinen Positions-Token #${a.r} zu bewegen.`,
      positionUnlock: () => `Du hast beantragt, deine Positions-Token zu entsperren.`,
      positionLockDelay: (a) => `Du hast beantragt, die Wartezeit vor dem Entsperren deiner Positions-Token auf ${a.h} Stunden zu verkürzen.`,
    },
    from: (t) => `Wirksam am ${t} UTC.`,
    notYou: (link) => `Wenn du das nicht warst, öffne jetzt die App: ${link}`,
    pushTitle: 'Aufzeichnung der Plattform',
  },
  ja: {
    unknown: '不明',
    none: 'なし',
    loanHead: (c, id, lender) => `チェーン ${c} でローンが組成されました：ローン #${id}（あなたは${lender ? '貸し手' : '借り手'}）。プラットフォーム自身が記録した条件：`,
    offerHead: (c, id, edit, lend) => `チェーン ${c} のあなたの${lend ? '貸出' : '借入'}オファー #${id} が${edit ? '変更' : '掲載'}されました。プラットフォーム自身が記録した条件：`,
    slotHead: (c, slot) => `チェーン ${c} のあなたの Auto-lend スロット ${slot} の金利条件が設定されました。プラットフォーム自身の記録：`,
    lend: (x) => `貸出：${x}。`,
    collateral: (x) => `担保：${x}。`,
    rate: (x) => `金利：年 ${x}。`,
    minRate: (x) => `最低金利：年 ${x}。`,
    term: (x) => `期間：${x}。`,
    linked: (x) => `金利は市場金利に連動し、市場金利より ${x} ポイント上乗せです。`,
    integrator: (x) => `指定されたウェブサイト：${x}。`,
    warning: {
      0: '警告：担保が集中度の注意水準以上です。',
      1: '警告：金利がこの期間の最近の平均を大きく上回っています。',
      2: '警告：金利がこの期間の最近の平均を大きく下回っています。',
    },
    check: (link) => `合意した内容と違う場合は、アプリで確認してください：${link}`,
    days: (n) => `${n} 日`,
    stepHead: (c) => `チェーン ${c} で、あなたの保護を弱める操作が行われました。`,
    step: {
      riskLevel: (a) => `資産アクセスレベルが ${a.p} から ${a.l} に引き上げられました。`,
      illiquidPair: (a) => `市場価格のないペア、${a.coll} を担保にした ${a.lend} の貸し借りに同意しました。`,
      keeperActions: (a) => `キーパー ${a.s} があなたの代わりに操作すること、またはより多くの操作を許可しました。`,
      loanKeeper: (a) => `キーパー ${a.s} がローン #${a.r} を操作することを許可しました。`,
      offerKeeper: (a) => `キーパー ${a.s} がオファー #${a.r} を操作することを許可しました。`,
      tokenApproval: (a) => `${a.s} があなたのポジショントークン #${a.r} を移動することを承認しました。`,
      positionUnlock: () => `ポジショントークンのロック解除を申請しました。`,
      positionLockDelay: (a) => `ポジショントークンのロック解除までの待ち時間を ${a.h} 時間に短縮するよう申請しました。`,
    },
    from: (t) => `${t} UTC に有効になります。`,
    notYou: (link) => `心当たりがない場合は、今すぐアプリを開いてください：${link}`,
    pushTitle: 'プラットフォームの記録',
  },
  zh: {
    unknown: '未知',
    none: '无',
    loanHead: (c, id, lender) => `链 ${c} 上开立了一笔贷款：贷款 #${id}，你是${lender ? '出借人' : '借款人'}。平台自己记录的条款：`,
    offerHead: (c, id, edit, lend) => `你在链 ${c} 上的${lend ? '出借' : '借款'}报价 #${id} 已${edit ? '修改' : '发布'}。平台自己记录的条款：`,
    slotHead: (c, slot) => `你在链 ${c} 上的 Auto-lend 位置 ${slot} 的利率条款已设定。平台自己的记录：`,
    lend: (x) => `出借：${x}。`,
    collateral: (x) => `抵押品：${x}。`,
    rate: (x) => `年利率：${x}。`,
    minRate: (x) => `最低年利率：${x}。`,
    term: (x) => `期限：${x}。`,
    linked: (x) => `利率跟随市场利率，比市场利率高 ${x} 个百分点。`,
    integrator: (x) => `指定的网站：${x}。`,
    warning: {
      0: '警告：抵押品达到或超过集中度警戒水平。',
      1: '警告：利率远高于该期限的近期平均水平。',
      2: '警告：利率远低于该期限的近期平均水平。',
    },
    check: (link) => `如果这不是你同意的内容，请在应用中核对：${link}`,
    days: (n) => `${n} 天`,
    stepHead: (c) => `链 ${c} 上发生了一项降低你保护的操作。`,
    step: {
      riskLevel: (a) => `你的资产访问级别从 ${a.p} 提高到了 ${a.l}。`,
      illiquidPair: (a) => `你同意以 ${a.coll} 为抵押出借或借入 ${a.lend}，这是一个没有市场价格的组合。`,
      keeperActions: (a) => `你允许 keeper ${a.s} 代你操作，或允许了更多操作。`,
      loanKeeper: (a) => `你允许 keeper ${a.s} 操作贷款 #${a.r}。`,
      offerKeeper: (a) => `你允许 keeper ${a.s} 操作报价 #${a.r}。`,
      tokenApproval: (a) => `你授权 ${a.s} 转移你的头寸代币 #${a.r}。`,
      positionUnlock: () => `你申请解锁你的头寸代币。`,
      positionLockDelay: (a) => `你申请将解锁头寸代币前的等待时间缩短为 ${a.h} 小时。`,
    },
    from: (t) => `于 ${t} UTC 生效。`,
    notYou: (link) => `如果不是你本人操作，请立即打开应用：${link}`,
    pushTitle: '平台记录',
  },
  ko: {
    unknown: '알 수 없음',
    none: '없음',
    loanHead: (c, id, lender) => `체인 ${c}에서 대출이 열렸습니다: 대출 #${id}, 당신은 ${lender ? '대출자' : '차입자'}입니다. 플랫폼이 직접 기록한 조건:`,
    offerHead: (c, id, edit, lend) => `체인 ${c}의 ${lend ? '대출' : '차입'} 제안 #${id}가 ${edit ? '수정' : '게시'}되었습니다. 플랫폼이 직접 기록한 조건:`,
    slotHead: (c, slot) => `체인 ${c}의 Auto-lend 슬롯 ${slot}의 금리 조건이 설정되었습니다. 플랫폼 자체 기록:`,
    lend: (x) => `대출 자산: ${x}.`,
    collateral: (x) => `담보: ${x}.`,
    rate: (x) => `이자율: 연 ${x}.`,
    minRate: (x) => `최저 이자율: 연 ${x}.`,
    term: (x) => `기간: ${x}.`,
    linked: (x) => `금리는 시장 금리를 따르며, 시장 금리보다 ${x}%포인트 높습니다.`,
    integrator: (x) => `지정된 웹사이트: ${x}.`,
    warning: {
      0: '경고: 담보가 집중도 주의 수준 이상입니다.',
      1: '경고: 금리가 이 기간의 최근 평균보다 훨씬 높습니다.',
      2: '경고: 금리가 이 기간의 최근 평균보다 훨씬 낮습니다.',
    },
    check: (link) => `동의한 내용과 다르다면 앱에서 확인하세요: ${link}`,
    days: (n) => `${n}일`,
    stepHead: (c) => `체인 ${c}에서 보호를 낮추는 단계가 실행되었습니다.`,
    step: {
      riskLevel: (a) => `자산 접근 수준이 ${a.p}에서 ${a.l}로 올라갔습니다.`,
      illiquidPair: (a) => `시장 가격이 없는 쌍인 ${a.coll} 담보의 ${a.lend} 대출 또는 차입에 동의했습니다.`,
      keeperActions: (a) => `키퍼 ${a.s}가 대신 실행하거나 더 많은 작업을 하도록 허용했습니다.`,
      loanKeeper: (a) => `키퍼 ${a.s}가 대출 #${a.r}에서 실행하도록 허용했습니다.`,
      offerKeeper: (a) => `키퍼 ${a.s}가 제안 #${a.r}에서 실행하도록 허용했습니다.`,
      tokenApproval: (a) => `${a.s}가 포지션 토큰 #${a.r}를 옮길 수 있도록 승인했습니다.`,
      positionUnlock: () => `포지션 토큰 잠금 해제를 요청했습니다.`,
      positionLockDelay: (a) => `포지션 토큰 잠금 해제 전 대기 시간을 ${a.h}시간으로 줄이도록 요청했습니다.`,
    },
    from: (t) => `${t} UTC에 적용됩니다.`,
    notYou: (link) => `본인이 아니라면 지금 앱을 여세요: ${link}`,
    pushTitle: '플랫폼 기록',
  },
  hi: {
    unknown: 'अज्ञात',
    none: 'कोई नहीं',
    loanHead: (c, id, lender) => `चेन ${c} पर एक ऋण खुला: ऋण #${id}, जिसमें आप ${lender ? 'ऋणदाता' : 'उधारकर्ता'} हैं। इसकी शर्तों का प्लेटफ़ॉर्म का अपना रिकॉर्ड:`,
    offerHead: (c, id, edit, lend) => `चेन ${c} पर आपका ${lend ? 'उधार देने' : 'उधार लेने'} का ऑफ़र #${id} ${edit ? 'बदला गया' : 'पोस्ट किया गया'}। इसकी शर्तों का प्लेटफ़ॉर्म का अपना रिकॉर्ड:`,
    slotHead: (c, slot) => `चेन ${c} पर आपके Auto-lend स्लॉट ${slot} की दर की शर्तें तय की गईं। प्लेटफ़ॉर्म का अपना रिकॉर्ड:`,
    lend: (x) => `उधार दिया गया: ${x}।`,
    collateral: (x) => `ज़मानत: ${x}।`,
    rate: (x) => `ब्याज दर: ${x} प्रति वर्ष।`,
    minRate: (x) => `न्यूनतम ब्याज दर: ${x} प्रति वर्ष।`,
    term: (x) => `अवधि: ${x}।`,
    linked: (x) => `दर बाज़ार दर के साथ चलती है, उससे ${x} प्रतिशत अंक ऊपर।`,
    integrator: (x) => `बताई गई वेबसाइट: ${x}।`,
    warning: {
      0: 'चेतावनी: ज़मानत एकाग्रता की सावधानी सीमा पर या उससे ऊपर है।',
      1: 'चेतावनी: दर इस अवधि के हाल के औसत से बहुत ऊपर है।',
      2: 'चेतावनी: दर इस अवधि के हाल के औसत से बहुत नीचे है।',
    },
    check: (link) => `अगर यह वह नहीं है जिस पर आप सहमत हुए थे, तो ऐप में जाँचें: ${link}`,
    days: (n) => `${n} दिन`,
    stepHead: (c) => `चेन ${c} पर आपकी सुरक्षा घटाने वाला एक कदम उठाया गया।`,
    step: {
      riskLevel: (a) => `आपका एसेट एक्सेस स्तर ${a.p} से बढ़ाकर ${a.l} किया गया।`,
      illiquidPair: (a) => `आपने ${a.coll} के बदले ${a.lend} उधार देने या लेने की सहमति दी, एक ऐसी जोड़ी जिसका बाज़ार मूल्य नहीं है।`,
      keeperActions: (a) => `आपने कीपर ${a.s} को अपनी ओर से काम करने, या और काम करने की अनुमति दी।`,
      loanKeeper: (a) => `आपने कीपर ${a.s} को ऋण #${a.r} पर काम करने की अनुमति दी।`,
      offerKeeper: (a) => `आपने कीपर ${a.s} को ऑफ़र #${a.r} पर काम करने की अनुमति दी।`,
      tokenApproval: (a) => `आपने ${a.s} को अपना पोज़िशन टोकन #${a.r} हिलाने की मंज़ूरी दी।`,
      positionUnlock: () => `आपने अपने पोज़िशन टोकन अनलॉक करने का अनुरोध किया।`,
      positionLockDelay: (a) => `आपने अपने पोज़िशन टोकन अनलॉक होने से पहले का प्रतीक्षा समय घटाकर ${a.h} घंटे करने का अनुरोध किया।`,
    },
    from: (t) => `यह ${t} UTC पर लागू होगा।`,
    notYou: (link) => `अगर यह आपने नहीं किया, तो अभी ऐप खोलें: ${link}`,
    pushTitle: 'प्लेटफ़ॉर्म रिकॉर्ड',
  },
  ta: {
    unknown: 'தெரியவில்லை',
    none: 'இல்லை',
    loanHead: (c, id, lender) => `சங்கிலி ${c} இல் ஒரு கடன் திறக்கப்பட்டது: கடன் #${id}, இதில் நீங்கள் ${lender ? 'கடன் கொடுப்பவர்' : 'கடன் வாங்குபவர்'}. அதன் நிபந்தனைகள் குறித்த தளத்தின் சொந்தப் பதிவு:`,
    offerHead: (c, id, edit, lend) => `சங்கிலி ${c} இல் உங்கள் ${lend ? 'கடன் கொடுக்கும்' : 'கடன் வாங்கும்'} சலுகை #${id} ${edit ? 'திருத்தப்பட்டது' : 'வெளியிடப்பட்டது'}. அதன் நிபந்தனைகள் குறித்த தளத்தின் சொந்தப் பதிவு:`,
    slotHead: (c, slot) => `சங்கிலி ${c} இல் உங்கள் Auto-lend இடம் ${slot} இன் வட்டி நிபந்தனைகள் அமைக்கப்பட்டன. தளத்தின் சொந்தப் பதிவு:`,
    lend: (x) => `கடனாகக் கொடுத்தது: ${x}.`,
    collateral: (x) => `பிணையம்: ${x}.`,
    rate: (x) => `வட்டி விகிதம்: ஆண்டுக்கு ${x}.`,
    minRate: (x) => `குறைந்தபட்ச வட்டி விகிதம்: ஆண்டுக்கு ${x}.`,
    term: (x) => `காலம்: ${x}.`,
    linked: (x) => `விகிதம் சந்தை விகிதத்தைப் பின்தொடர்கிறது, அதைவிட ${x} சதவீதப் புள்ளிகள் அதிகம்.`,
    integrator: (x) => `குறிப்பிடப்பட்ட இணையதளம்: ${x}.`,
    warning: {
      0: 'எச்சரிக்கை: பிணையம் செறிவு எச்சரிக்கை அளவில் அல்லது அதற்கு மேல் உள்ளது.',
      1: 'எச்சரிக்கை: இந்தக் காலத்துக்கான சமீபத்திய சராசரியைவிட விகிதம் மிக அதிகம்.',
      2: 'எச்சரிக்கை: இந்தக் காலத்துக்கான சமீபத்திய சராசரியைவிட விகிதம் மிகக் குறைவு.',
    },
    check: (link) => `இது நீங்கள் ஒப்புக்கொண்டது இல்லை என்றால், செயலியில் சரிபாருங்கள்: ${link}`,
    days: (n) => `${n} நாட்கள்`,
    stepHead: (c) => `சங்கிலி ${c} இல் உங்கள் பாதுகாப்பைக் குறைக்கும் ஒரு படி எடுக்கப்பட்டது.`,
    step: {
      riskLevel: (a) => `உங்கள் சொத்து அணுகல் நிலை ${a.p} இலிருந்து ${a.l} ஆக உயர்த்தப்பட்டது.`,
      illiquidPair: (a) => `சந்தை விலை இல்லாத இணையான ${a.coll} க்கு எதிராக ${a.lend} ஐக் கடன் கொடுக்க அல்லது வாங்க ஒப்புதல் அளித்தீர்கள்.`,
      keeperActions: (a) => `கீப்பர் ${a.s} உங்களுக்காகச் செயல்பட, அல்லது மேலும் செயல்கள் செய்ய அனுமதித்தீர்கள்.`,
      loanKeeper: (a) => `கீப்பர் ${a.s} கடன் #${a.r} இல் செயல்பட அனுமதித்தீர்கள்.`,
      offerKeeper: (a) => `கீப்பர் ${a.s} சலுகை #${a.r} இல் செயல்பட அனுமதித்தீர்கள்.`,
      tokenApproval: (a) => `உங்கள் நிலை டோக்கன் #${a.r} ஐ நகர்த்த ${a.s} க்கு ஒப்புதல் அளித்தீர்கள்.`,
      positionUnlock: () => `உங்கள் நிலை டோக்கன்களைத் திறக்கக் கோரினீர்கள்.`,
      positionLockDelay: (a) => `உங்கள் நிலை டோக்கன்களைத் திறப்பதற்கு முந்தைய காத்திருப்பு நேரத்தை ${a.h} மணிநேரமாகக் குறைக்கக் கோரினீர்கள்.`,
    },
    from: (t) => `இது ${t} UTC அன்று நடைமுறைக்கு வரும்.`,
    notYou: (link) => `இது நீங்கள் இல்லை என்றால், இப்போதே செயலியைத் திறவுங்கள்: ${link}`,
    pushTitle: 'தளப் பதிவு',
  },
  ar: {
    unknown: 'غير معروف',
    none: 'لا يوجد',
    loanHead: (c, id, lender) => `فُتح قرض على السلسلة ${c}: القرض #${id}، وأنت فيه ${lender ? 'المُقرض' : 'المقترض'}. سجل المنصة نفسها لشروطه:`,
    offerHead: (c, id, edit, lend) => `${edit ? 'عُدّل' : 'نُشر'} عرض ${lend ? 'الإقراض' : 'الاقتراض'} الخاص بك #${id} على السلسلة ${c}. سجل المنصة نفسها لشروطه:`,
    slotHead: (c, slot) => `حُددت شروط سعر خانة Auto-lend رقم ${slot} على السلسلة ${c}. سجل المنصة نفسها:`,
    lend: (x) => `المُقرَض: ${x}.`,
    collateral: (x) => `الضمان: ${x}.`,
    rate: (x) => `سعر الفائدة: ${x} سنويًا.`,
    minRate: (x) => `أدنى سعر فائدة: ${x} سنويًا.`,
    term: (x) => `المدة: ${x}.`,
    linked: (x) => `يتبع السعر سعر السوق، بزيادة ${x} نقطة مئوية عليه.`,
    integrator: (x) => `الموقع المذكور: ${x}.`,
    warning: {
      0: 'تحذير: الضمان عند مستوى الحذر من التركز أو فوقه.',
      1: 'تحذير: السعر أعلى بكثير من المتوسط الأخير لهذه المدة.',
      2: 'تحذير: السعر أدنى بكثير من المتوسط الأخير لهذه المدة.',
    },
    check: (link) => `إن لم يكن هذا ما وافقت عليه، فتحقق منه في التطبيق: ${link}`,
    days: (n) => `${n} يومًا`,
    stepHead: (c) => `اتُّخذت على السلسلة ${c} خطوة تخفض حمايتك.`,
    step: {
      riskLevel: (a) => `رُفع مستوى وصولك إلى الأصول من ${a.p} إلى ${a.l}.`,
      illiquidPair: (a) => `وافقت على إقراض أو اقتراض ${a.lend} مقابل ${a.coll}، وهو زوج بلا سعر سوق.`,
      keeperActions: (a) => `سمحت للحارس ${a.s} بالتصرف عنك، أو سمحت له بإجراءات أكثر.`,
      loanKeeper: (a) => `سمحت للحارس ${a.s} بالتصرف في القرض #${a.r}.`,
      offerKeeper: (a) => `سمحت للحارس ${a.s} بالتصرف في العرض #${a.r}.`,
      tokenApproval: (a) => `أذنت لـ ${a.s} بنقل رمز مركزك #${a.r}.`,
      positionUnlock: () => `طلبت فتح قفل رموز مراكزك.`,
      positionLockDelay: (a) => `طلبت تقصير مدة الانتظار قبل فتح قفل رموز مراكزك إلى ${a.h} ساعة.`,
    },
    from: (t) => `يسري في ${t} UTC.`,
    notYou: (link) => `إن لم تكن أنت، فافتح التطبيق الآن: ${link}`,
    pushTitle: 'سجل المنصة',
  },
};

/** A rate in basis points as a percentage: `1250` → `12.5%`. */
export const pct = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;
/** A signed margin in basis points as percentage points: `-50` → `-0.5`. */
const points = (bps: number): string => `${bps > 0 ? '+' : ''}${Number((bps / 100).toFixed(2))}`;

const warningLines = (k: Copy, bits: number): string[] => WARNING_BITS.filter((b) => (bits >> b) & 1).map((b) => k.warning[b]);

export interface TermsFields {
  lend: string | null;
  collateral: string | null;
  /** The rate (or its two ends for a range), basis points; null unknown. */
  rateBps: number | null;
  rateMaxBps: number | null;
  days: number | null;
  /** The market link's margin when linked, basis points; null none. */
  marginBps: number | null;
  /** The integrator: an address, `none`, or null unknown. */
  integrator: string | null;
  warnings: number;
}

function termsLines(k: Copy, t: TermsFields, withTerm: boolean, least = false): string[] {
  const u = (x: string | null) => x ?? k.unknown;
  const rate =
    t.rateBps === null ? k.unknown : t.rateMaxBps !== null && t.rateMaxBps !== t.rateBps ? `${pct(t.rateBps)} – ${pct(t.rateMaxBps)}` : pct(t.rateBps);
  const lines = [k.lend(u(t.lend)), k.collateral(u(t.collateral)), least ? k.minRate(rate) : k.rate(rate)];
  if (withTerm) lines.push(k.term(t.days === null ? k.unknown : k.days(t.days)));
  if (t.marginBps !== null) lines.push(k.linked(points(t.marginBps)));
  lines.push(k.integrator(t.integrator === 'none' ? k.none : u(t.integrator)));
  return [...lines, ...warningLines(k, t.warnings)];
}

export function loanOpenedText(locale: string | null | undefined, c: number, loanId: string, lender: boolean, t: TermsFields, link: string): { text: string; title: string } {
  const k = COPY[resolve(locale)];
  return { text: [k.loanHead(c, loanId, lender), ...termsLines(k, t, true), k.check(link)].join(' '), title: k.pushTitle };
}

export function offerPostedText(locale: string | null | undefined, c: number, offerId: string, edit: boolean, lend: boolean, t: TermsFields, link: string): { text: string; title: string } {
  const k = COPY[resolve(locale)];
  return { text: [k.offerHead(c, offerId, edit, lend), ...termsLines(k, t, true), k.check(link)].join(' '), title: k.pushTitle };
}

export function slotTermsText(locale: string | null | undefined, c: number, slot: number, t: TermsFields, link: string): { text: string; title: string } {
  const k = COPY[resolve(locale)];
  return { text: [k.slotHead(c, slot), ...termsLines(k, t, false, true), k.check(link)].join(' '), title: k.pushTitle };
}

export function protectionLoweredText(
  locale: string | null | undefined,
  c: number,
  step: ProtectionStep,
  p: { subject: string | null; ref: string | null; lend: string | null; collateral: string | null; level: number | null; previous: number | null; seconds: number | null },
  at: string | null,
  link: string,
): { text: string; title: string } {
  const k = COPY[resolve(locale)];
  const u = (x: string | null) => x ?? k.unknown;
  const n = (x: number | null) => (x === null ? k.unknown : String(x));
  const parts = [k.stepHead(c), k.step[step]({ s: u(p.subject), r: u(p.ref), lend: u(p.lend), coll: u(p.collateral), l: n(p.level), p: n(p.previous), h: p.seconds === null ? k.unknown : String(Math.round(p.seconds / 360) / 10) })];
  if (at !== null) parts.push(k.from(at));
  parts.push(k.notYou(link));
  return { text: parts.join(' '), title: k.pushTitle };
}
