## Thread — security headers: alpha02 gains its set; defi + www's broken sets repaired

The retail app now ships browser security headers: a Content-Security
Policy (self-only scripts — the app loads no analytics and no external
fonts, so its policy is tighter than the pro app's), clickjacking
protection that still allows embedding inside the Safe multisig
dapp-browser, MIME-sniffing and referrer hardening, and deploy-cache
rules — the app shell revalidates on every load so a redeploy can
never leave a wallet-connected client running stale code against
changed contract artifacts, while the content-hashed bundles stay
long-cached.

Porting the pro app's header file surfaced a real production bug: the
file in both apps/defi and apps/www had been markdown-mangled at some
point — the catch-all path rule read `/_` instead of `/*`, so the
ENTIRE security-header block (CSP, nosniff, referrer policy,
clickjacking rules) applied to no path at all, and the immutable-cache
rule for hashed assets was similarly dead. Verified live before the
fix: defi.vaipakam.com served no CSP and no nosniff header (only the
intact entry-point revalidation rule worked). Both files are repaired
— the same protections those apps always intended are now actually
served, including the Safe-subdomain frame allowlist which had also
degraded into a literal underscore hostname.
