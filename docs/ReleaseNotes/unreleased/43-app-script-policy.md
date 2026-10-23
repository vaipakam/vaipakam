## Thread — The connected app refuses inline and evaluated script (PR #<n>)

The connected app's content security policy used to allow any inline script and the evaluation of text as code. Both settings were copied from the retired app on a note about wallet software needing them, and nobody had checked that note. Together they meant that a script injected into the page would have run with the app's full authority, which includes building the transactions a wallet is asked to sign.

Both allowances are gone. The policy now allows script from the app's own address, plus three small boot scripts that must run before anything else loads (theme, language and direction, and the start-up failure notice). Each boot script is allowed by a fingerprint of its exact content. The build computes those fingerprints from the page it has just produced, so the policy always matches what ships, and the build fails rather than ship an incomplete policy.

Before the change we measured the effect. No part of the app's code evaluates text as code. A local copy served by the same static-asset server the app runs on, under the new policy, loaded seventeen pages and the wallet picker with no refusals. That included the Coinbase Wallet and WalletConnect flows. A deliberately broken policy was refused as expected, which confirms the check can catch a refusal.

Inline styles are still allowed, because the interface sets them per element and they cannot run code. The marketing site's policy is handled separately. Part of #43.
