# Live post-deploy drives

Committed drives that exercise **deployed** sites. They run after a
production deploy, per the live-review definition-of-done — not against a
preview build, and not as part of CI.

They live under `apps/www` because that is where the browser tooling and the
container setup below already are, but they are not all about the marketing
site. Two kinds sit here:

- **Marketing-site drives** — the rendered docs on `vaipakam.com`.
- **Connected-app drives** — the wallet-connecting app. `app` is the
  surface being promoted, so it is the target that matters; the drives take
  origins positionally and can still be pointed at a sibling app when there is
  a reason to. `app` has `@playwright/test` for its own `e2e` suite, so an
  app-only drive could live there instead; these sit here because they can
  be aimed at any origin and share the container setup below.

The table further down says which is which, and how each takes its target.

## Why these are not CI specs

The reason differs by drive, and it is worth knowing which one applies before
trusting a result.

A marketing-site drive checks something only true once the deployed page has
fetched the published protocol-config snapshot from the deployed indexer: a
preview build, a prebuild guard, or an inspection of the shipped bundle can all
pass while the rendered page shows something else.

A connected-app drive checks behaviour of third-party SDKs as they actually run
in a browser against the deployed bundle — whether a wallet kit phones home, for
instance. A type-check proves an option was accepted, not that the traffic
stopped.

Both gaps close only with a real browser pointed at the real origin.

The `apps/www` prebuild guards (`check:livevalue`, `check:knobs`, and
the rest of `pnpm --filter @vaipakam/www typecheck`) cover the
build-time half and stay the first line of defence. These drives cover
what those structurally cannot see.

## Running one

```bash
pnpm --filter @vaipakam/www exec node e2e/live/live-worked-example.mjs
```

Not every drive takes its target the same way, so check the table below
before substituting a filename into that command. Single-origin drives use
`WWW_ORIGIN`; `live-wallet-telemetry.mjs` takes one or more origins as
positional arguments instead, because it checks several apps in one run and
a single environment variable cannot express that:

```bash
# Pass the app deployment to check. `app.vaipakam.com` is the intended
# host but is not bound yet (#1854) — use the workers.dev URL the app's
# `pnpm run deploy` prints until it is.
node apps/www/e2e/live/live-wallet-telemetry.mjs <deployed-app-origin>/
```

It exits with a usage message if given no origins, rather than silently
checking a default.

Override a single-origin drive's target with `WWW_ORIGIN` (defaults to
`https://vaipakam.com`):

```bash
WWW_ORIGIN=https://preview.example.com node apps/www/e2e/live/live-worked-example.mjs
```

Each drive prints a `PASS` / `FAIL` / `SKIP` line per check and exits
non-zero if anything failed, so it can gate a release step.

`SKIP` is used deliberately where a check is only meaningful under
known configuration — a value assertion pinned to the shipped default
fee rates is skipped, not failed, after a governance retune, and the
live rates are printed so the skip is legible rather than silent.

## Running from the agent container (#1777)

The Claude Code remote container CAN run these, after two host-side
preparations plus two environment variables. Without the preparations
every navigation dies with `ERR_CONNECTION_RESET` while `curl` to the
same URL succeeds — the diagnosis behind that is on #1777, and it is
worth knowing because the visible error points away from both causes:

1. **The egress TLS terminator resets any ClientHello carrying the
   Encrypted ClientHello (ECH) GREASE extension**, which Chromium sends
   by default and `curl` does not. Turn it off via the enterprise
   policy (the matching `--disable-features` names are silently
   ignored by current builds):

   ```bash
   sudo mkdir -p /etc/chromium/policies/managed
   echo '{"PostQuantumKeyAgreementEnabled": false, "EncryptedClientHelloEnabled": false}' \
     | sudo tee /etc/chromium/policies/managed/agent-proxy-compat.json
   ```

   (ECH is the one that matters; the post-quantum key share is disabled
   alongside it because it triples the ClientHello size for a
   terminator already shown to be picky.)

2. **Chromium must trust the proxy's re-terminating CA** via the NSS
   user store — the container's `~/.pki/nssdb` exists but does not
   contain it. `certutil` is not installed and `apt-get install` is not
   available, so fetch `libnss3-tools` as a `.deb` (the Ubuntu archive
   is reachable through the proxy) and run the extracted binary by
   path — `dpkg -x` does not put it on `PATH`:

   ```bash
   cd /tmp
   # Pick the current noble version from the pool listing — exact
   # filenames rotate as the package is updated:
   curl -sS https://archive.ubuntu.com/ubuntu/pool/main/n/nss/ \
     | grep -o 'libnss3-tools[^"]*amd64\.deb' | sort -u
   curl -sSLO https://archive.ubuntu.com/ubuntu/pool/main/n/nss/<picked-filename>
   dpkg -x <picked-filename> nsstools
   ./nsstools/usr/bin/certutil -A -d sql:$HOME/.pki/nssdb \
     -n "CCR Agent Proxy CA" -t "C,," -i /root/.ccr/agent-proxy-ca.crt
   # Confirm it landed:
   ./nsstools/usr/bin/certutil -L -d sql:$HOME/.pki/nssdb
   ```

Then run with the two launch overrides the drives honour:

```bash
PW_CHROMIUM_EXE=/opt/pw-browsers/chromium PW_PROXY="$HTTPS_PROXY" \
  node apps/www/e2e/live/live-worked-example.mjs
```

`PW_CHROMIUM_EXE` covers the container's browser install not matching
the repo's pinned Playwright version; `PW_PROXY` covers Chromium not
reading `HTTPS_PROXY` on its own. An operator machine with a matching
browser and direct egress sets neither and runs exactly as before.

The policies file and the NSS import are container-lifetime — a fresh
container needs them again. Never substitute `ignoreHTTPSErrors` or a
certificate-error bypass for step 2; the drive is watching a production
surface and must not be taught to accept an unverified one.

## The drives

| File | Covers | Introduced by |
| --- | --- | --- |
| `live-worked-example.mjs` | The Overview's worked-example figures render as derived live values with the contract's integer arithmetic and honest provenance; the help search finds a page by a figure printed on it | #1751 (#1664 items 1 + 2) |
| `live-wallet-telemetry.mjs` | A connected-app origin constructs the Coinbase SDK and sends nothing to its telemetry host on load, AND the deployed bundle carries both telemetry-off settings (#1840). Takes origins as POSITIONAL arguments; `app` is the promoted target. Fails closed unless the SDK is witnessed as constructed | #1836 (#1824), #1840 |

The second one lives here rather than under the app it checks because it takes
any origin positionally rather than belonging to one app, and because this is
where the browser tooling and the container setup above already are.

It reports two INDEPENDENT kinds of evidence, and the distinction is the point:
observed traffic (behaviour) and a bundle assertion (configuration). The second
exists because traffic cannot answer for WalletConnect — its provider is not
constructed at load, so its setting could regress and every observation would
still look clean. Configuration evidence proves the option shipped, not that
the vendor honours it, so neither kind is reported as the other.

## Adding one

Keep them dependency-free beyond `playwright`, parameterised by
`WWW_ORIGIN` (or by positional origins where a drive spans several
apps — say which in the table), and self-describing on stdout — someone reading the
output during a release should be able to tell what was checked without
opening the file. Query with what the page actually rendered rather
than a hardcoded expectation wherever the invariant is "these two
agree", so the drive keeps testing the invariant after a retune instead
of testing a snapshot of one moment's configuration.

Add a row to the table above in the same change.
