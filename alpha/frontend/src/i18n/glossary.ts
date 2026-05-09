/**
 * Translation glossary for Vaipakam.
 *
 * The strings listed below MUST NOT be translated. They are protocol-
 * specific identifiers, asset / network / standard names, or single-
 * letter risk metrics whose meaning is fixed by the protocol contracts
 * and the surrounding ecosystem. A translation engine that "helpfully"
 * renders "Health Factor" as a fitness term, "VPFI" as a generic
 * acronym, or "ERC-20" as a phonetic transliteration breaks the docs.
 *
 * The translation script (`scripts/translate-i18n.ts`) injects this
 * list into the Claude API prompt as an explicit do-not-translate
 * constraint plus the style notes below. Every locale's output is
 * verified against the glossary post-translation: any `:lender`
 * variant that lost a glossary term is flagged for review before
 * commit.
 */

/** Terms to keep verbatim in every locale. */
export const GLOSSARY_KEEP_VERBATIM = [
  // Protocol identity
  'Vaipakam',
  'VPFI',
  'Diamond',
  'Facet',
  'Escrow', // Capitalised when referring to the per-user proxy contract
  'OFT',
  'LIF', // Loan Initiation Fee acronym

  // Risk metrics — single-letter and well-known abbreviations
  'HF', // Health Factor — short form
  'LTV', // Loan-to-Value
  'APR',
  'APY',
  'BPS',
  'bps',

  // Asset / network names — proper nouns
  'ETH',
  'WETH',
  'USDC',
  'USDT',
  'DAI',
  'BTC',
  'WBTC',
  'NFT',
  'Ethereum',
  'Base',
  'Arbitrum',
  'Optimism',
  'Polygon',
  'BNB Chain',
  'BNB',
  'Solana',
  'LayerZero',
  'Chainlink',
  'Uniswap',
  'PancakeSwap',
  'SushiSwap',
  'Balancer',
  '0x',
  '1inch',
  'Permit2',
  'Blockaid',
  'Push Protocol',
  'Telegram',

  // Standards
  'ERC-20',
  'ERC-721',
  'ERC-1155',
  'ERC-4907',
  'EIP-2535',
  'EIP-712',
  'UUPS',
  'CREATE2',

  // Solidity / facet identifiers (if they appear in copy)
  'OfferFacet',
  'LoanFacet',
  'RepayFacet',
  'RiskFacet',
  'DefaultedFacet',
  'OracleFacet',
  'EscrowFactoryFacet',
  'VaipakamNFTFacet',
  'ProfileFacet',
  'AdminFacet',
  'TreasuryFacet',
  'PrecloseFacet',
  'RefinanceFacet',
  'EarlyWithdrawalFacet',
  'ClaimFacet',
  'KeeperSettingsFacet',
  'VPFIDiscountFacet',
  'VaipakamRewardOApp',
  'VPFIBuyAdapter',
  'VPFIBuyReceiver',
  'VPFIOFTAdapter',
  'VPFIMirror',
  'LibVaipakam',
  'LibVPFIDiscount',
  'LibSwap',
];

/** Style guidance passed to the translation engine alongside the
 *  source JSON. Keep this concise — Claude follows it well in <500
 *  tokens. */
export const GLOSSARY_STYLE_NOTES = `
- Vaipakam is a non-custodial, peer-to-peer DeFi lending protocol where
  one user lends an ERC-20 asset and another posts collateral.
- Translate UI strings into natural, conversational tone. Do not be
  overly formal. Match the register a popular consumer crypto wallet
  app would use in the target language.
- Treat "wallet" as a normal common noun — translate it to the
  natural local equivalent (e.g. "billetera", "ウォレット", "지갑",
  "வாலெட்", "वॉलेट") rather than transliterating "wallet" phonetically.
- "Escrow" (capitalised, as a proper noun referring to a Vaipakam
  contract) stays verbatim. "escrow" (lowercase, as a generic
  financial concept) may be translated to the standard local
  financial-term equivalent if one exists.
- "Health Factor" (the full phrase) may be translated; "HF" (the
  acronym) stays verbatim.
- Asset names and network names are proper nouns — keep them
  verbatim regardless of script.
- Numbers, percentages, dates, decimal punctuation: leave the source
  formatting unchanged. The frontend handles locale-aware formatting
  via Intl.* APIs at render time, not at translation time.
- Keep JSON keys and structure exactly as in the source. Translate
  only the string VALUES.
- Do NOT add commentary, explanations, or wrap the output in
  markdown. Return the translated JSON object directly.
`.trim();

/** Every locale code recognised by URL routing and the LanguagePicker.
 *  Includes both **translated** locales (have a JSON bundle in
 *  `locales/<code>.json` and surface in hreflang / sitemap / per-locale
 *  SEO shells) and **placeholder** locales (recognised so the URL
 *  routing accepts `/<code>/...` paths and the picker can list them,
 *  but they don't ship a translation bundle yet — i18next's
 *  `fallbackLng: 'en'` resolves every key to the English string when
 *  the user picks one).
 *
 *  Adding a translation:
 *    1. Run `npm run translate -- <code>` to generate `locales/<code>.json`
 *    2. Add the import + resource registration in `i18n/index.ts`
 *    3. Move the code from `PLACEHOLDER_LOCALES` to `TRANSLATED_LOCALES` below
 *    4. Flip its `visible` flag in `localeConfig.ts` if you want it in the picker */
export const SUPPORTED_LOCALES = [
  // Translated (10) — have JSON bundles, advertised to crawlers
  'en', // English — source
  'es', // Spanish
  'fr', // French
  'de', // German
  'ja', // Japanese
  'zh', // Chinese (Simplified)
  'hi', // Hindi
  'ar', // Arabic
  'ta', // Tamil
  'ko', // Korean
  // Placeholders (24) — URL routing accepts but no JSON yet; falls
  // back to English text via i18next's fallbackLng. Hidden from the
  // LanguagePicker by default (see localeConfig.ts).
  // South Asia
  'te', // Telugu
  'kn', // Kannada
  'ml', // Malayalam
  'bn', // Bengali
  'mr', // Marathi
  'pa', // Punjabi
  'gu', // Gujarati
  'ur', // Urdu — RTL
  // SE Asia
  'vi', // Vietnamese
  'th', // Thai
  'tl', // Filipino / Tagalog
  'id', // Indonesian (Bahasa Indonesia)
  // Europe (high-volume crypto markets)
  'pt', // Portuguese (Brazilian)
  'ru', // Russian
  'uk', // Ukrainian
  'tr', // Turkish
  'it', // Italian
  'nl', // Dutch
  'pl', // Polish
  'el', // Greek
  'cs', // Czech
  // Middle East — RTL
  'fa', // Persian / Farsi — RTL
  'he', // Hebrew — RTL
  // Africa
  'sw', // Swahili
] as const;

/** Subset of SUPPORTED_LOCALES that ships a translation bundle. Drives
 *  hreflang / sitemap / per-locale SEO shells — those should advertise
 *  ONLY pages that exist as localised content. Listing a placeholder
 *  locale in hreflang would be misleading to search engines because
 *  the actual rendered text is English. */
export const TRANSLATED_LOCALES = [
  'en',
  'es',
  'fr',
  'de',
  'ja',
  'zh',
  'hi',
  'ar',
  'ta',
  'ko',
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type TranslatedLocale = (typeof TRANSLATED_LOCALES)[number];
export type LocaleCode = SupportedLocale;
