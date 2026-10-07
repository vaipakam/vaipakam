/**
 * RL-6 copy gate, in EVERY language the app ships — not only English.
 *
 * The recycling account and loop closure are public transparency surfaces,
 * and the release-gate checklist (VPFITokenomicsRedesignResearch.md §A.4)
 * binds the copy a reader actually sees. The English-only checks beside the
 * components cannot see a translation, and two defects reached every
 * locale that way:
 *
 *  - "no current reading … the platform can STAND BEHIND" became an
 *    explicit guarantee in four languages (garantizar, 担保, 보증, تضمن)
 *    and vouching language in three more (einstehen, répondre, take
 *    responsibility). On a transparency page that reads as the platform
 *    guaranteeing its figures;
 *  - "made good by an OPERATOR-SIZED disbursement" put an operator's
 *    discretion over an amount on screen in all ten, against §A.4's
 *    fourth item (no operator-discretion framing).
 *
 * The English idiom caused the first; each translator then rendered it
 * faithfully. So the guard reads the shipped bundles, per locale, with a
 * term list per language. A term list is required for every bundle that
 * TRANSLATES either section, so translating them into a new language
 * without one fails here rather than shipping unguarded. A bundle that
 * does not carry them renders the English fallback, which `en` covers.
 *
 * WHAT THIS DOES NOT PROVE. A term list catches the vocabulary it names; it
 * cannot judge a paraphrase. It is the floor under human review, not a
 * substitute for it. Terms are chosen to avoid this surface's legitimate
 * vocabulary — e.g. Spanish "respaldar" is the factual "backed" of the
 * backing question and is NOT listed; Arabic "تقدير" means "estimate" here
 * and is NOT listed; Hindi "मूल्य" (value) and "कमी" (shortfall) are NOT
 * listed, nor "आय" (income), which is a substring of "आया" (came) and
 * cannot be word-bounded in Devanagari by a JS regex — and each listed
 * term names the RL-6 rule it enforces.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const localesDir = resolve(__dirname, '..', '..', 'i18n', 'locales');

/** The sections that render on the two public surfaces. */
const SECTIONS = ['recycling', 'loopClosure'] as const;

/**
 * Per-locale forbidden vocabulary, by RL-6 rule:
 *  - guarantee / vouch: the platform standing behind a figure;
 *  - discretion: an operator or team deciding or sizing an amount;
 *  - return: yield, rate, interest, income, dividend;
 *  - market: price, scarcity, deflation.
 */
const FORBIDDEN: Record<string, { guarantee: RegExp; discretion: RegExp; returns: RegExp; market: RegExp }> = {
  en: {
    guarantee: /guarant|stand(s|ing)? behind|vouch|underwrit/i,
    discretion: /operator|discretion|we decide|the team (decides|allocates)|allocated by/i,
    returns: /\bapr\b|\bapy\b|yield|income|interest|dividend|revenue share|compound/i,
    market: /\bprice|scarc|deflation/i,
  },
  de: {
    guarantee: /garant|einsteh|bürg|verbürg/i,
    discretion: /betreiber|ermessen/i,
    // Word-initial: "Vertrag" (contract) contains "ertrag".
    returns: /rendite|\bzins|dividend|\bertrag/i,
    market: /preis|knappheit|deflation/i,
  },
  es: {
    guarantee: /garantiz|garantía|avalar|avala/i,
    discretion: /operador|discreci/i,
    returns: /rendimiento|interés|rentabilidad|dividend/i,
    market: /precio|escasez|deflaci/i,
  },
  fr: {
    guarantee: /garanti|répond(re)?\b|cautionn|se porte garant/i,
    discretion: /opérateur|discrétion/i,
    returns: /rendement|intérêt|dividende/i,
    market: /\bprix\b|rareté|déflation/i,
  },
  ar: {
    guarantee: /تضمن|يضمن|ضمان|نضمن/,
    discretion: /مشغّل|مشغل|حسب تقدير/,
    returns: /عائد|فائدة|أرباح موزعة/,
    market: /سعر|ندرة|انكماش/,
  },
  hi: {
    guarantee: /गारंटी|ज़िम्मेदारी|जिम्मेदारी|ज़मानत/,
    discretion: /ऑपरेटर|विवेक/,
    returns: /प्रतिफल|ब्याज|लाभांश|आमदनी/,
    market: /कीमत|दुर्लभ|अपस्फीति/,
  },
  ja: {
    guarantee: /保証|責任を持|担保/,
    discretion: /オペレーター|運営者|裁量/,
    returns: /利回り|利息|金利|配当|収益/,
    market: /価格|希少|デフレ/,
  },
  ko: {
    guarantee: /보증|보장|책임질/,
    discretion: /운영자|재량/,
    returns: /수익률|이자|배당|수익/,
    market: /가격|희소|디플레/,
  },
  ta: {
    guarantee: /உத்தரவாத|பொறுப்பேற்க/,
    discretion: /இயக்குநர்|விருப்புரிமை/,
    returns: /வட்டி|ஈவுத்தொகை|வருமானம்/,
    market: /விலை|பற்றாக்குறை/,
  },
  zh: {
    guarantee: /担保|保证|负责/,
    discretion: /运营方|运营者|酌情|自行决定/,
    returns: /收益率|利息|年化|分红|收益/,
    market: /价格|稀缺|通缩/,
  },
};

type Leaf = { key: string; value: string };

function leaves(node: unknown, prefix: string, out: Leaf[] = []): Leaf[] {
  if (typeof node === 'string') out.push({ key: prefix, value: node });
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) leaves(v, `${prefix}.${k}`, out);
  }
  return out;
}

const bundles = readdirSync(localesDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({
    locale: f.replace(/\.json$/, ''),
    json: JSON.parse(readFileSync(resolve(localesDir, f), 'utf8')) as {
      copy?: Record<string, unknown>;
    },
  }))
  // Only bundles that translate a section render it; the rest fall back
  // to English, which the `en` bundle (the copy.ts template) covers.
  .filter(({ json }) => SECTIONS.some((s) => json.copy?.[s] !== undefined));

describe('RL-6 copy gate across every shipped locale (recycling + loop closure)', () => {
  it('reads every translating bundle, and every one has a term list', () => {
    // Non-vacuity: the directory scan found English and the nine shipped
    // translations, and none of them is unguarded.
    expect(bundles.length).toBeGreaterThanOrEqual(10);
    expect(bundles.map((b) => b.locale)).toContain('en');
    expect(bundles.map((b) => b.locale).filter((l) => !(l in FORBIDDEN))).toEqual([]);
  });

  it.each(bundles.map((b) => [b.locale, b] as const))(
    '%s: no guarantee, discretion, return or market vocabulary',
    (locale, { json }) => {
      const rules = FORBIDDEN[locale];
      const found: string[] = [];
      let scanned = 0;
      for (const section of SECTIONS) {
        for (const { key, value } of leaves(json.copy?.[section], `copy.${section}`)) {
          scanned += 1;
          for (const [rule, re] of Object.entries(rules)) {
            const m = value.match(re);
            if (m) found.push(`${key} [${rule}] "${m[0]}"`);
          }
        }
      }
      // "Scanned nothing" must not pass as clean.
      expect(scanned).toBeGreaterThan(100);
      expect(found).toEqual([]);
    },
  );

  it('the guard can fail: the withdrawn wording trips it in every language', () => {
    // The two defects this file was written for, as each bundle shipped
    // them. If a term list is loosened until these pass, this fails.
    const withdrawn: Record<string, string[]> = {
      en: ['no current reading of those the platform can stand behind', 'an operator-sized disbursement'],
      de: ['für die die Plattform einstehen kann', 'von einem Betreiber bemessene Auszahlung'],
      es: ['que la plataforma pueda garantizar', 'un desembolso dimensionado por un operador'],
      fr: ['dont elle puisse répondre', 'un versement dimensionné par un opérateur'],
      ar: ['تستطيع المنصة أن تضمنها', 'بصرفٍ حدّد مشغّلٌ مقداره'],
      hi: ['जिसकी ज़िम्मेदारी प्लेटफ़ॉर्म ले सके', 'ऑपरेटर द्वारा तय किए गए भुगतान'],
      ja: ['プラットフォームが責任を持てる', 'オペレーターが金額を決めた支払い'],
      ko: ['플랫폼이 보증할 수 있는', '운영자가 금액을 정한 지급'],
      ta: ['தளம் பொறுப்பேற்கக்கூடிய', 'இயக்குநர் நிர்ணயித்த வழங்கல்'],
      zh: ['平台能够担保', '由运营方确定金额的拨付'],
    };
    for (const [locale, phrases] of Object.entries(withdrawn)) {
      const { guarantee, discretion } = FORBIDDEN[locale];
      expect(guarantee.test(phrases[0]), `${locale} guarantee`).toBe(true);
      expect(discretion.test(phrases[1]), `${locale} discretion`).toBe(true);
    }
  });
});
