/**
 * Public-visibility flag for the Protocol Console (#1959).
 *
 * DELIBERATE DUPLICATE, and worth stating why rather than "fixing" it
 * into a shared package. `apps/www` carries a same-named helper for the
 * DOCS route it owns (`vaipakam.com/protocol-console/docs`); this one
 * gates the interactive VALUES surface this app owns. Both read the same
 * env var name, `VITE_ADMIN_DASHBOARD_PUBLIC`, set the same way in each
 * Worker's config, so the dashboard and its docs hide together rather
 * than leaving one half of the pair reachable.
 *
 * The duplication is two lines of logic against a shared contract — the
 * VARIABLE NAME. Extracting it into a package would couple the two apps'
 * build graphs for that, which the #1854 split deliberately separated:
 * `apps/www` cannot import from the connected app and vice versa,
 * precisely so a marketing change cannot regress this one. If a third
 * consumer ever appears, revisit.
 *
 * DEFAULT-ON. A missing or empty value reads as public, so a forgotten
 * env line lands in the transparency posture rather than the opaque one.
 * Only an explicit `false` hides it — and the reading is
 * case-insensitive so `FALSE` behaves as an operator would expect.
 */
export function isProtocolConsolePublic(): boolean {
  try {
    const raw =
      (import.meta.env.VITE_ADMIN_DASHBOARD_PUBLIC as string | undefined) ?? '';
    return raw.toLowerCase() !== 'false';
  } catch {
    // A build or runtime with no `import.meta.env` at all must not make
    // the console disappear — absence of configuration is not a decision
    // to hide it.
    return true;
  }
}
