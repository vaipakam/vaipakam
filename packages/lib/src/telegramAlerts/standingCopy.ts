// packages/lib/src/telegramAlerts/standingCopy.ts
//
// #3681 — what a borrower is told about the standing instructions on a loan:
// the reserve an instruction spends is too low for what it will next pay, a
// collateral top-up ran, or an instruction was skipped and moved nothing.
// One catalogue per locale, falling back to English, like `protectedCopy.ts`.
//
// Every message says what the chain showed and nothing more. A figure is the
// one the keeper read from the loan's own view or from the event, already
// written out with its token (`plainField`), and a figure it could not read is
// said to be unknown rather than left out. "Too low" says what the instruction
// will then do (a repayment is all or nothing; an interest payment pays what
// the reserve holds), never that the loan will default.

import { SUPPORTED_LOCALES, type Locale } from './hfCopy';

function resolve(s: string | null | undefined): Locale {
  return s && (SUPPORTED_LOCALES as readonly string[]).includes(s) ? (s as Locale) : 'en';
}

/** The three instructions a borrower can leave on a loan. */
export const STANDING_INSTRUCTIONS = ['topUp', 'interest', 'repay'] as const;
export type StandingInstruction = (typeof STANDING_INSTRUCTIONS)[number];

/** Why the contract skipped an instruction (`StandingInstructionSkipped.reason`,
 *  1-based, in the contract's order). */
export const STANDING_SKIP_REASONS = [
  'holderChanged',
  'reserveEmpty',
  'reserveShort',
  'loanBusy',
  'priceUnavailable',
  'paused',
  'accountLocked',
  'notConsolidated',
] as const;
export type StandingSkipReason = (typeof STANDING_SKIP_REASONS)[number];

/** The reason name for the contract's skip code, or null for a code this
 *  catalogue does not know. */
export function standingSkipReason(code: number): StandingSkipReason | null {
  return STANDING_SKIP_REASONS[code - 1] ?? null;
}

/** `l`: the loan as the message names it ("loan #5 on Base Sepolia");
 *  `when`: a UTC time, written out; `link`: the loan's page in the app. */
type Copy = {
  loan: (id: number, chain: string) => string;
  instruction: Record<StandingInstruction, string>;
  /** The reserve this instruction spends is empty. `when`: when it next
   *  needs it, or null when that is not a time (the top-up). */
  lowEmpty: (l: string, i: StandingInstruction, when: string | null, link: string) => string;
  /** The payment reserve is `missing` short of what is due at `when`. Only
   *  the repayment and the interest payment spend a known amount. */
  lowShort: (l: string, i: 'interest' | 'repay', missing: string, when: string, link: string) => string;
  /** `after`: the health factor after, or null when it was not read. */
  topUpRan: (l: string, amount: string, before: string, after: string | null, left: string, link: string) => string;
  /** `missing`: how much the reserve was short, when the reason is a short
   *  reserve and the event carried it. */
  skipped: (l: string, i: StandingInstruction, reason: StandingSkipReason, missing: string | null, link: string) => string;
  reason: Record<StandingSkipReason, string>;
  pushTitle: string;
};

const COPY: Record<Locale, Copy> = {
  en: {
    loan: (id, chain) => `loan #${id} on ${chain}`,
    instruction: { topUp: 'automatic collateral top-up', interest: 'automatic interest payment', repay: 'automatic repayment' },
    lowEmpty: (l, i, when, link) =>
      i === 'topUp'
        ? `The collateral reserve for ${l} is empty, so the automatic collateral top-up has nothing to add if the health factor falls under your trigger. Add collateral to the reserve in the app: ${link}`
        : i === 'repay'
          ? `The payment reserve for ${l} is empty, so the automatic repayment cannot run${when ? ` when it falls due (${when} UTC)` : ''}. It repays only when the reserve covers the whole repayment. Add funds to the reserve or repay in the app: ${link}`
          : `The payment reserve for ${l} is empty, so the automatic interest payment${when ? ` due ${when} UTC` : ''} has nothing to pay. Add funds to the reserve or pay in the app: ${link}`,
    lowShort: (l, i, missing, when, link) =>
      i === 'repay'
        ? `The payment reserve for ${l} is ${missing} short of the repayment due ${when} UTC. The automatic repayment runs only when the reserve covers the whole repayment. Add funds to the reserve or repay in the app: ${link}`
        : `The payment reserve for ${l} is ${missing} short of the interest due ${when} UTC. The automatic interest payment pays what the reserve holds and the rest stays owed. Add funds to the reserve or pay in the app: ${link}`,
    topUpRan: (l, amount, before, after, left, link) =>
      `The automatic collateral top-up ran on ${l}: ${amount} moved from your collateral reserve into the loan's collateral, inside your vault. Health factor ${before} before, ${after ?? 'not read'} after. Left in the collateral reserve: ${left}. ${link}`,
    skipped: (l, i, reason, missing, link) =>
      `The ${COPY.en.instruction[i]} on ${l} did not run, and nothing moved: ${COPY.en.reason[reason]}${missing ? ` (short by ${missing})` : ''}. ${link}`,
    reason: {
      holderChanged: 'the borrower position is no longer held by the wallet that set the instruction',
      reserveEmpty: 'the reserve it spends is empty',
      reserveShort: 'the payment reserve does not cover the whole repayment',
      loanBusy: 'a sale, offset, refinance request or swap-to-repay order is open on the loan',
      priceUnavailable: 'the price or health factor could not be read',
      paused: 'the platform or the asset is paused',
      accountLocked: 'your protected account is locked or was replaced',
      notConsolidated: 'the position moved and its collateral is not yet in the new holder\'s vault',
    },
    pushTitle: 'Vaipakam standing instruction',
  },
  es: {
    loan: (id, chain) => `el préstamo #${id} en ${chain}`,
    instruction: { topUp: 'recarga automática de colateral', interest: 'pago automático de intereses', repay: 'reembolso automático' },
    lowEmpty: (l, i, when, link) =>
      i === 'topUp'
        ? `La reserva de colateral de ${l} está vacía, así que la recarga automática de colateral no tiene nada que añadir si el factor de salud cae por debajo de tu umbral. Añade colateral a la reserva en la app: ${link}`
        : i === 'repay'
          ? `La reserva de pago de ${l} está vacía, así que el reembolso automático no puede ejecutarse${when ? ` a su vencimiento (${when} UTC)` : ''}. Solo reembolsa cuando la reserva cubre el reembolso completo. Añade fondos a la reserva o reembolsa en la app: ${link}`
          : `La reserva de pago de ${l} está vacía, así que el pago automático de intereses${when ? ` con vencimiento ${when} UTC` : ''} no tiene nada que pagar. Añade fondos a la reserva o paga en la app: ${link}`,
    lowShort: (l, i, missing, when, link) =>
      i === 'repay'
        ? `A la reserva de pago de ${l} le faltan ${missing} para el reembolso con vencimiento ${when} UTC. El reembolso automático solo se ejecuta cuando la reserva cubre el reembolso completo. Añade fondos a la reserva o reembolsa en la app: ${link}`
        : `A la reserva de pago de ${l} le faltan ${missing} para los intereses con vencimiento ${when} UTC. El pago automático de intereses paga lo que tenga la reserva y el resto sigue pendiente. Añade fondos a la reserva o paga en la app: ${link}`,
    topUpRan: (l, amount, before, after, left, link) =>
      `Se ejecutó la recarga automática de colateral en ${l}: ${amount} pasaron de tu reserva de colateral al colateral del préstamo, dentro de tu bóveda. Factor de salud ${before} antes, ${after ?? 'no leído'} después. Queda en la reserva de colateral: ${left}. ${link}`,
    skipped: (l, i, reason, missing, link) =>
      `La ${COPY.es.instruction[i]} de ${l} no se ejecutó y no se movió nada: ${COPY.es.reason[reason]}${missing ? ` (faltan ${missing})` : ''}. ${link}`,
    reason: {
      holderChanged: 'la posición del prestatario ya no la tiene la billetera que fijó la instrucción',
      reserveEmpty: 'la reserva que usa está vacía',
      reserveShort: 'la reserva de pago no cubre el reembolso completo',
      loanBusy: 'hay una venta, compensación, solicitud de refinanciación u orden de swap-to-repay abierta en el préstamo',
      priceUnavailable: 'no se pudo leer el precio o el factor de salud',
      paused: 'la plataforma o el activo está en pausa',
      accountLocked: 'tu cuenta protegida está bloqueada o fue reemplazada',
      notConsolidated: 'la posición cambió de manos y su colateral aún no está en la bóveda del nuevo titular',
    },
    pushTitle: 'Instrucción permanente de Vaipakam',
  },
  fr: {
    loan: (id, chain) => `le prêt n°${id} sur ${chain}`,
    instruction: { topUp: 'complément automatique de garantie', interest: 'paiement automatique des intérêts', repay: 'remboursement automatique' },
    lowEmpty: (l, i, when, link) =>
      i === 'topUp'
        ? `La réserve de garantie pour ${l} est vide : le complément automatique de garantie n'a rien à ajouter si le facteur de santé passe sous votre seuil. Ajoutez de la garantie à la réserve dans l'app : ${link}`
        : i === 'repay'
          ? `La réserve de paiement pour ${l} est vide : le remboursement automatique ne peut pas s'exécuter${when ? ` à l'échéance (${when} UTC)` : ''}. Il ne rembourse que si la réserve couvre tout le remboursement. Alimentez la réserve ou remboursez dans l'app : ${link}`
          : `La réserve de paiement pour ${l} est vide : le paiement automatique des intérêts${when ? ` dus le ${when} UTC` : ''} n'a rien à payer. Alimentez la réserve ou payez dans l'app : ${link}`,
    lowShort: (l, i, missing, when, link) =>
      i === 'repay'
        ? `Il manque ${missing} à la réserve de paiement pour ${l} pour le remboursement dû le ${when} UTC. Le remboursement automatique ne s'exécute que si la réserve couvre tout le remboursement. Alimentez la réserve ou remboursez dans l'app : ${link}`
        : `Il manque ${missing} à la réserve de paiement pour ${l} pour les intérêts dus le ${when} UTC. Le paiement automatique des intérêts paie ce que contient la réserve et le reste reste dû. Alimentez la réserve ou payez dans l'app : ${link}`,
    topUpRan: (l, amount, before, after, left, link) =>
      `Le complément automatique de garantie s'est exécuté sur ${l} : ${amount} sont passés de votre réserve de garantie à la garantie du prêt, dans votre coffre. Facteur de santé ${before} avant, ${after ?? 'non lu'} après. Reste dans la réserve de garantie : ${left}. ${link}`,
    skipped: (l, i, reason, missing, link) =>
      `Le ${COPY.fr.instruction[i]} sur ${l} ne s'est pas exécuté et rien n'a bougé : ${COPY.fr.reason[reason]}${missing ? ` (il manque ${missing})` : ''}. ${link}`,
    reason: {
      holderChanged: "la position emprunteur n'est plus détenue par le portefeuille qui a fixé l'instruction",
      reserveEmpty: "la réserve qu'elle utilise est vide",
      reserveShort: 'la réserve de paiement ne couvre pas tout le remboursement',
      loanBusy: 'une vente, une compensation, une demande de refinancement ou un ordre swap-to-repay est ouvert sur le prêt',
      priceUnavailable: "le prix ou le facteur de santé n'a pas pu être lu",
      paused: "la plateforme ou l'actif est en pause",
      accountLocked: 'votre compte protégé est verrouillé ou a été remplacé',
      notConsolidated: "la position a changé de mains et sa garantie n'est pas encore dans le coffre du nouveau détenteur",
    },
    pushTitle: 'Instruction permanente Vaipakam',
  },
  de: {
    loan: (id, chain) => `Darlehen #${id} auf ${chain}`,
    instruction: { topUp: 'automatische Sicherheiten-Aufstockung', interest: 'automatische Zinszahlung', repay: 'automatische Rückzahlung' },
    lowEmpty: (l, i, when, link) =>
      i === 'topUp'
        ? `Die Sicherheitenreserve für ${l} ist leer, daher hat die automatische Sicherheiten-Aufstockung nichts hinzuzufügen, wenn der Health Factor unter deinen Auslöser fällt. Füge der Reserve in der App Sicherheiten hinzu: ${link}`
        : i === 'repay'
          ? `Die Zahlungsreserve für ${l} ist leer, daher kann die automatische Rückzahlung${when ? ` bei Fälligkeit (${when} UTC)` : ''} nicht laufen. Sie zahlt nur zurück, wenn die Reserve die ganze Rückzahlung deckt. Fülle die Reserve auf oder zahle in der App zurück: ${link}`
          : `Die Zahlungsreserve für ${l} ist leer, daher hat die automatische Zinszahlung${when ? ` (fällig ${when} UTC)` : ''} nichts zu zahlen. Fülle die Reserve auf oder zahle in der App: ${link}`,
    lowShort: (l, i, missing, when, link) =>
      i === 'repay'
        ? `Der Zahlungsreserve für ${l} fehlen ${missing} für die am ${when} UTC fällige Rückzahlung. Die automatische Rückzahlung läuft nur, wenn die Reserve die ganze Rückzahlung deckt. Fülle die Reserve auf oder zahle in der App zurück: ${link}`
        : `Der Zahlungsreserve für ${l} fehlen ${missing} für die am ${when} UTC fälligen Zinsen. Die automatische Zinszahlung zahlt, was die Reserve hält, der Rest bleibt geschuldet. Fülle die Reserve auf oder zahle in der App: ${link}`,
    topUpRan: (l, amount, before, after, left, link) =>
      `Die automatische Sicherheiten-Aufstockung lief auf ${l}: ${amount} wurden aus deiner Sicherheitenreserve in die Sicherheiten des Darlehens verschoben, innerhalb deines Tresors. Health Factor vorher ${before}, nachher ${after ?? 'nicht gelesen'}. In der Sicherheitenreserve verbleiben: ${left}. ${link}`,
    skipped: (l, i, reason, missing, link) =>
      `Die ${COPY.de.instruction[i]} auf ${l} lief nicht, und nichts wurde bewegt: ${COPY.de.reason[reason]}${missing ? ` (es fehlen ${missing})` : ''}. ${link}`,
    reason: {
      holderChanged: 'die Kreditnehmerposition gehört nicht mehr der Wallet, die die Anweisung gesetzt hat',
      reserveEmpty: 'die Reserve, aus der sie zahlt, ist leer',
      reserveShort: 'die Zahlungsreserve deckt nicht die ganze Rückzahlung',
      loanBusy: 'auf dem Darlehen ist ein Verkauf, ein Offset, eine Refinanzierungsanfrage oder ein Swap-to-Repay-Auftrag offen',
      priceUnavailable: 'der Preis oder der Health Factor konnte nicht gelesen werden',
      paused: 'die Plattform oder der Vermögenswert ist pausiert',
      accountLocked: 'dein geschütztes Konto ist gesperrt oder wurde ersetzt',
      notConsolidated: 'die Position hat den Inhaber gewechselt und ihre Sicherheiten liegen noch nicht im Tresor des neuen Inhabers',
    },
    pushTitle: 'Vaipakam Daueranweisung',
  },
  ja: {
    loan: (id, chain) => `${chain} のローン #${id}`,
    instruction: { topUp: '担保の自動追加', interest: '利息の自動支払い', repay: '自動返済' },
    lowEmpty: (l, i, when, link) =>
      i === 'topUp'
        ? `${l} の担保リザーブが空のため、ヘルスファクターがトリガーを下回っても担保の自動追加で追加できるものがありません。アプリでリザーブに担保を追加してください: ${link}`
        : i === 'repay'
          ? `${l} の支払いリザーブが空のため、自動返済を${when ? `期日（${when} UTC）に` : ''}実行できません。自動返済はリザーブが返済額の全額をまかなえる場合にのみ実行されます。アプリでリザーブに資金を追加するか、返済してください: ${link}`
          : `${l} の支払いリザーブが空のため、${when ? `${when} UTC 期日の` : ''}利息の自動支払いで支払えるものがありません。アプリでリザーブに資金を追加するか、支払ってください: ${link}`,
    lowShort: (l, i, missing, when, link) =>
      i === 'repay'
        ? `${l} の支払いリザーブは、${when} UTC 期日の返済に ${missing} 不足しています。自動返済はリザーブが返済額の全額をまかなえる場合にのみ実行されます。アプリでリザーブに資金を追加するか、返済してください: ${link}`
        : `${l} の支払いリザーブは、${when} UTC 期日の利息に ${missing} 不足しています。利息の自動支払いはリザーブにある分を支払い、残りは未払いのまま残ります。アプリでリザーブに資金を追加するか、支払ってください: ${link}`,
    topUpRan: (l, amount, before, after, left, link) =>
      `${l} で担保の自動追加が実行されました: ${amount} が担保リザーブからローンの担保へ、あなたのボールト内で移動しました。ヘルスファクターは実行前 ${before}、実行後 ${after ?? '読み取れず'}。担保リザーブの残り: ${left}。${link}`,
    skipped: (l, i, reason, missing, link) =>
      `${l} の${COPY.ja.instruction[i]}は実行されず、何も移動していません: ${COPY.ja.reason[reason]}${missing ? `（${missing} 不足）` : ''}。${link}`,
    reason: {
      holderChanged: '借り手ポジションが指示を設定したウォレットの保有ではなくなりました',
      reserveEmpty: '使用するリザーブが空です',
      reserveShort: '支払いリザーブが返済額の全額をまかなえません',
      loanBusy: 'ローンに売却、オフセット、借り換え申請、または swap-to-repay 注文が出ています',
      priceUnavailable: '価格またはヘルスファクターを読み取れませんでした',
      paused: 'プラットフォームまたは資産が一時停止中です',
      accountLocked: '保護アカウントがロックされているか、置き換えられました',
      notConsolidated: 'ポジションが移転し、その担保がまだ新しい保有者のボールトにありません',
    },
    pushTitle: 'Vaipakam 常設指示',
  },
  zh: {
    loan: (id, chain) => `${chain} 上的贷款 #${id}`,
    instruction: { topUp: '自动补充抵押品', interest: '自动支付利息', repay: '自动还款' },
    lowEmpty: (l, i, when, link) =>
      i === 'topUp'
        ? `${l} 的抵押品储备为空，因此健康因子跌破你的触发值时，自动补充抵押品没有可补充的资产。请在应用中向储备添加抵押品：${link}`
        : i === 'repay'
          ? `${l} 的还款储备为空，因此自动还款${when ? `在到期时（${when} UTC）` : ''}无法执行。只有储备足以覆盖全部还款时才会自动还款。请在应用中向储备充值或直接还款：${link}`
          : `${l} 的还款储备为空，因此${when ? ` ${when} UTC 到期的` : ''}自动支付利息没有可支付的资金。请在应用中向储备充值或直接支付：${link}`,
    lowShort: (l, i, missing, when, link) =>
      i === 'repay'
        ? `${l} 的还款储备距 ${when} UTC 到期的还款还差 ${missing}。只有储备足以覆盖全部还款时才会自动还款。请在应用中向储备充值或直接还款：${link}`
        : `${l} 的还款储备距 ${when} UTC 到期的利息还差 ${missing}。自动支付利息会支付储备中现有的金额，其余仍为欠款。请在应用中向储备充值或直接支付：${link}`,
    topUpRan: (l, amount, before, after, left, link) =>
      `${l} 已执行自动补充抵押品：${amount} 已在你的金库内从抵押品储备转入贷款抵押品。健康因子执行前 ${before}，执行后 ${after ?? '未读取'}。抵押品储备剩余：${left}。${link}`,
    skipped: (l, i, reason, missing, link) =>
      `${l} 的${COPY.zh.instruction[i]}未执行，没有任何资产移动：${COPY.zh.reason[reason]}${missing ? `（差 ${missing}）` : ''}。${link}`,
    reason: {
      holderChanged: '借款人头寸已不再由设置该指令的钱包持有',
      reserveEmpty: '它使用的储备为空',
      reserveShort: '还款储备不足以覆盖全部还款',
      loanBusy: '该贷款上有未完成的出售、抵消、再融资请求或 swap-to-repay 订单',
      priceUnavailable: '无法读取价格或健康因子',
      paused: '平台或该资产已暂停',
      accountLocked: '你的受保护账户已锁定或已被替换',
      notConsolidated: '头寸已转移，其抵押品尚未进入新持有人的金库',
    },
    pushTitle: 'Vaipakam 常设指令',
  },
  ko: {
    loan: (id, chain) => `${chain}의 대출 #${id}`,
    instruction: { topUp: '담보 자동 추가', interest: '이자 자동 납부', repay: '자동 상환' },
    lowEmpty: (l, i, when, link) =>
      i === 'topUp'
        ? `${l}의 담보 예비금이 비어 있어, 건전성 지수가 설정한 기준 아래로 떨어져도 담보 자동 추가로 더할 것이 없습니다. 앱에서 예비금에 담보를 추가하세요: ${link}`
        : i === 'repay'
          ? `${l}의 상환 예비금이 비어 있어 자동 상환을${when ? ` 만기(${when} UTC)에` : ''} 실행할 수 없습니다. 자동 상환은 예비금이 상환액 전액을 충당할 때만 실행됩니다. 앱에서 예비금을 채우거나 상환하세요: ${link}`
          : `${l}의 상환 예비금이 비어 있어${when ? ` ${when} UTC 만기의` : ''} 이자 자동 납부로 낼 것이 없습니다. 앱에서 예비금을 채우거나 납부하세요: ${link}`,
    lowShort: (l, i, missing, when, link) =>
      i === 'repay'
        ? `${l}의 상환 예비금이 ${when} UTC 만기 상환액보다 ${missing} 부족합니다. 자동 상환은 예비금이 상환액 전액을 충당할 때만 실행됩니다. 앱에서 예비금을 채우거나 상환하세요: ${link}`
        : `${l}의 상환 예비금이 ${when} UTC 만기 이자보다 ${missing} 부족합니다. 이자 자동 납부는 예비금에 있는 만큼 내고 나머지는 미납으로 남습니다. 앱에서 예비금을 채우거나 납부하세요: ${link}`,
    topUpRan: (l, amount, before, after, left, link) =>
      `${l}에서 담보 자동 추가가 실행되었습니다: ${amount}이(가) 금고 안에서 담보 예비금에서 대출 담보로 옮겨졌습니다. 건전성 지수 실행 전 ${before}, 실행 후 ${after ?? '읽지 못함'}. 담보 예비금 잔액: ${left}. ${link}`,
    skipped: (l, i, reason, missing, link) =>
      `${l}의 ${COPY.ko.instruction[i]}이(가) 실행되지 않았으며 아무것도 옮겨지지 않았습니다: ${COPY.ko.reason[reason]}${missing ? ` (${missing} 부족)` : ''}. ${link}`,
    reason: {
      holderChanged: '차입자 포지션을 더 이상 지시를 설정한 지갑이 보유하고 있지 않습니다',
      reserveEmpty: '사용하는 예비금이 비어 있습니다',
      reserveShort: '상환 예비금이 상환액 전액을 충당하지 못합니다',
      loanBusy: '대출에 판매, 상계, 재융자 요청 또는 swap-to-repay 주문이 열려 있습니다',
      priceUnavailable: '가격 또는 건전성 지수를 읽을 수 없었습니다',
      paused: '플랫폼 또는 자산이 일시 중지되었습니다',
      accountLocked: '보호 계정이 잠겼거나 교체되었습니다',
      notConsolidated: '포지션이 이전되었고 그 담보가 아직 새 보유자의 금고에 없습니다',
    },
    pushTitle: 'Vaipakam 상시 지시',
  },
  hi: {
    loan: (id, chain) => `${chain} पर ऋण #${id}`,
    instruction: { topUp: 'स्वचालित कोलैटरल टॉप-अप', interest: 'स्वचालित ब्याज भुगतान', repay: 'स्वचालित पुनर्भुगतान' },
    lowEmpty: (l, i, when, link) =>
      i === 'topUp'
        ? `${l} का कोलैटरल रिज़र्व खाली है, इसलिए हेल्थ फ़ैक्टर आपके ट्रिगर से नीचे जाने पर स्वचालित कोलैटरल टॉप-अप के पास जोड़ने को कुछ नहीं है। ऐप में रिज़र्व में कोलैटरल जोड़ें: ${link}`
        : i === 'repay'
          ? `${l} का भुगतान रिज़र्व खाली है, इसलिए स्वचालित पुनर्भुगतान${when ? ` नियत समय (${when} UTC) पर` : ''} नहीं चल सकता। यह तभी चुकाता है जब रिज़र्व पूरे पुनर्भुगतान को कवर करे। ऐप में रिज़र्व भरें या चुकाएँ: ${link}`
          : `${l} का भुगतान रिज़र्व खाली है, इसलिए${when ? ` ${when} UTC को देय` : ''} स्वचालित ब्याज भुगतान के पास चुकाने को कुछ नहीं है। ऐप में रिज़र्व भरें या भुगतान करें: ${link}`,
    lowShort: (l, i, missing, when, link) =>
      i === 'repay'
        ? `${l} के भुगतान रिज़र्व में ${when} UTC को देय पुनर्भुगतान के लिए ${missing} कम हैं। स्वचालित पुनर्भुगतान तभी चलता है जब रिज़र्व पूरे पुनर्भुगतान को कवर करे। ऐप में रिज़र्व भरें या चुकाएँ: ${link}`
        : `${l} के भुगतान रिज़र्व में ${when} UTC को देय ब्याज के लिए ${missing} कम हैं। स्वचालित ब्याज भुगतान रिज़र्व में जितना है उतना चुकाता है और बाकी बकाया रहता है। ऐप में रिज़र्व भरें या भुगतान करें: ${link}`,
    topUpRan: (l, amount, before, after, left, link) =>
      `${l} पर स्वचालित कोलैटरल टॉप-अप चला: ${amount} आपके वॉल्ट के भीतर कोलैटरल रिज़र्व से ऋण के कोलैटरल में गया। हेल्थ फ़ैक्टर पहले ${before}, बाद में ${after ?? 'पढ़ा नहीं गया'}। कोलैटरल रिज़र्व में बचा: ${left}। ${link}`,
    skipped: (l, i, reason, missing, link) =>
      `${l} पर ${COPY.hi.instruction[i]} नहीं चला, और कुछ भी नहीं हिला: ${COPY.hi.reason[reason]}${missing ? ` (${missing} कम)` : ''}। ${link}`,
    reason: {
      holderChanged: 'उधारकर्ता पोज़िशन अब उस वॉलेट के पास नहीं है जिसने निर्देश सेट किया था',
      reserveEmpty: 'जिस रिज़र्व से यह खर्च करता है वह खाली है',
      reserveShort: 'भुगतान रिज़र्व पूरे पुनर्भुगतान को कवर नहीं करता',
      loanBusy: 'ऋण पर बिक्री, ऑफ़सेट, रीफ़ाइनेंस अनुरोध या swap-to-repay ऑर्डर खुला है',
      priceUnavailable: 'कीमत या हेल्थ फ़ैक्टर पढ़ा नहीं जा सका',
      paused: 'प्लेटफ़ॉर्म या एसेट रोका गया है',
      accountLocked: 'आपका सुरक्षित खाता लॉक है या बदल दिया गया',
      notConsolidated: 'पोज़िशन का स्वामित्व बदला और उसका कोलैटरल अभी नए धारक के वॉल्ट में नहीं है',
    },
    pushTitle: 'Vaipakam स्थायी निर्देश',
  },
  ta: {
    loan: (id, chain) => `${chain} இல் உள்ள கடன் #${id}`,
    instruction: { topUp: 'தானியங்கி பிணைய நிரப்புதல்', interest: 'தானியங்கி வட்டி செலுத்துதல்', repay: 'தானியங்கி திருப்பிச் செலுத்துதல்' },
    lowEmpty: (l, i, when, link) =>
      i === 'topUp'
        ? `${l} க்கான பிணைய இருப்பு காலியாக உள்ளது, எனவே ஹெல்த் ஃபாக்டர் உங்கள் தூண்டல் அளவுக்குக் கீழே போனால் தானியங்கி பிணைய நிரப்புதலுக்குச் சேர்க்க எதுவும் இல்லை. செயலியில் இருப்பில் பிணையம் சேர்க்கவும்: ${link}`
        : i === 'repay'
          ? `${l} க்கான செலுத்தும் இருப்பு காலியாக உள்ளது, எனவே தானியங்கி திருப்பிச் செலுத்துதல்${when ? ` நிலுவை நேரத்தில் (${when} UTC)` : ''} இயங்க முடியாது. இருப்பு முழுத் தொகையையும் ஈடுசெய்யும்போது மட்டுமே அது செலுத்தும். செயலியில் இருப்பை நிரப்பவும் அல்லது செலுத்தவும்: ${link}`
          : `${l} க்கான செலுத்தும் இருப்பு காலியாக உள்ளது, எனவே${when ? ` ${when} UTC இல் நிலுவையான` : ''} தானியங்கி வட்டி செலுத்துதலுக்குச் செலுத்த எதுவும் இல்லை. செயலியில் இருப்பை நிரப்பவும் அல்லது செலுத்தவும்: ${link}`,
    lowShort: (l, i, missing, when, link) =>
      i === 'repay'
        ? `${l} க்கான செலுத்தும் இருப்பில் ${when} UTC இல் நிலுவையான திருப்பிச் செலுத்துதலுக்கு ${missing} குறைவாக உள்ளது. இருப்பு முழுத் தொகையையும் ஈடுசெய்யும்போது மட்டுமே தானியங்கி திருப்பிச் செலுத்துதல் இயங்கும். செயலியில் இருப்பை நிரப்பவும் அல்லது செலுத்தவும்: ${link}`
        : `${l} க்கான செலுத்தும் இருப்பில் ${when} UTC இல் நிலுவையான வட்டிக்கு ${missing} குறைவாக உள்ளது. தானியங்கி வட்டி செலுத்துதல் இருப்பில் உள்ளதைச் செலுத்தும், மீதி நிலுவையாக இருக்கும். செயலியில் இருப்பை நிரப்பவும் அல்லது செலுத்தவும்: ${link}`,
    topUpRan: (l, amount, before, after, left, link) =>
      `${l} இல் தானியங்கி பிணைய நிரப்புதல் இயங்கியது: ${amount} உங்கள் வால்ட்டுக்குள் பிணைய இருப்பிலிருந்து கடனின் பிணையத்துக்கு நகர்ந்தது. ஹெல்த் ஃபாக்டர் முன்பு ${before}, பின்பு ${after ?? 'படிக்கப்படவில்லை'}. பிணைய இருப்பில் மீதம்: ${left}. ${link}`,
    skipped: (l, i, reason, missing, link) =>
      `${l} இல் ${COPY.ta.instruction[i]} இயங்கவில்லை, எதுவும் நகரவில்லை: ${COPY.ta.reason[reason]}${missing ? ` (${missing} குறைவு)` : ''}. ${link}`,
    reason: {
      holderChanged: 'கடன் வாங்குபவர் நிலையை அறிவுறுத்தலை அமைத்த வாலட் இனி வைத்திருக்கவில்லை',
      reserveEmpty: 'அது செலவிடும் இருப்பு காலியாக உள்ளது',
      reserveShort: 'செலுத்தும் இருப்பு முழுத் திருப்பிச் செலுத்துதலையும் ஈடுசெய்யவில்லை',
      loanBusy: 'கடனில் விற்பனை, ஈடுசெய்தல், மறுநிதியளிப்புக் கோரிக்கை அல்லது swap-to-repay ஆணை திறந்துள்ளது',
      priceUnavailable: 'விலை அல்லது ஹெல்த் ஃபாக்டரைப் படிக்க முடியவில்லை',
      paused: 'தளம் அல்லது சொத்து இடைநிறுத்தப்பட்டுள்ளது',
      accountLocked: 'உங்கள் பாதுகாக்கப்பட்ட கணக்கு பூட்டப்பட்டுள்ளது அல்லது மாற்றப்பட்டது',
      notConsolidated: 'நிலை கைமாறியது, அதன் பிணையம் இன்னும் புதிய வைத்திருப்பவரின் வால்ட்டில் இல்லை',
    },
    pushTitle: 'Vaipakam நிலையான அறிவுறுத்தல்',
  },
  ar: {
    loan: (id, chain) => `القرض رقم ${id} على ${chain}`,
    instruction: { topUp: 'الإضافة التلقائية للضمان', interest: 'الدفع التلقائي للفائدة', repay: 'السداد التلقائي' },
    lowEmpty: (l, i, when, link) =>
      i === 'topUp'
        ? `احتياطي الضمان لـ ${l} فارغ، لذا لا تجد الإضافة التلقائية للضمان ما تضيفه إذا انخفض عامل الصحة دون الحد الذي حددته. أضف ضمانًا إلى الاحتياطي في التطبيق: ${link}`
        : i === 'repay'
          ? `احتياطي الدفع لـ ${l} فارغ، لذا لا يمكن تنفيذ السداد التلقائي${when ? ` عند الاستحقاق (${when} UTC)` : ''}. لا يسدد إلا إذا غطى الاحتياطي السداد كاملًا. موّل الاحتياطي أو سدّد في التطبيق: ${link}`
          : `احتياطي الدفع لـ ${l} فارغ، لذا لا يجد الدفع التلقائي للفائدة${when ? ` المستحقة في ${when} UTC` : ''} ما يدفعه. موّل الاحتياطي أو ادفع في التطبيق: ${link}`,
    lowShort: (l, i, missing, when, link) =>
      i === 'repay'
        ? `ينقص احتياطي الدفع لـ ${l} مبلغ ${missing} عن السداد المستحق في ${when} UTC. لا يُنفَّذ السداد التلقائي إلا إذا غطى الاحتياطي السداد كاملًا. موّل الاحتياطي أو سدّد في التطبيق: ${link}`
        : `ينقص احتياطي الدفع لـ ${l} مبلغ ${missing} عن الفائدة المستحقة في ${when} UTC. يدفع الدفع التلقائي للفائدة ما في الاحتياطي ويبقى الباقي مستحقًا. موّل الاحتياطي أو ادفع في التطبيق: ${link}`,
    topUpRan: (l, amount, before, after, left, link) =>
      `نُفّذت الإضافة التلقائية للضمان على ${l}: انتقل ${amount} من احتياطي الضمان إلى ضمان القرض داخل خزنتك. عامل الصحة قبلها ${before}، وبعدها ${after ?? 'لم يُقرأ'}. المتبقي في احتياطي الضمان: ${left}. ${link}`,
    skipped: (l, i, reason, missing, link) =>
      `لم يُنفَّذ ${COPY.ar.instruction[i]} على ${l}، ولم يتحرك شيء: ${COPY.ar.reason[reason]}${missing ? ` (ينقص ${missing})` : ''}. ${link}`,
    reason: {
      holderChanged: 'لم يعد مركز المقترض بيد المحفظة التي وضعت التعليمات',
      reserveEmpty: 'الاحتياطي الذي يصرف منه فارغ',
      reserveShort: 'احتياطي الدفع لا يغطي السداد كاملًا',
      loanBusy: 'يوجد على القرض بيع أو مقاصة أو طلب إعادة تمويل أو أمر swap-to-repay مفتوح',
      priceUnavailable: 'تعذّرت قراءة السعر أو عامل الصحة',
      paused: 'المنصة أو الأصل متوقف مؤقتًا',
      accountLocked: 'حسابك المحمي مقفل أو جرى استبداله',
      notConsolidated: 'انتقل المركز ولم يصل ضمانه بعد إلى خزنة الحامل الجديد',
    },
    pushTitle: 'تعليمات Vaipakam الدائمة',
  },
};

/** The copy for `locale`, English when it is not one this catalogue has. */
export function standingCopy(locale: string | null | undefined): Copy {
  return COPY[resolve(locale)];
}
