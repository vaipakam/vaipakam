// packages/lib/src/telegramAlerts/termsCopy.ts
//
// #3734 — the alert a wallet with standing commitments gets when a material
// change to the Terms is announced (`LegalFacet.TosAnnounced`). From the time
// it comes into force, a wallet that has not accepted the version then in
// force takes on no new position: its open offers, Auto-lend slots and
// standing instructions stop filling and running, and are not cancelled. The
// message says which of those the wallet has, when the change comes into
// force, and that accepting in the app keeps them working.
//
// One catalogue per locale, falling back to English, like `standingCopy.ts`.

import { SUPPORTED_LOCALES, type Locale } from './hfCopy';

/** What a wallet holds that the change stops: an open offer, an Auto-lend
 *  slot, a standing instruction on a loan. */
export const TERMS_HOLDS = ['offer', 'autoLend', 'standing'] as const;
export type TermsHold = (typeof TERMS_HOLDS)[number];

function resolve(s: string | null | undefined): Locale {
  return s && (SUPPORTED_LOCALES as readonly string[]).includes(s) ? (s as Locale) : 'en';
}

interface Copy {
  hold: Record<TermsHold, string>;
  /** `chain` the network's name, `version` the Terms version to accept,
   *  `when` the UTC time it comes into force, `holds` the wallet's
   *  commitments already joined, `link` the app. */
  announced: (chain: string, version: number, when: string, holds: string, link: string) => string;
  /** How a list of two or more is joined: all but the last, and the last. */
  join: (head: string[], last: string) => string;
  pushTitle: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    hold: { offer: 'open offers', autoLend: 'Auto-lend', standing: 'standing instructions' },
    announced: (chain, v, when, holds, link) =>
      `The Terms of Use on ${chain} are changing. Version ${v} comes into force on ${when} UTC. From then, your ${holds} stop filling and running until you accept version ${v}. Nothing is cancelled. To keep them working, open the app with this wallet and accept the new Terms: ${link}`,
    join: (head, last) => `${head.join(', ')} and ${last}`,
    pushTitle: 'Vaipakam Terms change',
  },
  es: {
    hold: { offer: 'ofertas abiertas', autoLend: 'Auto-lend', standing: 'instrucciones permanentes' },
    announced: (chain, v, when, holds, link) =>
      `Los Términos de uso en ${chain} van a cambiar. La versión ${v} entra en vigor el ${when} UTC. Desde entonces, tus ${holds} dejan de ejecutarse hasta que aceptes la versión ${v}. No se cancela nada. Para que sigan funcionando, abre la app con esta billetera y acepta los nuevos Términos: ${link}`,
    join: (head, last) => `${head.join(', ')} y ${last}`,
    pushTitle: 'Cambio en los Términos de Vaipakam',
  },
  fr: {
    hold: { offer: 'offres ouvertes', autoLend: 'Auto-lend', standing: 'instructions permanentes' },
    announced: (chain, v, when, holds, link) =>
      `Les Conditions d'utilisation sur ${chain} changent. La version ${v} entre en vigueur le ${when} UTC. À partir de là, vos ${holds} cessent de s'exécuter jusqu'à ce que vous acceptiez la version ${v}. Rien n'est annulé. Pour qu'elles continuent de fonctionner, ouvrez l'app avec ce portefeuille et acceptez les nouvelles Conditions : ${link}`,
    join: (head, last) => `${head.join(', ')} et ${last}`,
    pushTitle: 'Changement des Conditions Vaipakam',
  },
  de: {
    hold: { offer: 'offenen Angebote', autoLend: 'Auto-lend', standing: 'Daueraufträge' },
    announced: (chain, v, when, holds, link) =>
      `Die Nutzungsbedingungen auf ${chain} ändern sich. Version ${v} tritt am ${when} UTC in Kraft. Ab dann werden deine ${holds} nicht mehr ausgeführt, bis du Version ${v} akzeptierst. Nichts wird storniert. Damit sie weiterlaufen, öffne die App mit dieser Wallet und akzeptiere die neuen Bedingungen: ${link}`,
    join: (head, last) => `${head.join(', ')} und ${last}`,
    pushTitle: 'Änderung der Vaipakam-Bedingungen',
  },
  ja: {
    hold: { offer: 'オープンなオファー', autoLend: 'Auto-lend', standing: '継続指示' },
    announced: (chain, v, when, holds, link) =>
      `${chain} の利用規約が変わります。バージョン ${v} は ${when} UTC に発効します。それ以降、バージョン ${v} に同意するまで、あなたの${holds}は約定・実行されません。何もキャンセルされません。引き続き機能させるには、このウォレットでアプリを開き、新しい規約に同意してください: ${link}`,
    join: (head, last) => `${head.join('、')}と${last}`,
    pushTitle: 'Vaipakam 利用規約の変更',
  },
  zh: {
    hold: { offer: '未成交报价', autoLend: 'Auto-lend', standing: '常设指令' },
    announced: (chain, v, when, holds, link) =>
      `${chain} 上的使用条款即将变更。版本 ${v} 将于 ${when} UTC 生效。从那时起，在你接受版本 ${v} 之前，你的${holds}将停止成交和执行。不会取消任何内容。如需继续使用，请用此钱包打开应用并接受新条款：${link}`,
    join: (head, last) => `${head.join('、')}和${last}`,
    pushTitle: 'Vaipakam 条款变更',
  },
  ko: {
    hold: { offer: '열린 오퍼', autoLend: 'Auto-lend', standing: '상시 지시' },
    announced: (chain, v, when, holds, link) =>
      `${chain}의 이용약관이 변경됩니다. 버전 ${v}은(는) ${when} UTC에 발효됩니다. 그때부터 버전 ${v}에 동의할 때까지 ${holds}이(가) 체결·실행되지 않습니다. 취소되는 것은 없습니다. 계속 작동하게 하려면 이 지갑으로 앱을 열고 새 약관에 동의하세요: ${link}`,
    join: (head, last) => `${head.join(', ')} 및 ${last}`,
    pushTitle: 'Vaipakam 약관 변경',
  },
  hi: {
    hold: { offer: 'खुले ऑफ़र', autoLend: 'Auto-lend', standing: 'स्थायी निर्देश' },
    announced: (chain, v, when, holds, link) =>
      `${chain} पर उपयोग की शर्तें बदल रही हैं। संस्करण ${v} ${when} UTC से लागू होगा। तब से, जब तक आप संस्करण ${v} स्वीकार नहीं करते, आपके ${holds} नहीं चलेंगे। कुछ भी रद्द नहीं होता। उन्हें चालू रखने के लिए इस वॉलेट से ऐप खोलें और नई शर्तें स्वीकार करें: ${link}`,
    join: (head, last) => `${head.join(', ')} और ${last}`,
    pushTitle: 'Vaipakam शर्तों में बदलाव',
  },
  ta: {
    hold: { offer: 'திறந்த சலுகைகள்', autoLend: 'Auto-lend', standing: 'நிலையான அறிவுறுத்தல்கள்' },
    announced: (chain, v, when, holds, link) =>
      `${chain} இல் பயன்பாட்டு விதிமுறைகள் மாறுகின்றன. பதிப்பு ${v} ${when} UTC முதல் நடைமுறைக்கு வருகிறது. அதன்பின், நீங்கள் பதிப்பு ${v} ஐ ஏற்கும் வரை உங்கள் ${holds} இயங்காது. எதுவும் ரத்து செய்யப்படாது. அவை தொடர்ந்து இயங்க, இந்த வாலட்டுடன் செயலியைத் திறந்து புதிய விதிமுறைகளை ஏற்கவும்: ${link}`,
    join: (head, last) => `${head.join(', ')} மற்றும் ${last}`,
    pushTitle: 'Vaipakam விதிமுறை மாற்றம்',
  },
  ar: {
    hold: { offer: 'العروض المفتوحة', autoLend: 'Auto-lend', standing: 'التعليمات الدائمة' },
    announced: (chain, v, when, holds, link) =>
      `ستتغير شروط الاستخدام على ${chain}. يسري الإصدار ${v} في ${when} UTC. ومن حينها تتوقف ${holds} عن التنفيذ حتى توافق على الإصدار ${v}. لا يُلغى شيء. لتبقى تعمل، افتح التطبيق بهذه المحفظة ووافق على الشروط الجديدة: ${link}`,
    join: (head, last) => `${head.join('، ')} و${last}`,
    pushTitle: 'تغيير شروط Vaipakam',
  },
};

/** The copy for `locale`, English when it is not one this catalogue has. */
function termsCopy(locale: string | null | undefined): Copy {
  return COPY[resolve(locale)];
}

/** The announcement message in `locale`. `holds` is non-empty and in
 *  {@link TERMS_HOLDS} order. */
export function termsAnnouncedText(
  locale: string | null | undefined,
  chain: string,
  version: number,
  when: string,
  holds: readonly TermsHold[],
  link: string,
): { text: string; title: string } {
  const c = termsCopy(locale);
  const names = holds.map((h) => c.hold[h]);
  const list = names.length === 1 ? names[0] : c.join(names.slice(0, -1), names[names.length - 1]);
  return { text: c.announced(chain, version, when, list, link), title: c.pushTitle };
}
