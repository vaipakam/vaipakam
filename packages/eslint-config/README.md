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
| `apps/defi` | full config reports ~277 errors, almost all `no-explicit-any`, so its lint had never been run — which is how a real hook-order crash reached production | the `no-explicit-any` backlog is cleared |
| `apps/www` | had **no** lint configuration at all; the gap was found when a conditional hook survived in the copy of `LiveValue` that the docs actually render | www gets a full config |
| `apps/alpha` | deployable Worker rendering React, with no config and no CI typecheck; missed by the first sweep, which checked the apps it was working in rather than enumerating `apps/*` | the app gets a full config |
| `apps/alpha01` | **has** a full config, but `typecheck` never ran it, so it was decorative; enabling it wholesale fails on a react-hooks v7 backlog unrelated to hook order | the v7 backlog is cleared |
| `packages/ui` | not deployed itself, but compiled **into** deployed surfaces; per-app guards run from their own directory and do not follow imports across the workspace boundary | the package gets a full config |

`apps/alpha02` is absent on purpose — it runs a full `eslint .` with four
react-hooks rules promoted to error (#1520).

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

`apps/defi` and `apps/alpha01` still list the plugins directly — they also
have a full `eslint.config.js` that imports them. Removing them there would
break that config silently, since nothing runs it today. Drop them only when
that package's full config is what `typecheck` runs.
