## Thread — alpha02: hardcoded-string detector now scans `.ts` helpers (#1398)

The AST hardcoded-string guardrail (#1365) only walked `.tsx` files, so a
hardcoded fallback string passed into a `copy.*` template from a plain
`.ts` helper could ship untranslated without tripping CI. The detector now
also scans `.ts` files, in a scoped mode: because `.ts` has no JSX and is
full of catalog / config / label-map objects, only the `copy.*`
call-argument check runs there (the JSX and object-key checks stay
`.tsx`-only), and the catalog source, declaration files, and tests are
skipped. This keeps the `.ts` scan focused on the one real class — a
hardcoded English literal filled into a translated message — without
flagging the ordinary data objects that fill helper files.

Turning it on surfaced exactly one pre-existing occurrence (the
"the required asset" symbol fallback in `contracts/preflights.ts`, which
feeds the "you need more" balance error when a token's symbol can't be
read). It is grandfathered in the detector baseline and tracked for
extraction with the rest of the fallback-label work; the point of this
change is that the ratchet now *sees* the `.ts` copy-arg surface, so a new
hardcoded fallback there fails CI instead of shipping silently. Scope is
limited to `apps/alpha02`.
