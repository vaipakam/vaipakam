/**
 * Translation glossary for Vaipakam — SHARED across every app surface.
 *
 * The strings listed below MUST NOT be translated. They are protocol-
 * specific identifiers, asset / network / standard names, or single-
 * letter risk metrics whose meaning is fixed by the protocol contracts
 * and the surrounding ecosystem. A translation engine that "helpfully"
 * renders "Health Factor" as a fitness term, "VPFI" as a generic
 * acronym, or "ERC-20" as a phonetic transliteration breaks the docs.
 *
 * The translate script (`packages/i18n/scripts/translate-i18n.ts`)
 * injects this list into the Claude API prompt as an explicit
 * do-not-translate constraint plus the style notes below. Every
 * locale's output is verified against the glossary post-translation:
 * any variant that lost a glossary term is flagged for review before
 * commit.
 *
 * NOTE — `TRANSLATED_LOCALES` is deliberately NOT here. Which subset
 * of SUPPORTED_LOCALES ships an actual translation bundle differs per
 * app (www ships 10; alpha02 starts at English-only with placeholder
 * bundles), and that subset drives each app's hreflang / sitemap /
 * SEO-shell surfaces. Each app owns its own TRANSLATED_LOCALES next
 * to its locales/ directory.
 */

/** Terms to keep verbatim in every locale. */
export const GLOSSARY_KEEP_VERBATIM = [
  // Protocol identity
  'Vaipakam',
  'VPFI',
  'Diamond',
  'Facet',
  'Vault', // Capitalised when referring to the per-user proxy contract
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
  'LayerZero', // Kept verbatim in historical / migration narrative; T-068 (2026-05-18) moved the cross-chain layer to CCIP.
  'Chainlink',
  'CCIP', // Chainlink Cross-Chain Interoperability Protocol (post-T-068).
  'RMN', // Risk Management Network — CCIP's independent re-verification layer.
  'CCT', // CCIP Cross-Chain Token pattern.
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
  'VaultFactoryFacet',
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
  // Pre-T-068 LayerZero-era contracts — kept verbatim in historical
  // copy + ADRs. Replaced by the CCIP-era set immediately below.
  'VaipakamRewardOApp',
  'VPFIOFTAdapter',
  'VPFIMirror',
  // Post-T-068 CCIP-era contracts (2026-05-18 onward).
  'CcipMessenger',
  'VaipakamRewardMessenger',
  'VPFIMirrorToken',
  'VpfiPoolRateGovernor',
  'LockReleaseTokenPool',
  'BurnMintTokenPool',
  'TokenAdminRegistry',
  'GuardianPausable',
  'LibVaipakam',
  'LibVPFIDiscount',
  'LibSwap',
];

/** Style guidance passed to the translation engine alongside the
 *  source JSON. Keep this concise — Claude follows it well in <500
 *  tokens. */
export const GLOSSARY_STYLE_NOTES = `
- Vaipakam is a non-custodial, vault-to-vault DeFi lending protocol where
  one user lends an ERC-20 asset and another posts collateral.
- Translate UI strings into natural, conversational tone. Do not be
  overly formal. Match the register a popular consumer crypto wallet
  app would use in the target language.
- Treat "wallet" as a normal common noun — translate it to the
  natural local equivalent (e.g. "billetera", "ウォレット", "지갑",
  "வாலெட்", "वॉलेट") rather than transliterating "wallet" phonetically.
- "Vault" (capitalised, as a proper noun referring to a Vaipakam
  contract) stays verbatim. "vault" (lowercase, as a generic
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

/** Every locale code recognised by URL routing and the LanguagePicker
 *  across all Vaipakam surfaces. Whether a given app actually SHIPS a
 *  translation for a code is that app's `TRANSLATED_LOCALES` concern;
 *  this registry only fixes the universe of codes so URL routing,
 *  cookie validation, and picker plumbing agree everywhere. */
export const SUPPORTED_LOCALES = [
  // Tier 1 — the 10 locales www already ships translated
  'en', // English — source
  'es', // Spanish
  'fr', // French
  'de', // German
  'ja', // Japanese
  'zh', // Chinese (Simplified)
  'hi', // Hindi
  'ar', // Arabic — RTL
  'ta', // Tamil
  'ko', // Korean
  // Tier 2 — recognised codes awaiting translation bundles.
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

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type LocaleCode = SupportedLocale;

/** Human/prompt-facing locale names, including per-language register
 *  guidance consumed by the translate script's prompt. Shared so every
 *  app's translation run applies identical register decisions. */
export const LOCALE_NAMES: Record<LocaleCode, string> = {
  en: 'English',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
  de: 'German (Deutsch)',
  ja: 'Japanese (日本語)',
  zh: 'Simplified Chinese (中文)',
  hi: 'Hindi (हिन्दी)',
  ar: 'Arabic (العربية)',
  ta: 'Tamil (தமிழ்)',
  ko: 'Korean (한국어)',
  te: 'Telugu (తెలుగు)',
  kn: 'Kannada (ಕನ್ನಡ)',
  ml: 'Malayalam (മലയാളം)',
  bn: 'Bengali (বাংলা)',
  mr: 'Marathi (मराठी)',
  pa: 'Punjabi (ਪੰਜਾਬੀ)',
  gu: 'Gujarati (ગુજરાતી)',
  ur: 'Urdu (اردو) — RTL',
  vi: 'Vietnamese (Tiếng Việt)',
  th: 'Thai (ไทย)',
  tl: 'Filipino / Tagalog (use natural Tagalog with English code-switching where standard in Philippine fintech UI; "wallet" stays as "wallet"; translate "lend"/"borrow" to "magpautang"/"humiram")',
  id: 'Bahasa Indonesia — formal-but-modern fintech register, "Anda" for second person, accept English fintech loanwords (wallet, token, blockchain) where standard',
  pt: 'Portuguese (Brazilian — "Português (Brasil)") — use "você" not "tu", "registrar" not "registar", "tela" not "ecrã", "aplicativo" or "app" not "aplicação", "celular" not "telemóvel"',
  ru: 'Russian (Русский) — second-person formal "вы"',
  uk: 'Ukrainian (Українська) — second-person "ви"',
  tr: 'Turkish (Türkçe) — second-person informal "sen" (Turkish crypto apps overwhelmingly use sen, not formal siz)',
  it: 'Italian (Italiano) — second-person informal "tu" (fintech apps in Italian use tu by convention, not Lei)',
  nl: 'Dutch (Nederlands) — second-person informal "je/jij" (not "u"); accept English loanwords where standard in fintech',
  pl: 'Polish (Polski) — second-person informal forms typical of fintech apps',
  el: 'Greek (Ελληνικά)',
  cs: 'Czech (Čeština)',
  fa: 'Persian / Farsi (فارسی) — RTL',
  he: 'Hebrew (עברית) — RTL',
  sw: 'Swahili / Kiswahili sanifu (East African register, second-person familiar wewe/-ko-, accept English loanwords like wallet/blockchain where standard; pochi is fine for wallet)',
};
