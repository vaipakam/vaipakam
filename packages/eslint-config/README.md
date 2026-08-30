# `@vaipakam/eslint-config`

Shared ESLint configuration for the workspace. Currently one export.

## `@vaipakam/eslint-config/hooks`

The narrow `react-hooks/rules-of-hooks` guard (#1601), consolidated here in
#1609 from five near-identical copies.

```js
import hooksGuard from '@vaipakam/eslint-config/hooks'

export default hooksGuard()
// or, where the package keeps Node build scripts beside its React source:
export default hooksGuard({ extraIgnores: ['scripts/**'] })
```

### Who uses it, and what would let them stop

Each consumer keeps its own `eslint.hooks.config.js` whose header records
**why that package has a narrow guard rather than a full config**. Those
reasons genuinely differ, so they are deliberately not centralised — only the
guard body is shared. The table is an index; the headers are the source.

| Package | Why a narrow guard | Deleted when |
| --- | --- | --- |
| `apps/www` | had **no** lint configuration at all; the gap was found when a conditional hook survived in the copy of `LiveValue` that the docs actually render | www gets a full config |
| `packages/ui` | not deployed itself, but compiled **into** deployed surfaces; per-app guards run from their own directory and do not follow imports across the workspace boundary | **RETIRED** — the package was deleted in #1963 once #1854 removed its last consumer, so the guard went with it |

`apps/app` is absent on purpose — it runs a full `eslint .` with four
react-hooks rules promoted to error (#1520).

The table lost three rows in #1854: `apps/defi`, `apps/alpha` and
`apps/alpha01` were deleted when the connected app moved to `apps/app`.
Their narrow guards existed for reasons that died with them — a
`no-explicit-any` backlog nobody was going to clear on a frozen app, and
two prototypes whose lint had never run.

### Two design choices that look like omissions

Both exist so the guard reports **only** hook-order problems. A guard that
reports things it does not care about is one people learn to ignore, which is
how these packages' lint came to go unrun in the first place. Do not "tidy"
either one.

1. `react-refresh` and `@typescript-eslint` are **registered with no rules
   enabled**. Without registration, every existing
   `eslint-disable-next-line @typescript-eslint/no-explicit-any` in the source
   becomes a hard *"Definition for rule ... was not found"* **error**.
2. `reportUnusedDisableDirectives` is **off**. Those same disable comments are
   genuinely unused here — the rules they suppress are not enabled — and
   reporting them would bury the one signal this config exists to surface.

### Verifying a change — by mutation, never by a green run

A consolidation that silently stopped linting a package looks exactly like
success. So prove each consumer still lints by making it fail:

```bash
# For each consumer package:
cat > <pkg>/src/__mutant_check.tsx <<'EOF'
import { useState } from 'react'
export function Mutant({ on }: { on: boolean }) {
  if (on) {
    const [x] = useState(0)
    return <span>{x}</span>
  }
  return null
}
EOF
(cd <pkg> && pnpm exec eslint . -c eslint.hooks.config.js)   # must FAIL, naming rules-of-hooks
rm <pkg>/src/__mutant_check.tsx
```

All five were verified this way when #1609 landed. A non-zero exit is not
enough on its own — check the output actually names `rules-of-hooks`, since
a config that fails to load also exits non-zero.

### Dependencies

The three plugin packages are dependencies of *this* package, so consumers do
not each carry them. `eslint` itself stays a devDependency of every consumer,
because each runs the binary from its own directory.

`apps/app` still lists the plugins directly — it also has a full
`eslint.config.js` that imports them, and that config IS what its
`typecheck` runs, so the direct listing is load-bearing rather than
vestigial.
