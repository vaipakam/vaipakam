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

/** Locales that the LanguagePicker advertises and that ship
 *  translation bundles. Adding a new entry here also requires
 *  authoring the matching `locales/<code>.json` (or running
 *  `npm run translate` to generate it via the Claude API). */
export const SUPPORTED_LOCALES = [
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
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type LocaleCode = SupportedLocale;
